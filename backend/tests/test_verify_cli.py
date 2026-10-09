import pytest

from verify.__main__ import build_parser, main


@pytest.mark.parametrize("cmd", [[], ["collect"], ["observe"], ["score"], ["loop"]])
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
