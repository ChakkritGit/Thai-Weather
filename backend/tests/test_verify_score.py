import math
from datetime import UTC, datetime

import pytest

from verify import db, score

SINCE = datetime(2026, 10, 9, tzinfo=UTC)
UNTIL = datetime(2026, 10, 10, tzinfo=UTC)
RUN = "R1"


def _db(tmp_path):
    conn = db.connect(tmp_path / "v.sqlite")
    conn.execute(
        "INSERT INTO runs (run_id, run_time, collected_at, n_stations, baseline_ok) VALUES (?,?,?,?,?)",
        (RUN, "2026-10-09T00:00", "2026-10-09T00:10", 1, 1),
    )
    return conn


def _station(conn, sid, elev=50.0):
    db.upsert_station(conn, sid, sid.title(), 13.0, 100.0, elev, "iem")


def _fc(conn, source, station, hour, t2m=30.0, rain=0.0, pop=None):
    valid = f"2026-10-09T{hour:02d}:00"
    conn.execute("INSERT INTO forecasts VALUES (?,?,?,?,?,?,?,?)", (RUN, source, station, valid, hour, t2m, rain, pop))


def _obs(conn, station, hhmm, t2m=30.0, wx="", rain_1h=None):
    conn.execute("INSERT INTO obs VALUES (?,?,?,?,?)", (station, f"2026-10-09T{hhmm}", t2m, wx, rain_1h))


def _temperature_case(conn):
    _station(conn, "A")
    fine, gfs, om = [31, 29, 32, 28], [33] * 4, [31, 31, 31, None]
    for h in range(4):
        _obs(conn, "A", f"{h:02d}:00")
        _fc(conn, "fine", "A", h, fine[h])
        _fc(conn, "gfs_raw", "A", h, gfs[h])
        _fc(conn, "openmeteo", "A", h, om[h], rain=None if om[h] is None else 0.0)
    conn.commit()


def test_known_bias_mae_rmse_and_matched_sample(tmp_path):
    conn = _db(tmp_path)
    _temperature_case(conn)
    rep = score.score(conn, SINCE, UNTIL)
    assert rep.sources == ["fine", "gfs_raw", "openmeteo"]
    assert rep.temp_matched == 3  # the hour without an Open-Meteo value is excluded for everyone
    assert rep.temp_unmatched == {"fine": 1, "gfs_raw": 1, "openmeteo": 0}
    fine = rep.temp_overall["fine"]  # errors +1, -1, +2
    assert fine.n == 3
    assert fine.bias == pytest.approx(2 / 3)
    assert fine.mae == pytest.approx(4 / 3)
    assert fine.rmse == pytest.approx(math.sqrt(2.0))
    assert rep.temp_overall["gfs_raw"].bias == pytest.approx(3.0)
    assert rep.temp_overall["openmeteo"].mae == pytest.approx(1.0)
    assert [r.label for r in rep.by_elevation] == ["< 100 m"]
    assert [r.label for r in rep.by_lead] == ["0-11 h"]
    assert rep.by_station[0].extra["name"] == "A"
    assert [r.label for r in rep.by_hour] == ["06-08", "09-11"]


def test_pairing_tolerance_is_20_minutes(tmp_path):
    conn = _db(tmp_path)
    _station(conn, "B")
    for h in range(3):
        for src, v in (("fine", 31.0), ("gfs_raw", 32.0)):
            _fc(conn, src, "B", h, v)
    _obs(conn, "B", "00:15")  # within tolerance -> paired with 00:00
    _obs(conn, "B", "01:25")  # 25 min from 01:00 and 35 from 02:00 -> not paired
    _obs(conn, "B", "01:55", t2m=29.0)  # 5 min before 02:00 -> paired
    conn.commit()
    rep = score.score(conn, SINCE, UNTIL)
    assert rep.temp_matched == 2
    assert rep.temp_overall["fine"].bias == pytest.approx((1 + 2) / 2)


