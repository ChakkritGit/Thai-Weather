"""Archive forecasts at the station points, once per model run.

Three series are stored for every station and hour so they can be scored later
against the same observations:

* ``fine``      the 2 km downscaled forecast (``/api/v1/point`` ``fine``)
* ``gfs_raw``   the raw driving-model grid cell (``/api/v1/point`` ``coarse``)
* ``openmeteo`` Open-Meteo's own point forecast of the same model, at the
                station elevation - the "free alternative" baseline

Open-Meteo ``precipitation`` is the sum over the *preceding* hour and the app's
``rain`` follows the same convention, so valid times are stored as given.
The whole run is written in one transaction: a run is either archived
completely or not at all (the ``runs`` row goes in last).
"""

from __future__ import annotations

import logging
import os
import sqlite3
from datetime import UTC, datetime

import httpx

from . import db, stations

log = logging.getLogger(__name__)

OPENMETEO_URL = "https://api.open-meteo.com/v1/forecast"
OPENMETEO_CUSTOMER_URL = "https://customer-api.open-meteo.com/v1/forecast"


def _baseline(
    om: httpx.Client, sts: list[stations.Station], times: list[datetime], model: str, api_key: str | None
) -> list[tuple]:
    """One request for all stations -> ``forecasts`` rows (without run_id)."""
    params = {
        "latitude": ",".join(f"{s.lat:.4f}" for s in sts),
        "longitude": ",".join(f"{s.lon:.4f}" for s in sts),
        "elevation": ",".join("nan" if s.elevation is None else f"{s.elevation:.0f}" for s in sts),
        "hourly": "temperature_2m,precipitation",
        "models": model,
        "timezone": "GMT",
        "start_hour": times[0].strftime("%Y-%m-%dT%H:00"),
        "end_hour": times[-1].strftime("%Y-%m-%dT%H:00"),
    }
    if api_key:
        params["apikey"] = api_key
    r = om.get(OPENMETEO_CUSTOMER_URL if api_key else OPENMETEO_URL, params=params)
    r.raise_for_status()
    data = r.json()
    locs = data if isinstance(data, list) else [data]
    if len(locs) != len(sts):
        raise ValueError(f"open-meteo returned {len(locs)} locations for {len(sts)} stations")
    t0 = times[0]
    rows: list[tuple] = []
    for s, loc in zip(sts, locs, strict=True):
        hourly = loc["hourly"]
        temps = hourly.get("temperature_2m") or []
        rains = hourly.get("precipitation") or []
        for i, ts in enumerate(hourly["time"]):
            t = datetime.fromisoformat(ts).replace(tzinfo=UTC)
            t2m = temps[i] if i < len(temps) else None
            rain = rains[i] if i < len(rains) else None
            if t2m is None and rain is None:
                continue
            lead = round((t - t0).total_seconds() / 3600)
            rows.append(("openmeteo", s.id, db.fmt_time(t), lead, t2m, rain, None))
    return rows


def collect(
    conn: sqlite3.Connection,
    api: httpx.Client,
    om: httpx.Client | None,
    include_demo: bool = False,
    model: str | None = None,
    api_key: str | None = None,
) -> str | None:
    """Archive the latest run; returns its ``run_id`` or ``None`` when nothing was stored."""
    model = model or os.environ.get("THWX_OPENMETEO_MODEL") or "gfs_seamless"
    api_key = api_key if api_key is not None else (os.environ.get("THWX_OPENMETEO_API_KEY") or None)

    run = api.get("/api/v1/meta").raise_for_status().json().get("run")
    if not run:
        log.info("collect: API has no run yet")
        return None
    run_id = run["run_id"]
    if run.get("demo") and not include_demo:
        log.info("collect: run %s is a demo run, not archived", run_id)
        return None
    if conn.execute("SELECT 1 FROM runs WHERE run_id=?", (run_id,)).fetchone():
        log.info("collect: run %s already archived", run_id)
        return None

    sts = stations.load(conn)
    if not sts:
        log.warning("collect: no stations in the database (run `loop` or fetch stations first)")
        return None

    times = [datetime.fromisoformat(t).astimezone(UTC) for t in run["times"]]
    t0 = times[0]
    leads = [round((t - t0).total_seconds() / 3600) for t in times]
    valids = [db.fmt_time(t) for t in times]

    rows: list[tuple] = []
    elevations: dict[str, str] = {}
    used: list[stations.Station] = []
    for s in sts:
        r = api.get("/api/v1/point", params={"lat": f"{s.lat:.4f}", "lon": f"{s.lon:.4f}"})
        if r.status_code == 422:
            log.info("collect: station %s outside the forecast domain, skipped", s.id)
            continue
        r.raise_for_status()
        d = r.json()
        if d["run_id"] != run_id:
            raise RuntimeError(f"run changed during collection ({run_id} -> {d['run_id']}); retry next cycle")
        used.append(s)
        loc = d.get("location") or {}
        if loc.get("elevation") is not None and loc.get("model_elevation") is not None:
            elevations[s.id] = f"{loc['elevation']:.0f},{loc['model_elevation']:.0f}"
        for source, block in (("fine", d["fine"]), ("gfs_raw", d["coarse"])):
            temp, rain, pop = block["temp"], block["rain"], block.get("pop") or [None] * len(valids)
            for i, valid in enumerate(valids):
                rows.append((source, s.id, valid, leads[i], temp[i], rain[i], pop[i]))

    baseline_ok = 0
    if om is not None and used:
        try:
            rows.extend(_baseline(om, used, times, model, api_key))
            baseline_ok = 1
        except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
            log.warning("collect: Open-Meteo baseline failed (%s); archiving fine/gfs_raw only", exc)

    try:
        for sid, value in elevations.items():
            db.set_meta(conn, f"elev:{sid}", value)
        conn.executemany(
            "INSERT OR REPLACE INTO forecasts (run_id, source, station, valid, lead_h, t2m, rain, pop) "
            "VALUES (?,?,?,?,?,?,?,?)",
            [(run_id, *row) for row in rows],
        )
        conn.execute(
            "INSERT INTO runs (run_id, run_time, collected_at, n_stations, baseline_ok, obs_used, obs_stations) "
            "VALUES (?,?,?,?,?,?,?)",
            (
                run_id,
                db.fmt_time(t0),
                db.fmt_time(datetime.now(UTC)),
                len(used),
                baseline_ok,
                int(run.get("observations_used") or 0),
                ",".join(run.get("observation_stations") or []),
            ),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    log.info("collect: archived run %s (%d stations, baseline_ok=%d)", run_id, len(used), baseline_ok)
    return run_id
