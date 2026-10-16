import json

import pytest

from verify.__main__ import build_parser, main


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