def test_rain_contingency_and_brier(tmp_path):
    conn = _db(tmp_path)
    cases = {  # station: (obs time, wx, fine rain, gfs rain, fine pop)
        "S1": ("04:00", "RA", 1.0, 0.0, 80),
        "S2": ("04:00", "", 0.5, 0.0, 60),
        "S3": ("04:00", "VCSH", 0.0, 0.3, 10),
        "S4": ("05:00", "TSRA", 0.2, 0.2, 50),
        "S5": (None, None, 1.0, 1.0, 90),  # no observation -> window ignored
    }
    for sid, (hhmm, wx, fine_rain, gfs_rain, pop) in cases.items():
        _station(conn, sid)
        if hhmm:
            _obs(conn, sid, hhmm, wx=wx)
        for h in (3, 4, 5):  # window (02, 05] UTC = 09-12 ICT
            _fc(conn, "fine", sid, h, rain=fine_rain, pop=pop)
            _fc(conn, "gfs_raw", sid, h, rain=gfs_rain)
    conn.commit()
    rep = score.score(conn, SINCE, UNTIL)
    assert rep.rain_windows == 4
    f, g = rep.rain["fine"], rep.rain["gfs_raw"]
    assert (f.hits, f.misses, f.false_alarms, f.correct_negatives) == (2, 0, 1, 1)
    assert (g.hits, g.misses, g.false_alarms, g.correct_negatives) == (1, 1, 1, 1)
    assert f.pod == 1.0
    assert f.far == pytest.approx(1 / 3)
    assert f.csi == pytest.approx(2 / 3)
    assert f.freq_bias == pytest.approx(1.5)
    assert rep.brier["fine"] == pytest.approx((0.04 + 0.36 + 0.01 + 0.25) / 4)
    assert rep.brier["gfs_raw"] == pytest.approx((1 + 0 + 1 + 0) / 4)


def test_markdown_contains_each_table_and_warns_on_small_n(tmp_path):
    conn = _db(tmp_path)
    _temperature_case(conn)
    md = score.render_markdown(score.score(conn, SINCE, UNTIL))
    for heading in ("## 1.", "## 2.", "## 3.", "## 4.", "## 5.", "## 6."):
        assert heading in md
    assert "N = 3" in md and "ตัวอย่างน้อย" in md
    assert "Skill fine" in md and "| A |" in md and "METAR" in md


def test_empty_database_renders_no_data(tmp_path):
    conn = _db(tmp_path)
    md = score.render_markdown(score.score(conn, None, UNTIL))
    assert "no data yet" in md


def _effect_db(tmp_path, with_holdout=True):
    """Run R1 corrected, R2 not; station H is held out, A is assimilated; errors fine +1 / +3, gfs +2 / +4."""
    conn = _db(tmp_path)
    conn.execute("UPDATE runs SET obs_used = 2, obs_stations = 'A' WHERE run_id = 'R1'")
    conn.execute(
        "INSERT INTO runs (run_id, run_time, collected_at, n_stations, baseline_ok, obs_used) "
        "VALUES ('R2','2026-10-09T00:00','2026-10-09T00:10',2,1,0)"
    )
    for sid in ("A", "H"):
        _station(conn, sid)
    if with_holdout:
        db.set_meta(conn, "holdout", "H")
    for sid in ("A", "H"):
        for hour in (1, 14):  # lead 1 h and 14 h
            _obs(conn, sid, f"{hour:02d}:00", t2m=30.0)
        for run, fine_err, gfs_err in (("R1", 1.0, 2.0), ("R2", 3.0, 4.0)):
            for hour in (1, 14):
                valid = f"2026-10-09T{hour:02d}:00"
                for src, err in (("fine", fine_err), ("gfs_raw", gfs_err)):
                    conn.execute(
                        "INSERT INTO forecasts VALUES (?,?,?,?,?,?,?,?)",
                        (run, src, sid, valid, hour, 30.0 + err, 0.0, None),
                    )
    conn.commit()
    return conn


def test_correction_effect_cells(tmp_path):
    rep = score.score(_effect_db(tmp_path), SINCE, UNTIL)
    assert rep.holdout_ids == ["H"] and rep.corrected_samples == 4
    cells = {(r.label, r.extra["run"], r.extra["lead"]): r for r in rep.effect}
    assert len(cells) == 8 and all(r.n == 1 for r in cells.values())
    h = cells[("hold-out", "corrected", "0-11 h")]
    assert h.metrics["fine"].mae == pytest.approx(1.0) and h.metrics["gfs_raw"].mae == pytest.approx(2.0)
    assert cells[("hold-out", "uncorrected", "12-47 h")].metrics["fine"].bias == pytest.approx(3.0)
    md = score.render_markdown(rep)
    assert "## 7." in md and "`H`" in md and "| hold-out | corrected | 0-11 h | 1 |" in md


def test_correction_effect_absent_messages(tmp_path):
    md = score.render_markdown(score.score(_effect_db(tmp_path, with_holdout=False), SINCE, UNTIL))
    assert "## 7." in md and "no hold-out set chosen yet" in md
    conn = _effect_db(tmp_path / "x")
    conn.execute("UPDATE runs SET obs_used = 0")
    conn.commit()
    md = score.render_markdown(score.score(conn, SINCE, UNTIL))
    assert "no corrected runs yet" in md
