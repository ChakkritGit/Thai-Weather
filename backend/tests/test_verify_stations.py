import httpx

from verify import db, stations

GEOJSON = {
    "features": [
        {
            "properties": {"sid": "VTBS", "sname": "BANGKOK", "elevation": 3},
            "geometry": {"coordinates": [100.75, 13.68]},
        },
        {
            "properties": {"sid": "VTCC", "sname": "CHIANG MAI", "elevation": 312},
            "geometry": {"coordinates": [98.96, 18.77]},
        },
        {
            "properties": {"sid": "WSSS", "sname": "SINGAPORE", "elevation": 7},
            "geometry": {"coordinates": [103.99, 1.36]},
        },
    ]
}


def _client(calls: list[int]) -> httpx.Client:
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        assert str(request.url) == stations.IEM_STATIONS_URL
        return httpx.Response(200, json=GEOJSON)

    return httpx.Client(transport=httpx.MockTransport(handler))


def test_ensure_stores_in_domain_stations_and_caches(tmp_path):
    conn = db.connect(tmp_path / "v" / "verify.sqlite")
    calls: list[int] = []
    client = _client(calls)
    got = stations.ensure(conn, client)
    assert {s.id for s in got} == {"VTBS", "VTCC"}  # Singapore is outside the domain
    assert conn.execute("SELECT COUNT(*) FROM stations").fetchone()[0] == 2
    assert stations.ensure(conn, client)[0].id == "VTBS"
    assert len(calls) == 1  # second call does not refetch


def test_connect_is_idempotent(tmp_path):
    p = tmp_path / "x" / "v.sqlite"
    db.connect(p).close()
    conn = db.connect(p)
    assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
