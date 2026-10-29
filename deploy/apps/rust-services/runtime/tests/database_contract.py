"""Dock database contracts against isolated, disposable PostgreSQL and nginx fixtures.

Run on a Docker host after building the candidate image:
  APPS_RUST_TEST_IMAGE=apps-rust:local python3 tests/database_contract.py
No production service, database, volume, or network is contacted.
"""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from urllib.parse import urlencode
import uuid

from http_contract import HOSTS, request, value

ROOT = Path(__file__).resolve().parents[4]
NGINX = os.environ.get(
    "DATABASE_TEST_NGINX_IMAGE",
    "nginx:1.30.6-alpine3.24-slim@sha256:d9322bba63c6cfc63dc9e86522fd4f95fd4d9020a02b5bced282bbf38b8c3960",
)
POSTGRES = os.environ.get("DATABASE_TEST_POSTGRES_IMAGE", "postgres:17.11-alpine3.24")
IMAGE = os.environ.get("APPS_RUST_TEST_IMAGE", "apps-rust:local")


def docker(*args, data=None):
    return subprocess.check_output(["docker", *args], input=data, stderr=subprocess.STDOUT)


def wait_for(predicate, description):
    for _ in range(150):
        try:
            if predicate():
                return
        except (OSError, subprocess.CalledProcessError):
            pass
        time.sleep(0.1)
    raise AssertionError(f"timed out waiting for {description}")


def container_ip(name, network):
    details = json.loads(docker("inspect", name))[0]
    return details["NetworkSettings"]["Networks"][network]["IPAddress"]


def setup_postgres(name):
    # The image briefly accepts local connections during first-time initialization,
    # then stops that temporary server before starting its normal listener.
    wait_for(
        lambda: b"PostgreSQL init process complete; ready for start up" in docker("logs", name),
        "PostgreSQL initialization to finish",
    )
    wait_for(
        lambda: subprocess.run(
            ["docker", "exec", name, "pg_isready", "-U", "postgres"],
            capture_output=True,
            check=False,
        ).returncode == 0,
        "disposable PostgreSQL",
    )
    wait_for(
        lambda: subprocess.run(
            ["docker", "exec", name, "createdb", "-U", "postgres", "expenses"],
            capture_output=True,
            check=False,
        ).returncode == 0,
        "disposable expenses database",
    )
    fixture = """
CREATE TABLE items (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  amount numeric NOT NULL,
  token text DEFAULT 'fixture-hidden-secret',
  opaque text DEFAULT 'fixture-hidden-opaque',
  payload jsonb DEFAULT '{"secret":"fixture-hidden-json"}'::jsonb
);
INSERT INTO items(name,amount) VALUES ('Alpha',1), ('Beta',2), ('Gamma',3);
CREATE TABLE sessions (id integer PRIMARY KEY, name text, token text);
INSERT INTO sessions VALUES (1,'must-not-appear','fixture-session-token');
CREATE TABLE no_policy (id integer PRIMARY KEY, name text);
INSERT INTO no_policy VALUES (1,'fixture-unreviewed');
CREATE TABLE pair (first_key text NOT NULL, second_key text NOT NULL, value text,
                   PRIMARY KEY (first_key,second_key));
INSERT INTO pair VALUES ('one','two','original');
-- The same key and transaction ID on different relations must not make an
-- old edit valid after one relation is swapped for the other.
BEGIN;
CREATE TABLE swap_target (id integer PRIMARY KEY, value text);
CREATE TABLE swap_alternate (id integer PRIMARY KEY, value text);
INSERT INTO swap_target VALUES (1, 'original relation');
INSERT INTO swap_alternate VALUES (1, 'replacement relation');
COMMIT;
-- A custom type may have the same name as a built-in while containing secret bytes.
CREATE DOMAIN public.text AS pg_catalog.bytea;
CREATE TABLE type_collision (id integer PRIMARY KEY, value public.text);
INSERT INTO type_collision VALUES (1, pg_catalog.convert_to('fixture-hidden-domain', 'UTF8'));
"""
    docker("exec", "-i", name, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "expenses", data=fixture.encode())


