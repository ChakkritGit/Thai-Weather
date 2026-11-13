import json

import pytest

from verify import db
from verify.__main__ import build_parser, learning_status, main, parse_mlp_log_line, run_mlp_backfill


@pytest.mark.parametrize("cmd", [[], ["collect"], ["observe"], ["push"], ["score"], ["loop"]])
def test_help_works(cmd, capsys):
    with pytest.raises(SystemExit) as exc:
        build_parser().parse_args([*cmd, "--help"])
    assert exc.value.code == 0
    assert "usage" in capsys.readouterr().out


def test_score_on_empty_db_prints_no_data(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("THWX_DATA_DIR", str(tmp_path))
    assert main(["score", "--days", "7"]) == 0
    assert "no data yet" in capsys.readouterr().out
    assert (tmp_path / "verification" / "report.md").exists()
    data = json.loads((tmp_path / "verification" / "report.json").read_text(encoding="utf-8"))
    assert data["temperature"]["matched"] == 0 and "generated" in data
    # what the forecast has learned: nothing yet on an empty database
    assert data["learning"]["pop_calibration"]["identity"] is True
    assert data["learning"]["temp_bias"] is None and data["learning"]["temp_mlp"] is None


LOG = """2026-11-06 02:46:50,391 INFO verify.mlp: mlp: waiting for data (38475/20000 pairs, 24/90 days)
2026-11-06 02:47:10,838 INFO verify.rainmlp: rainmlp: waiting for data (5926/2000 rain hours, 25/30 days)
2026-11-11 03:44:20,267 INFO verify.rainmlp: rainmlp: not used (Brier raw 0.0974, logistic 0.0799, mlp 0.1519)
2026-11-12 15:06:22,693 INFO verify.mlp: mlp: waiting for data (50008/20000 pairs, 30/90 days)
2026-11-13 03:00:01,000 INFO verify.mlp: mlp: not used (MAE raw 1.500, hourly 1.400, mlp 1.390)
2026-11-14 03:00:01,000 INFO verify.mlp: mlp: active (MAE raw 1.500, hourly 1.400, mlp 1.200, 42 epochs)
2026-11-14 03:01:01,000 INFO verify.rainmlp: rainmlp: active (Brier raw 0.0974, logistic 0.0799, mlp 0.0700, 31 epochs)
2026-11-14 03:01:02,000 INFO verify: unrelated line
"""


def test_backfill_parses_every_log_format():
    kind, st = parse_mlp_log_line(LOG.splitlines()[0])
    assert kind == "temp" and st["fitted_at"] == "2026-11-06T02:46+00:00"
    assert (st["pairs"], st["days"], st["events"], st["metrics"]) == (38475, 24, None, None)
    kind, st = parse_mlp_log_line(LOG.splitlines()[1])
    assert kind == "rain" and (st["events"], st["pairs"], st["days"]) == (5926, None, 25)
    kind, st = parse_mlp_log_line(LOG.splitlines()[2])
    assert (
        kind == "rain"
        and st["active"] is False
        and st["metrics"]
        == {
            "brier_raw": 0.0974,
            "brier_logistic": 0.0799,
            "brier_mlp": 0.1519,
        }
    )
    assert "logistic" in st["reason"]
    _, st = parse_mlp_log_line(LOG.splitlines()[4])
    assert st["metrics"] == {"mae_raw": 1.5, "mae_hourly_bias": 1.4, "mae_mlp": 1.39}
    _, st = parse_mlp_log_line(LOG.splitlines()[5])
    assert st["active"] is True and st["reason"] is None and st["metrics"]["epochs"] == 42
    _, st = parse_mlp_log_line(LOG.splitlines()[6])
    assert st["metrics"]["brier_mlp"] == 0.07 and st["metrics"]["epochs"] == 31
    assert parse_mlp_log_line(LOG.splitlines()[7]) is None


def test_backfill_is_idempotent_and_keeps_real_rows(tmp_path):
    conn = db.connect(tmp_path / "v.db")
    real = {"fitted_at": "2026-11-06T02:46+00:00", "active": False, "reason": "waiting for data", "pairs": 1}
    db.record_mlp_run(conn, "temp", real)
    assert run_mlp_backfill(conn, LOG.splitlines()) == 6
    assert run_mlp_backfill(conn, LOG.splitlines()) == 0
    h = db.mlp_history(conn, "temp")["history"]
    assert [r["fitted_at"][:10] for r in h] == ["2026-11-06", "2026-11-12", "2026-11-13", "2026-11-14"]
    assert h[0]["pairs"] == 1
    assert len(db.mlp_history(conn, "rain")["history"]) == 3


def test_backfill_command_reads_stdin(tmp_path, monkeypatch, capsys):
    import io

    monkeypatch.setenv("THWX_DATA_DIR", str(tmp_path))
    monkeypatch.setattr("sys.stdin", io.StringIO(LOG))
    assert main(["mlp-backfill"]) == 0
    assert "7 MLP runs added" in capsys.readouterr().out


def test_learning_status_carries_the_history(tmp_path, monkeypatch):
    monkeypatch.setenv("THWX_DATA_DIR", str(tmp_path))
    conn = db.connect(tmp_path / "v.db")
    assert learning_status(conn)["mlp"]["rain"] == {"history": [], "curve": None}
    curve = {"metric": "brier", "train": [0.2, 0.1], "val": [0.3, 0.2], "best_epoch": 2}
    db.record_mlp_run(conn, "rain", {"fitted_at": "2026-11-14T03:00+00:00", "active": False, "curve": curve})
    got = learning_status(conn)["mlp"]["rain"]
    assert got["history"][0]["fitted_at"] == "2026-11-14T03:00+00:00"
    assert got["curve"]["val"] == [0.3, 0.2] and got["curve"]["fitted_at"] == "2026-11-14T03:00+00:00"
    assert learning_status(conn)["pop_calibration"]["identity"] is True
