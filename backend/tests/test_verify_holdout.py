from verify import db, holdout


def _conn(tmp_path, n=12):
    conn = db.connect(tmp_path / "v.sqlite")
    for i in range(n):
        db.upsert_station(conn, f"S{i:02d}", f"S{i}", 6.0 + i, 100.0, 10.0, "iem")
    db.upsert_station(conn, "CSV1", "csv", 12.0, 100.0, 10.0, "csv")  # not an IEM station
    conn.commit()
    return conn


def test_load_is_empty_before_choice(tmp_path):
    assert holdout.load(_conn(tmp_path)) == set()


def test_quarter_spread_over_latitude(tmp_path):
    conn = _conn(tmp_path)
    chosen = holdout.ensure(conn)
    assert chosen == {"S02", "S06", "S10"}  # 12 stations, every 4th starting at index 2
    assert "CSV1" not in chosen
    lats = {r["id"]: r["lat"] for r in conn.execute("SELECT id, lat FROM stations")}
    assert min(lats[s] for s in chosen) < 9.0 and max(lats[s] for s in chosen) > 14.0  # south and north bands
    assert holdout.load(conn) == chosen


def test_stable_after_stations_are_added(tmp_path):
    conn = _conn(tmp_path)
    first = holdout.ensure(conn)
    for i in range(8):
        db.upsert_station(conn, f"N{i}", "n", 5.5 + i * 0.3, 100.0, 10.0, "iem")
    conn.commit()
    assert holdout.ensure(conn) == first
    assert holdout.load(conn) == first