class DatabaseContract(unittest.TestCase):
    def test_database_policy_crud_audit_and_proxy_auth(self):
        prefix = "database-contract-" + uuid.uuid4().hex[:12]
        api_net, pg_net = prefix + "-api", prefix + "-pg"
        db, app, auth, dock = [prefix + suffix for suffix in ("-pg", "-app", "-auth", "-dock")]
        port, dock_port = 8802, 80
        with tempfile.TemporaryDirectory(prefix="database-contract-") as temp:
            root = Path(temp)
            root.chmod(0o755)
            audit = root / "audit"
            audit.mkdir(mode=0o777)
            audit.chmod(0o777)  # fixture only; scratch image runs as uid 1000
            policy = root / "policy.json"
            policy.write_text(json.dumps({"expenses": {"public": {
                "items": ["id", "name", "amount", "token", "payload"],
                "sessions": ["id", "name", "token"],
                "pair": ["first_key", "second_key", "value"],
                "type_collision": ["id", "value"],
                "swap_target": ["id", "value"],
            }}}))
            policy.chmod(0o644)
            auth_conf = root / "auth.conf"
            auth_conf.write_text('''server {
  listen 9000;
  location = /api/users/me {
    if ($http_authorization != "Bearer fixture-token") { return 401; }
    return 200;
  }
}\n''')
            auth_conf.chmod(0o644)
            try:
                for network in [api_net, pg_net]:
                    docker("network", "create", "--internal", network)
                docker("run", "-d", "--name", db, "--network", pg_net,
                       "--network-alias", "fixture-db", "--tmpfs", "/var/lib/postgresql/data",
                       "-e", "POSTGRES_PASSWORD=fixture-password", POSTGRES)
                setup_postgres(db)
                docker("run", "-d", "--name", app, "--network", pg_net,
                       "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
                       "-v", f"{policy}:/config/policy.json:ro", "-v", f"{audit}:/data",
                       "-e", "POSTGRES_HOST=fixture-db", "-e", "POSTGRES_USER=postgres",
                       "-e", "POSTGRES_PASSWORD=fixture-password", IMAGE, "database")
                docker("network", "connect", "--alias", "apps-database", api_net, app)
                HOSTS[port] = container_ip(app, pg_net)
                wait_for(lambda: request(port, "/health")[0] == 200, "database API")
                docker("run", "-d", "--name", auth, "--network", api_net,
                       "--network-alias", "portainer", "-v", f"{auth_conf}:/etc/nginx/conf.d/default.conf:ro", NGINX)
                # Production config, but fake Portainer and fixture manager, with no public ports.
                dock_conf = Path(os.environ.get("DATABASE_TEST_NGINX_CONF", str(ROOT / "dock" / "nginx.conf"))).resolve()
                docker("run", "-d", "--name", dock, "--network", api_net,
                       "-v", f"{dock_conf}:/etc/nginx/conf.d/default.conf:ro", NGINX)
                HOSTS[dock_port] = container_ip(dock, api_net)
                wait_for(lambda: request(dock_port, "/api/database/databases")[0] == 401, "Dock authorization")
                self.assertEqual(request(dock_port, "/api/database/databases", headers={"Authorization": "Bearer invalid"})[0], 401)
                self.assertEqual(request(dock_port, "/api/database/rows", method="POST", body={})[0], 401)
                auth_header = {"Authorization": "Bearer fixture-token"}
                response = request(dock_port, "/api/database/databases", headers=auth_header)
                self.assertEqual(response[0], 200, response[2])
                self.assertEqual({k.lower(): v for k, v in response[1].items()}.get("cache-control"), "no-store")
                self.assertIn("expenses", [db["name"] for db in value(response)["databases"]])
                response = request(dock_port, "/api/database/tables?database=expenses", headers=auth_header)
                self.assertEqual(response[0], 200, response[2])
                listed = {t["name"] for t in value(response)["tables"]}
                self.assertTrue({"items", "pair", "sessions", "no_policy"} <= listed)

                base = {"database": "expenses", "schema": "public", "table": "items"}
                def rows(**params):
                    return request(dock_port, "/api/database/rows?" + urlencode({**base, **params}), headers=auth_header)
                def mutate(**params):
                    return request(dock_port, "/api/database/rows", method="POST", body={**base, **params}, headers=auth_header)
                def sql(statement, **options):
                    return request(dock_port, "/api/database/sql", method="POST",
                                   body={"database": "expenses", "sql": statement, **options}, headers=auth_header)

                response = rows(sort="amount", direction="desc", limit=2)
                self.assertEqual(response[0], 200, response[2])
                page = value(response)
                self.assertEqual(page["total"], 3)
                self.assertEqual([r["values"]["name"] for r in page["rows"]], ["Gamma", "Beta"])
                self.assertTrue(page["editable"])
                serialized = json.dumps(page)
                for secret in ["fixture-hidden-secret", "fixture-hidden-opaque", "fixture-hidden-json"]:
                    self.assertNotIn(secret, serialized)
                hidden = {c["name"] for c in page["columns"] if c["secret"]}
                self.assertTrue({"token", "opaque", "payload"} <= hidden)
                self.assertEqual(value(rows(search="fixture-hidden-secret"))["total"], 0)
                self.assertEqual(rows(sort="token")[0], 400)
                self.assertEqual(rows(table='items"; DROP TABLE items;--')[0], 404)
                sql_response = sql("SELECT * FROM public.items ORDER BY amount DESC LIMIT 2")
                self.assertEqual(sql_response[0], 200, sql_response[2])
                self.assertEqual([r["values"]["name"] for r in value(sql_response)["rows"]], ["Gamma", "Beta"])
                self.assertNotIn("fixture-hidden-secret", json.dumps(value(sql_response)))
                for statement in [
                    "SELECT token FROM items", "SELECT * FROM items; SELECT * FROM sessions",
                    "SELECT * FROM items -- comment", "SELECT * FROM items /* comment */",
                    "SELECT * FROM items JOIN sessions ON true", "SELECT pg_read_file('/etc/passwd') FROM items",
                    "DELETE FROM items", "DELETE FROM items WHERE id=1 OR true",
                    "INSERT INTO items (name) VALUES ('x'),('y')",
                ]:
                    self.assertEqual(sql(statement, write=True, confirm=True)[0], 400, statement)
                self.assertEqual(sql("SELECT * FROM items ORDER BY token")[0], 400)
                for response in [rows(table="type_collision"), sql("SELECT * FROM type_collision")]:
                    self.assertEqual(response[0], 200, response[2])
                    collision = value(response)
                    self.assertTrue(next(c for c in collision["columns"] if c["name"] == "value")["secret"])
                    self.assertNotIn("value", collision["rows"][0]["values"])

                old = value(rows(table="swap_target"))["rows"][0]
                docker("exec", "-i", db, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "expenses", data=b"BEGIN; ALTER TABLE swap_target RENAME TO swap_old; ALTER TABLE swap_alternate RENAME TO swap_target; COMMIT;")
                replacement = value(rows(table="swap_target"))["rows"][0]
                self.assertEqual(old["key"], replacement["key"])
                self.assertEqual(old["version"].split(":")[-1], replacement["version"].split(":")[-1])
                self.assertNotEqual(old["version"], replacement["version"])
                result = mutate(table="swap_target", action="update", key=old["key"], version=old["version"], values={"value": "must not be written"}, confirm=True)
                self.assertEqual(result[0], 409, result[2])
                self.assertEqual(value(rows(table="swap_target"))["rows"][0]["values"]["value"], "replacement relation")

                # Concurrent DDL takes an exclusive relation lock. Browse must fail
                # within its lock timeout and recover once the lock is released.
                locker = subprocess.Popen(
                    ["docker", "exec", "-i", db, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "expenses"],
                    stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                )
                try:
                    locker.stdin.write(b"BEGIN; LOCK TABLE public.items IN ACCESS EXCLUSIVE MODE;\n")
                    locker.stdin.flush()
                    def lock_held():
                        check = docker("exec", db, "psql", "-U", "postgres", "-d", "expenses", "-Atc", "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_locks WHERE relation=(SELECT oid FROM pg_catalog.pg_class WHERE relname='items' AND relnamespace='public'::pg_catalog.regnamespace) AND mode='AccessExclusiveLock' AND granted)")
                        return check.strip() == b"t"
                    wait_for(lock_held, "exclusive fixture table lock")
                    self.assertIn(rows()[0], (404, 503))
                finally:
                    if locker.poll() is None:
                        locker.stdin.write(b"ROLLBACK;\n\\q\n")
                        locker.stdin.flush()
                        try:
                            locker.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            locker.kill()
                            locker.wait(timeout=5)
                    locker.stdin.close()
                self.assertEqual(rows()[0], 200)

                missing_policy = value(rows(table="no_policy"))
                self.assertNotIn("fixture-unreviewed", json.dumps(missing_policy))
                protected_table = value(rows(table="sessions"))
                self.assertNotIn("must-not-appear", json.dumps(protected_table))
                self.assertNotIn("fixture-session-token", json.dumps(protected_table))
                self.assertIn(mutate(action="insert", values={"name": "Unconfirmed", "amount": "9"}, confirm=False)[0], (400, 403))
                self.assertIn(mutate(action="insert", values={"name": "Forbidden", "amount": "9", "token": "evil"}, confirm=True)[0], (400, 403))
                self.assertEqual(value(rows())["total"], 3)

                # SQL-shaped writes use the same authorization, policy, version checks, and audit.
                insert_sql = "INSERT INTO items (name, amount) VALUES ('SQL fixture', 8)"
                self.assertIn(sql(insert_sql)[0], (400, 403))
                self.assertIn(sql(insert_sql, write=True)[0], (400, 403))
                self.assertIn(sql("INSERT INTO items (name, amount, token) VALUES ('bad', 9, 'bypass')", write=True, confirm=True)[0], (400, 403))
                self.assertIn(sql("UPDATE pair SET value='wrong' WHERE first_key='one'", write=True, confirm=True)[0], (400, 403))
                self.assertEqual(sql(insert_sql, write=True, confirm=True)[0], 200)
                sql_row = value(rows(search="SQL fixture"))["rows"][0]
                sql_id = int(sql_row["key"]["id"])
                self.assertEqual(sql(f"UPDATE items SET name='SQL changed' WHERE id={sql_id}", write=True, confirm=True)[0], 200)
                self.assertEqual(value(rows(search="SQL changed"))["total"], 1)
                self.assertEqual(sql(f"DELETE FROM items WHERE id={sql_id}", write=True, confirm=True)[0], 200)
                self.assertEqual(value(rows())["total"], 3)

                # Loss of the audit store must prevent the mutation, not silently lose its record.
                audit_file = audit / "audit.sqlite"
                audit_file.chmod(0o444)
                audit.chmod(0o555)
                try:
                    self.assertEqual(mutate(action="insert", values={"name": "No audit", "amount": "9"}, confirm=True)[0], 503)
                finally:
                    audit.chmod(0o777)
                    audit_file.chmod(0o666)
                self.assertEqual(value(rows())["total"], 3)

                response = mutate(action="insert", values={"name": "Delta", "amount": "4"}, confirm=True)
                self.assertIn(response[0], (200, 201), response[2])
                row = value(rows(search="Delta"))["rows"][0]
                response = mutate(action="update", key=row["key"], version=row["version"], values={"name": "Changed"}, confirm=True)
                self.assertEqual(response[0], 200, response[2])
                stale = mutate(action="delete", key=row["key"], version=row["version"], confirm=True)
                self.assertEqual(stale[0], 409, stale[2])
                row = value(rows(search="Changed"))["rows"][0]
                self.assertEqual(mutate(action="delete", key=row["key"], version=row["version"], confirm=True)[0], 200)
                self.assertEqual(value(rows())["total"], 3)

                pair = value(rows(table="pair"))["rows"][0]
                self.assertEqual(mutate(table="pair", action="update", key=pair["key"], version=pair["version"], values={"value": "updated"}, confirm=True)[0], 200)
                self.assertEqual(value(rows(table="pair"))["rows"][0]["values"]["value"], "updated")
                audit_response = request(dock_port, "/api/database/audit", headers=auth_header)
                self.assertEqual(audit_response[0], 200, audit_response[2])
                entries = value(audit_response)["entries"]
                self.assertTrue({"insert", "update", "delete"} <= {e["action"] for e in entries})
                for fixture in ["fixture-hidden-secret", "fixture-hidden-opaque", "fixture-hidden-json", "Delta", "Changed"]:
                    self.assertNotIn(fixture, json.dumps(entries))

                # Application containers cannot see the management ingress network, and Dock cannot see Postgres.
                networks = json.loads(docker("inspect", app))[0]["NetworkSettings"]["Networks"]
                self.assertEqual(set(networks), {api_net, pg_net})
                self.assertEqual(set(json.loads(docker("inspect", db))[0]["NetworkSettings"]["Networks"]), {pg_net})
                self.assertEqual(set(json.loads(docker("inspect", dock))[0]["NetworkSettings"]["Networks"]), {api_net})
            finally:
                HOSTS.pop(port, None)
                HOSTS.pop(dock_port, None)
                for name in [dock, auth, app, db]:
                    subprocess.run(["docker", "rm", "-f", name], capture_output=True, check=False)
                for network in [api_net, pg_net]:
                    subprocess.run(["docker", "network", "rm", network], capture_output=True, check=False)


if __name__ == "__main__":
    unittest.main()
