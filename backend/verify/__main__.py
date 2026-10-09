"""Command line: ``python -m verify {collect,observe,push,score,loop}``.

``loop`` is what the ``verify`` compose service runs: every 15 min it pulls
fresh observations, feeds the non-hold-out ones to the app's station correction
(``THWX_VERIFY_PUSH=false`` disables that), archives the newest forecast run and,
at most hourly, rewrites the report.  Each step is isolated so a transient failure (API restarting, IEM down) never
kills the loop.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx

from . import collect as collect_mod
from . import db, holdout, observe, score, stations
from . import push as push_mod

log = logging.getLogger("verify")

USER_AGENT = "thai-weather-hd-verify"
DEFAULT_API = "http://localhost:8000"
SCORE_EVERY_S = 3600.0  # the loop runs every few minutes, the report only needs hourly refreshes
FALSY = ("0", "false", "no", "off", "")


def data_dir() -> Path:
    return Path(os.environ.get("THWX_DATA_DIR") or "var") / "verification"


def db_path() -> Path:
    return data_dir() / "verify.sqlite"


def _client(base_url: str | None = None) -> httpx.Client:
    kwargs = {"base_url": base_url} if base_url else {}
    return httpx.Client(timeout=60.0, headers={"User-Agent": USER_AGENT}, follow_redirects=True, **kwargs)


def _date(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%d").replace(tzinfo=UTC)


def _api_url(args: argparse.Namespace) -> str:
    return args.api or os.environ.get("THWX_VERIFY_API") or DEFAULT_API


def run_collect(conn, args: argparse.Namespace) -> str | None:
    with _client() as ext, _client(_api_url(args)) as api:
        stations.ensure(conn, ext)
        if args.no_baseline:
            return collect_mod.collect(conn, api, None, include_demo=args.include_demo)
        return collect_mod.collect(conn, api, ext, include_demo=args.include_demo)


def run_observe(conn, args: argparse.Namespace) -> int:
    if args.csv:
        return observe.import_csv(conn, args.csv)
    with _client() as ext:
        stations.ensure(conn, ext)
        holdout.ensure(conn)
        return observe.fetch_iem(conn, ext, _date(args.since) if args.since else None)


def run_push(conn, args: argparse.Namespace) -> int:
    holdout.ensure(conn)
    with _client(_api_url(args)) as api:
        return push_mod.push(conn, api, os.environ.get("THWX_ADMIN_TOKEN") or None)


def run_score(conn, args: argparse.Namespace) -> str:
    until = datetime.now(UTC)
    if args.since:
        since = _date(args.since)
    else:
        since = until - timedelta(days=args.days)
    md = score.render_markdown(score.score(conn, since, until))
    out = Path(args.out) if args.out else data_dir() / "report.md"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(md, encoding="utf-8")
    return md


def run_loop(conn, args: argparse.Namespace) -> None:
    interval = max(1.0, args.interval_min) * 60.0
    score_args = argparse.Namespace(since=None, days=args.days, out=None)
    push_on = os.environ.get("THWX_VERIFY_PUSH", "true").strip().lower() not in FALSY
    last_score = float("-inf")
    while True:
        steps = [("observe", lambda: run_observe(conn, argparse.Namespace(csv=None, since=None)))]
        if push_on:
            steps.append(("push", lambda: run_push(conn, args)))
        steps.append(("collect", lambda: run_collect(conn, args)))
        if time.monotonic() - last_score >= SCORE_EVERY_S:
            steps.append(("score", lambda: run_score(conn, score_args)))
            last_score = time.monotonic()
        for name, step in steps:
            try:
                step()
            except Exception:
                log.exception("%s failed; continuing", name)
        time.sleep(interval)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m verify", description="Forecast verification against station observations"
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("collect", help="archive the latest forecast run at the station points")
    c.add_argument("--api", help=f"thai-weather API base URL (env THWX_VERIFY_API, default {DEFAULT_API})")
    c.add_argument("--no-baseline", action="store_true", help="skip the Open-Meteo baseline request")
    c.add_argument("--include-demo", action="store_true", help="also archive demo runs (testing only)")

    o = sub.add_parser("observe", help="fetch IEM METAR observations or import a CSV")
    o.add_argument("--since", help="start date YYYY-MM-DD (default: incremental)")
    o.add_argument("--csv", help="import station_id,time,lat,lon,elevation,t2m[,rain_1h] instead of fetching")

    pu = sub.add_parser("push", help="send the latest METAR temperatures of non-hold-out stations to the API")
    pu.add_argument("--api", help=f"thai-weather API base URL (env THWX_VERIFY_API, default {DEFAULT_API})")

    s = sub.add_parser("score", help="print and write the verification report")
    s.add_argument("--days", type=int, default=30, help="look back N days (default 30)")
    s.add_argument("--since", help="start date YYYY-MM-DD (overrides --days)")
    s.add_argument("--out", help="report path (default <data>/verification/report.md)")

    lp = sub.add_parser("loop", help="observe + push + collect (+ hourly score) forever")
    lp.add_argument("--interval-min", type=float, default=15.0)
    lp.add_argument("--days", type=int, default=30, help="report window in days")
    lp.add_argument("--api", help=f"thai-weather API base URL (env THWX_VERIFY_API, default {DEFAULT_API})")
    lp.add_argument("--no-baseline", action="store_true")
    lp.add_argument("--include-demo", action="store_true")
    return p


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    args = build_parser().parse_args(argv)
    conn = db.connect(db_path())
    try:
        if args.cmd == "collect":
            run_id = run_collect(conn, args)
            print(f"archived {run_id}" if run_id else "nothing to archive")
        elif args.cmd == "observe":
            print(f"{run_observe(conn, args)} observation rows written")
        elif args.cmd == "push":
            print(f"{run_push(conn, args)} observations accepted")
        elif args.cmd == "score":
            print(run_score(conn, args))
        else:
            run_loop(conn, args)
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
