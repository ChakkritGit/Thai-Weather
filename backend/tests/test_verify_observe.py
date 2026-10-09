from datetime import UTC, datetime

import httpx
import pytest

from verify import db, observe

CSV = """station,valid,tmpc,wxcodes,p01m
VTBS,2026-10-08 00:00,29.0,M,M
VTBS,2026-10-08 00:30,28.0,-RA BR,T
VTCC,2026-10-08 00:00,M,M,M
VTCC,2026-10-08 01:00,25.0,VCSH,0.4
XXXX,2026-10-08 00:00,30.0,M,M
"""


@pytest.mark.parametrize(
    ("wx", "expected"),
    [("-RA", True), ("TSRA", True), ("VCSH", False), ("BR", False), ("HZ", False), ("+SHRA", True), ("", False)],
)
def test_is_rain_table(wx, expected):
    assert observe.is_rain(wx) is expected


def test_is_rain_unknown_and_p01m():
    assert observe.is_rain(None) is None
    assert observe.is_rain(None, 0.0) is False
    assert observe.is_rain("", 0.2) is True
    assert observe.is_rain("VCTS BR") is False


def test_parse_iem_csv_handles_missing_and_trace():
    rows = observe.parse_iem_csv(CSV, {"VTBS", "VTCC"})
    assert rows == [
        ("VTBS", "2026-10-08T00:00", 29.0, "", None),
        ("VTBS", "2026-10-08T00:30", 28.0, "-RA BR", 0.0),
        ("VTCC", "2026-10-08T01:00", 25.0, "VCSH", 0.4),
    ]


def _conn(tmp_path):
    conn = db.connect(tmp_path / "v.sqlite")
    db.upsert_station(conn, "VTBS", "BANGKOK", 13.68, 100.75, 3, "iem")
    db.upsert_station(conn, "VTCC", "CHIANG MAI", 18.77, 98.96, 312, "iem")
    conn.commit()
    return conn


def test_fetch_iem_params_and_idempotent_upsert(tmp_path):
    conn = _conn(tmp_path)
    seen: list[httpx.URL] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url)
        return httpx.Response(200, text=CSV)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    start, end = datetime(2026, 10, 8, tzinfo=UTC), datetime(2026, 10, 9, 5, tzinfo=UTC)
    assert observe.fetch_iem(conn, client, start, end) == 3
    assert observe.fetch_iem(conn, client, start, end) == 3
    assert conn.execute("SELECT COUNT(*) FROM obs").fetchone()[0] == 3
    q = seen[0].params
    assert q["network"] == "TH__ASOS" and q["tz"] == "Etc/UTC" and q["format"] == "onlycomma"
    assert (q["year1"], q["month1"], q["day1"]) == ("2026", "10", "8")
    assert q["day2"] == "10"  # inclusive end -> exclusive upper bound


def test_fetch_iem_splits_long_ranges(tmp_path):
    conn = _conn(tmp_path)
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(200, text="station,valid,tmpc,wxcodes,p01m\n")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    observe.fetch_iem(conn, client, datetime(2026, 8, 1, tzinfo=UTC), datetime(2026, 10, 5, tzinfo=UTC))
    assert len(calls) == 3  # 65 days -> 31 + 31 + 3


def test_import_csv_converts_to_utc_and_upserts(tmp_path):
    conn = db.connect(tmp_path / "v.sqlite")
    p = tmp_path / "obs.csv"
    p.write_text(
        "station_id,time,lat,lon,elevation,t2m,rain_1h\nTMD1,2026-10-09T07:00+07:00,13.7,100.5,5,31.2,0.0\n"
        "TMD1,2026-10-09T08:00+07:00,13.7,100.5,5,,1.5\n",
        encoding="utf-8",
    )
    assert observe.import_csv(conn, p) == 2
    assert observe.import_csv(conn, p) == 2
    rows = conn.execute("SELECT valid, t2m, rain_1h FROM obs ORDER BY valid").fetchall()
    assert [tuple(r) for r in rows] == [("2026-10-09T00:00", 31.2, 0.0), ("2026-10-09T01:00", None, 1.5)]
    assert conn.execute("SELECT source FROM stations WHERE id='TMD1'").fetchone()[0] == "csv"


def test_import_csv_rejects_naive_time(tmp_path):
    conn = db.connect(tmp_path / "v.sqlite")
    p = tmp_path / "obs.csv"
    p.write_text("station_id,time,lat,lon,elevation,t2m\nA,2026-10-09 07:00,13.7,100.5,5,31\n", encoding="utf-8")
    with pytest.raises(ValueError, match="line 2"):
        observe.import_csv(conn, p)
    assert conn.execute("SELECT COUNT(*) FROM obs").fetchone()[0] == 0
