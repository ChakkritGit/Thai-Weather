"""Search SQL against disposable Postgres; never connects to an owner's database."""

import json
import os
import subprocess
import time
import unittest
import uuid

from http_contract import HOSTS, request, value


def docker(*args, data=None):
    return subprocess.check_output(
        ["docker", *args], input=data, stderr=subprocess.STDOUT
    )


class Portfolio(unittest.TestCase):
    def test_published_translations_order_readonly_and_failure(self):
        prefix = "portfolio-contract-" + uuid.uuid4().hex[:12]
        network, db, app = prefix + "-net", prefix + "-db", prefix + "-app"
        port = 8800
        try:
            docker("network", "create", "--internal", network)
            docker(
                "run",
                "-d",
                "--name",
                db,
                "--network",
                network,
                "--network-alias",
                "fixture-db",
                "--tmpfs",
                "/var/lib/postgresql/data",
                "-e",
                "POSTGRES_PASSWORD=fixture-password",
                os.environ.get("PORTFOLIO_TEST_PG_IMAGE", "postgres:17.11-alpine3.24"),
            )
            for _ in range(100):
                if (
                    subprocess.run(
                        ["docker", "exec", db, "pg_isready", "-U", "postgres"],
                        capture_output=True,
                        check=False,
                    ).returncode
                    == 0
                ):
                    break
                time.sleep(0.1)
            else:
                self.fail("disposable Postgres did not become ready")
            # Views expose fixture rows only when the caller enabled read-only sessions.
            # This checks the native connection setting as well as real SQL syntax/types.
            sql = """
CREATE ROLE fixture_reader LOGIN PASSWORD 'fixture-password';
CREATE TABLE "PostFixture" (
 id text, slug text, locale text, "translationKey" text, title text, summary text,
 tags text[], status text, "publishedAt" timestamp(3), "updatedAt" timestamp(3)
);
CREATE TABLE "ProjectFixture" (LIKE "PostFixture", stack text[], "sortOrder" integer);
INSERT INTO "PostFixture" VALUES
 ('th','thai','th','paired','Thai',NULL,'{rust}', 'PUBLISHED','2026-10-01','2026-10-01'),
 ('en','english','en','paired','English','Summary','{next,rust}', 'PUBLISHED','2026-10-03','2026-10-03'),
 ('solo','solo','th',NULL,'Solo',NULL,'{}', 'PUBLISHED',NULL,'2026-10-02'),
 ('draft','draft','th',NULL,'Never expose',NULL,'{}', 'DRAFT','2026-10-10','2026-10-10');
INSERT INTO "ProjectFixture" VALUES
 ('p2','second','ja',NULL,'Second',NULL,'{}','PUBLISHED','2026-10-04','2026-10-04','{Rust}',2),
 ('p1','first','en',NULL,'First',NULL,'{api}','PUBLISHED','2026-10-01','2026-10-01','{Next,Rust}',1);
CREATE VIEW "Post" AS SELECT * FROM "PostFixture"
 WHERE current_setting('default_transaction_read_only') = 'on';
CREATE VIEW "Project" AS SELECT * FROM "ProjectFixture"
 WHERE current_setting('default_transaction_read_only') = 'on';
GRANT SELECT ON "Post", "Project" TO fixture_reader;
"""
            docker(
                "exec",
                "-i",
                db,
                "psql",
                "-v",
                "ON_ERROR_STOP=1",
                "-U",
                "postgres",
                data=sql.encode(),
            )
            dsn = "postgresql://fixture_reader:fixture-password@fixture-db:5432/postgres?schema=public&connection_limit=2&pool_timeout=5"
            docker(
                "run",
                "-d",
                "--name",
                app,
                "--network",
                network,
                "--read-only",
                "--cap-drop=ALL",
                "--security-opt=no-new-privileges:true",
                "-e",
                "DATABASE_URL=" + dsn,
                os.environ.get("APPS_RUST_TEST_IMAGE", "apps-rust:local"),
                "portfolio-api",
            )
            info = json.loads(docker("inspect", app))[0]
            HOSTS[port] = info["NetworkSettings"]["Networks"][network]["IPAddress"]
            for _ in range(100):
                try:
                    if request(port, "/health")[0] == 200:
                        break
                except OSError:
                    time.sleep(0.05)
            health = request(port, "/api/health")
            self.assertEqual(health[0], 200)
            self.assertEqual(value(health)["db"]["ok"], True)
            for locale, titles in [
                ("th", ["Solo", "Thai", "First", "Second"]),
                ("en", ["English", "Solo", "First", "Second"]),
                ("ja", ["English", "Solo", "First", "Second"]),
                ("bad", ["Solo", "Thai", "First", "Second"]),
                ("en&locale=th", ["English", "Solo", "First", "Second"]),
            ]:
                response = request(port, "/api/search?locale=" + locale)
                self.assertEqual(response[0], 200, response[2])
                rows = value(response)
                self.assertEqual([row["title"] for row in rows], titles)
                self.assertTrue(
                    all("id" not in row and "locale" not in row for row in rows)
                )
                self.assertEqual(rows[2]["stack"], ["Next", "Rust"])
                self.assertEqual(rows[2]["href"], "/projects/first")
                self.assertEqual(rows[2]["publishedAt"], "2026-10-01T00:00:00.000Z")
                self.assertEqual(
                    response[1]["cache-control"],
                    "public, s-maxage=60, stale-while-revalidate=300",
                )
            head = request(port, "/api/search?locale=en", method="HEAD")
            self.assertEqual((head[0], head[2]), (200, b""))
            docker("stop", "-t", "2", db)
            self.assertEqual(request(port, "/api/health")[0], 503)
            self.assertEqual(value(request(port, "/api/search")), [])
        finally:
            HOSTS.pop(port, None)
            for name in [app, db]:
                subprocess.run(
                    ["docker", "rm", "-f", name], capture_output=True, check=False
                )
            subprocess.run(
                ["docker", "network", "rm", network], capture_output=True, check=False
            )


if __name__ == "__main__":
    unittest.main()
