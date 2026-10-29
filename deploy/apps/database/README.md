# Dock database manager

The database manager runs as `apps-database` on two private, internal networks:
`dock-database` (Dock to manager) and `database-postgres` (manager to PostgreSQL).
It must not join `apps-internal`, `proxy`, or `dock-internal`: it trusts Dock to
authenticate requests with Portainer. No public port is published. Dock strips the
Portainer bearer token before proxying the authenticated request.

`policy.json` is an explicit disclosure and editing allowlist, reviewed against
the production schema. Values in unknown columns and tables, sensitive names, binary/JSON
fields, domains and unreviewed types are hidden; hidden values cannot be searched or
sorted. Update the policy after reviewing a schema change. This policy does not
recognize a secret that was put into an otherwise approved free-text field. It deliberately
hides some ordinary content too, including JSON articles, because opaque data can
contain credentials. Do not add credentials or actual application data to it.

The SQL screen understands a deliberately small subset: `SELECT * FROM table`,
optionally with `ORDER BY` and `LIMIT`, plus single-row `INSERT`, `UPDATE` and
`DELETE` with literal values and complete primary-key predicates. It parses and
translates these into the same guarded operations as the table interface; it does
not execute arbitrary SQL. Writes require explicit enablement and confirmation,
and an audit entry is written before PostgreSQL is changed. The persistent audit
volume stores operation and column names, timestamps and outcomes, not values.
The existing encrypted server backup includes this volume.

## Provisioning and rotation

On the VPS, `sh deploy/apps/database/setup.sh` copies only the PostgreSQL password
from the existing private `db.env` to `/opt/apps/env/database.env` with mode 0600.
Run this again and recreate `database` when that password changes. The restore
script refreshes it from the restored `db.env`. Create the two private networks
with `docker network create --internal dock-database` and `docker network create
--internal database-postgres` if absent. Both Compose files declare them external.
The production PostgreSQL container can be attached to `database-postgres` online,
without recreating it; Dock can similarly be attached to `dock-database` before its
configuration is reloaded. Compose retains both attachments on later recreation.

Run `python3 tests/database_contract.py` from `deploy/apps/rust-services/runtime`
on a Docker host after building the candidate image. The test uses disposable
PostgreSQL, nginx, Portainer-auth fixtures and isolated networks; it does not
contact the real database or send notifications.
