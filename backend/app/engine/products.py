"""Framework-independent numerical products shared by the Rust worker and contract oracle."""

from __future__ import annotations

import binascii
import json
from dataclasses import asdict
from datetime import UTC, datetime
from functools import cache
from pathlib import Path as FsPath

import numpy as np
from pydantic import BaseModel, Field

from ..config import get_settings
from ..core.places import ATTRIBUTION as PLACES_ATTRIBUTION
from ..core.places import search_places
from ..core.provinces_meta import REGIONS
from ..core.static import DATA_DIR, load_static
from ..downscale.layers import LAYERS, run_encoding
from ..downscale.observations import Observation
from ..downscale.pipeline import explain_point
from ..nowcast.cyclones import position_at, proximity
from ..nowcast.nowcast import point_nowcast
from ..nowcast.service import LEADS, RADAR_ENCODING, STALE_AFTER_MIN
from ..products.aggregate import thai_date, thai_hhmm
from ..products.alerts import is_partial, normalise_day, province_alerts
from ..products.scales import weather_scales
from ..push.service import PushService
from ..push.store import MAX_ENDPOINT_LEN, MAX_LABEL_LEN, Prefs, PushError, auth_matches, validate_endpoint
from ..push.vapid import b64url_decode
from ..store import Run
from .types import Context, Product, ProductError


def current_run(ctx: Context) -> Run:
    run = ctx.state.store.latest()
    if run is None:
        raise ProductError(503, detail="The first forecast run is still being computed – try again shortly.")
    return run


def _binary(data: np.ndarray, etag: str, ctx: Context, extra: dict | None = None) -> Product:
    headers = {
        "ETag": f'"{etag}"',
        "Cache-Control": "public, max-age=900",
        "X-Grid-NY": str(data.shape[0]),
        "X-Grid-NX": str(data.shape[1]),
        "Access-Control-Expose-Headers": "X-Grid-NY, X-Grid-NX, X-Run-Id",
        **(extra or {}),
    }
    if ctx.headers.get("if-none-match") == headers["ETag"]:
        return Product(status_code=304, headers=headers)
    return Product(np.ascontiguousarray(data).tobytes(), media_type="application/octet-stream", headers=headers)


def health(ctx: Context) -> dict:
    run = ctx.state.store.latest()
    return {
        "ok": True,
        "run": run.run_id if run else None,
        "refresher": ctx.state.refresher.status,
        "nowcast": ctx.state.nowcast.status,
    }


def meta(ctx: Context) -> dict:
    run = ctx.state.store.latest()
    static = load_static()
    return {
        "status": ctx.state.refresher.status,
        "run": {**run.meta, "days": list(_day_coverage(run).values())} if run else None,
        "layers": [
            {**lyr.describe(), "encoding": asdict(run_encoding(run.meta, lid))} if run else lyr.describe()
            for lid, lyr in LAYERS.items()
        ],
        "regions": [{"id": k, "name_th": v[0], "name_en": v[1]} for k, v in REGIONS.items()],
        "scales": weather_scales(),
        "fine_grid": static.grid.describe(),
    }


def places(q: str = "") -> dict:
    return {"places": search_places(q), "attribution": PLACES_ATTRIBUTION}


def layer(layer: str, ctx: Context, run: Run, step: int = 0, day: int = 0, res: str = "fine") -> Product:
    if layer not in LAYERS:
        raise ProductError(404, detail=f"unknown layer {layer}")
    arr = run.array(res, layer)
    i = day if LAYERS[layer].daily else step
    if not 0 <= i < arr.shape[0]:
        raise ProductError(404, detail="time index out of range")
    return _binary(np.asarray(arr[i]), f"{run.run_id}-{res}-{layer}-{i}", ctx, {"X-Run-Id": run.run_id})


@cache
def _hillshade() -> np.ndarray:
    static = load_static()
    z = static.elev_land
    dzdy = np.gradient(z, axis=0) / static.dy_m
    dzdx = np.gradient(z, axis=1) / static.dx_m[:, None]
    az, alt = (np.radians(315.0), np.radians(45.0))
    slope = np.arctan(2.5 * np.hypot(dzdx, dzdy))
    aspect = np.arctan2(-dzdx, -dzdy)
    shade = np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect)
    shade = np.clip((np.sin(alt) - shade) / np.sin(alt), 0, 1) * 255
    return np.where(static.land, shade, 0).astype(np.uint8)


def static_layer(name: str, ctx: Context) -> Product:
    static = load_static()
    if name == "hillshade":
        data = _hillshade()
    elif name == "thai":
        data = static.thai.astype(np.uint8)
    elif name == "elevation":
        data = np.clip(static.elev_land / 10.0, 0, 255).astype(np.uint8)
    else:
        raise ProductError(404, detail="unknown static layer")
    return _binary(data, f"static-{name}-v2", ctx)


def geo(name: str) -> Product:
    if name not in ("provinces", "countries"):
        raise ProductError(404)
    return Product((DATA_DIR / "geo" / f"{name}.geojson").read_bytes(), media_type="application/geo+json")


def point(lat: float, lon: float, run: Run) -> dict:
    static = load_static()
    fine = run.fine_grid
    if not fine.contains(lat, lon):
        raise ProductError(422, detail="location outside the forecast domain")
    iy, ix = fine.index(lat, lon)
    cy, cx = run.coarse_grid.index(lat, lon)
    hourly = [k for k, v in LAYERS.items() if not v.daily]
    pidx = int(static.province[iy, ix])
    province = static.provinces[pidx - 1] if pidx else None
    explanation = explain_point(run.coarse_raw(), run.coarse_grid, static, lat, lon)
    return {
        "run_id": run.run_id,
        "demo": run.meta["demo"],
        "location": {
            "lat": round(float(fine.lats[iy]), 4),
            "lon": round(float(fine.lons[ix]), 4),
            "land": bool(static.land[iy, ix]),
            "province": province,
            "elevation": explanation["elevation_fine"],
            "model_elevation": explanation["elevation_model"],
            "coarse_cell": {
                "lat": round(float(run.coarse_grid.lats[cy]), 3),
                "lon": round(float(run.coarse_grid.lons[cx]), 3),
                "size_km": run.coarse_grid.resolution_km,
            },
        },
        "times": run.meta["times"],
        "fine": {k: run.series("fine", k, iy, ix) for k in hourly},
        "coarse": {k: run.series("coarse", k, cy, cx) for k in hourly},
        "daily": {
            "dates": [d["date"] for d in run.meta["days"]],
            "fine_rain": run.series("fine", "rain24", iy, ix),
            "coarse_rain": run.series("coarse", "rain24", cy, cx),
        },
        "temperature_components": explanation["temperature_components"],
    }


def forecast(ctx: Context, lat: float, lon: float, run: Run) -> dict:
    """Days 1-2 and the hours from the 2.2 km forecast; days 3-10, pressure and the clear-sky UV
    index from MET Norway; PM2.5 from the nearest Air4Thai station; sun and moon computed. Each hour
    and day carries a condition code (clear, partly_cloudy, rain, thunderstorm, ...) for an icon."""
    from ..extras import forecast as fx

    static = load_static()
    fine = run.fine_grid
    if not fine.contains(lat, lon):
        raise ProductError(422, detail="location outside the forecast domain")
    iy, ix = fine.index(lat, lon)
    pidx = int(static.province[iy, ix])
    layers = ("temp", "heat", "rh", "rain", "pop", "storm", "wind", "wind_dir", "cloud")
    series = {k: run.series("fine", k, iy, ix) for k in layers}
    met_client = getattr(ctx.state, "met", None)
    air_service = getattr(ctx.state, "air", None)
    met_data = met_client.get(lat, lon) if met_client else None
    air = air_service.nearest(lat, lon) if air_service else None
    body = fx.build(run.times, series, float(fine.lats[iy]), float(fine.lons[ix]), met_data, air)
    return {
        "run_id": run.run_id,
        "location": {
            "lat": round(float(fine.lats[iy]), 4),
            "lon": round(float(fine.lons[ix]), 4),
            "province": static.provinces[pidx - 1] if pidx else None,
            "elevation": round(float(static.elev_land[iy, ix])),
        },
        **body,
    }


def air_forecast(ctx: Context) -> Product:
    """Hourly PM2.5 (µg/m³) on SILAM's 0.2° grid over Thailand for the next 72 hours: one base64 byte per
    cell, rows from the south, adjusted to the Air4Thai stations' latest readings (fading with distance
    and lead time; `stations_used` says how many). Refreshed every 3 hours; 503 until the first fetch."""
    from ..extras.pmforecast import adjust, to_json

    svc = getattr(ctx.state, "pm", None)
    if svc is None or svc.field is None:
        raise ProductError(503, detail="PM2.5 forecast not available yet")
    air = getattr(ctx.state, "air", None)
    readings = [(r.lat, r.lon, r.pm25, r.time) for r in air.readings] if air else []
    field, used = adjust(svc.field, readings)
    body = {"updated": svc.updated.isoformat() if svc.updated else None, "stations_used": used, **to_json(field)}
    return Product(
        json.dumps(body, ensure_ascii=False),
        media_type="application/json",
        headers={"Cache-Control": "public, max-age=900"},
    )


def air_stations(ctx: Context) -> Product:
    """Each station's latest hour (under 6 h old): PM2.5 µg/m³, AQI and the PCD level and colour.
    Refreshed every 20 minutes; empty when the source is unreachable."""
    svc = getattr(ctx.state, "air", None)
    body = {
        "updated": svc.updated.isoformat() if svc and svc.updated else None,
        "stations": svc.all() if svc else [],
        "attribution": {"name": "Air4Thai, กรมควบคุมมลพิษ", "url": "https://air4thai.pcd.go.th"},
    }
    return Product(
        json.dumps(body, ensure_ascii=False),
        media_type="application/json",
        headers={"Cache-Control": "public, max-age=300"},
    )


def verification() -> Product:
    """The verify service's hourly report as data (forecast vs. station reports over 30 days, and what
    the forecast has learned from them). 404 until the first report exists."""
    p = FsPath(get_settings().data_dir) / "verification" / "report.json"
    try:
        body = p.read_bytes()
    except OSError as exc:
        raise ProductError(404, detail="no verification report yet") from exc
    return Product(body, media_type="application/json", headers={"Cache-Control": "public, max-age=300"})


def _day_coverage(run: Run) -> dict[str, dict]:
    """Per forecast day: hours covered, ``partial`` flag and the Thai local
    time of the first/last step.  Derived from the step times, so runs made
    before these fields existed report them too."""
    out: dict[str, dict] = {}
    for iso in run.meta["times"]:
        t = datetime.fromisoformat(iso)
        d = out.setdefault(thai_date(t), {"date": thai_date(t), "hours": 0, "since": thai_hhmm(t)})
        d["hours"] += 1
        d["until"] = thai_hhmm(t)
    for d in out.values():
        d["partial"] = is_partial(d["hours"])
    return out


def _province_days(run: Run, i: int) -> list[dict]:
    cover = _day_coverage(run)
    out = []
    for day in run.provinces["days"]:
        c = cover.get(day["date"], {})
        out.append({**normalise_day(day["provinces"][i]), "since": c.get("since"), "until": c.get("until")})
    return out


def provinces(run: Run) -> dict:
    static = load_static()
    return {
        "run_id": run.run_id,
        "provinces": [{**p, "days": _province_days(run, i)} for i, p in enumerate(static.provinces)],
    }


def province(pid: str, run: Run) -> dict:
    static = load_static()
    p = static.province_by_id(pid)
    if p is None:
        raise ProductError(404, detail="unknown province")
    i = p["index"] - 1
    steps = run.provinces["steps"]
    return {
        **p,
        "run_id": run.run_id,
        "times": run.meta["times"],
        "hourly": {k: [row[i] for row in v] for k, v in steps.items()},
        "days": _province_days(run, i),
    }


def alerts(run: Run, min_severity: int = 1) -> dict:
    static = load_static()
    cover = _day_coverage(run)
    out = []
    for day in run.provinces["days"]:
        c = cover.get(day["date"], {})
        for p, summary in zip(static.provinces, day["provinces"], strict=False):
            hits = [a for a in province_alerts(summary) if a["severity"] >= min_severity]
            if hits:
                out.append(
                    {
                        "date": day["date"],
                        "partial": c.get("partial", False),
                        "until": c.get("until"),
                        "province": {k: p[k] for k in ("id", "name_th", "name_en", "region", "lat", "lon")},
                        "alerts": hits,
                    }
                )
    out.sort(key=lambda a: (a["date"], -max(x["severity"] for x in a["alerts"])))
    return {"run_id": run.run_id, "demo": run.meta["demo"], "alerts": out}


class ObservationIn(BaseModel):
    station_id: str = Field(..., max_length=64)
    lat: float = Field(..., ge=-90, le=90)
    lon: float = Field(..., ge=-180, le=180)
    time: datetime
    t2m: float = Field(..., ge=-30, le=60, description="2 m air temperature (°C)")
    elevation: float | None = Field(None, ge=-100, le=9000)


def ingest_observations(items: list[ObservationIn], ctx: Context) -> dict:
    obs = [Observation(**o.model_dump()) for o in items]
    for o in obs:
        if o.time.tzinfo is None:
            raise ProductError(422, detail="observation times must include a timezone")
    total = ctx.state.observations.add(obs)
    return {"accepted": len(obs), "buffered": total, "applied_on": "next forecast run"}


def trigger_run(ctx: Context) -> dict:
    ctx.state.refresher.trigger()
    return {"status": "scheduled"}


ATTRIBUTION = [
    {"name": "RainViewer", "url": "https://www.rainviewer.com"},
    {"name": "GDACS", "url": "https://www.gdacs.org"},
]


def _cyclones_for(ctx: Context, lat: float, lon: float, now: datetime) -> list[dict]:
    out = []
    for c in ctx.state.nowcast.snapshot().cyclones:
        here = position_at(c, now)
        out.append(
            {
                "id": c.id,
                "name": c.name,
                "source": c.source,
                "category": c.category,
                "peak_category": c.peak_category,
                "max_wind_kmh": c.max_wind_kmh,
                "report_url": c.report_url,
                "position": {"lat": round(here[0], 2), "lon": round(here[1], 2)},
                **proximity(c, lat, lon, now),
            }
        )
    return sorted(out, key=lambda c: c["distance_now_km"])


def nowcast(ctx: Context, lat: float, lon: float) -> dict:
    """Radar-based 0-60 min rain/storm nowcast for a point, plus active tropical cyclones."""
    service = ctx.state.nowcast
    if not service.grid.contains(lat, lon):
        raise ProductError(422, detail="location outside the nowcast domain")
    now = datetime.now(UTC)
    snap = service.snapshot()
    out: dict = {
        "available": False,
        "reason": None,
        "frame_time": snap.frame_time.isoformat() if snap.frame_time else None,
        "age_min": None,
        "now": None,
        "eta_rain": None,
        "eta_storm": None,
        "nearest": None,
        "rain_spell": None,
        "motion": None,
        "cyclones": _cyclones_for(ctx, lat, lon, now),
        "attribution": ATTRIBUTION,
    }
    if not service.radar_enabled:
        out["reason"] = "disabled"
        return out
    if snap.frame_time is None or snap.latest is None:
        out["reason"] = "no_data"
        return out
    out["age_min"] = round((now - snap.frame_time).total_seconds() / 60.0)
    if out["age_min"] > STALE_AFTER_MIN:
        out["reason"] = "stale"
        return out
    iy, ix = service.grid.index(lat, lon)
    if snap.coverage is not None and (not snap.coverage[iy, ix]):
        out["reason"] = "no_coverage"
        return out
    out.update(point_nowcast(snap.latest, snap.u, snap.v, service.grid, lat, lon, snap.coverage))
    out["available"] = True
    return out


def nowcast_layer(ctx: Context, lead: int = 0) -> Product:
    """Radar reflectivity as uint8 (``linear`` -10..75 dBZ, 0 = no echo), advected ``lead`` min ahead."""
    service = ctx.state.nowcast
    snap = service.snapshot()
    if not service.radar_enabled or snap.frame_time is None or lead not in snap.layers:
        raise ProductError(404, detail="radar layer not available")
    if (datetime.now(UTC) - snap.frame_time).total_seconds() / 60.0 > STALE_AFTER_MIN:
        raise ProductError(404, detail="radar layer is stale")
    frame = snap.frame_time.isoformat()
    extra = {
        "Cache-Control": "public, max-age=60",
        "X-Frame-Time": frame,
        "X-Lead": str(lead),
        "X-Enc-Min": str(RADAR_ENCODING.min),
        "X-Enc-Max": str(RADAR_ENCODING.max),
        "Access-Control-Expose-Headers": "X-Grid-NY, X-Grid-NX, X-Frame-Time, X-Lead, X-Enc-Min, X-Enc-Max",
    }
    return _binary(snap.layers[lead], f"nowcast-{frame}-{lead}", ctx, extra)


def _frame_id(t: datetime) -> str:
    return str(int(t.timestamp()))


def nowcast_frames(ctx: Context) -> dict:
    """Observed radar frames of the last ~hour for playback, oldest first (ids are stable unix times).

    Listed from the same snapshot that ``/nowcast/frame/{id}`` serves, so an id stays valid until the
    frame ages out (then 404).  ``stale`` is true when the newest frame is too old to call "latest".
    """
    service = ctx.state.nowcast
    snap = service.snapshot()
    out: dict = {"frames": [], "latest": None, "stale": False, "age_min": None, "attribution": ATTRIBUTION}
    if not service.radar_enabled:
        out["reason"] = "disabled"
        return out
    if not snap.history:
        out["reason"] = "no_data"
        return out
    newest = snap.history[-1][0]
    age = (datetime.now(UTC) - newest).total_seconds() / 60.0
    out.update(
        frames=[{"id": _frame_id(t), "time": t.isoformat()} for t, _ in snap.history],
        latest=_frame_id(newest),
        age_min=round(age),
        stale=age > STALE_AFTER_MIN,
    )
    return out


def nowcast_frame(frame_id: str, ctx: Context) -> Product:
    """One observed radar frame as uint8 (same encoding as ``/nowcast/layer``); 404 once it aged out."""
    snap = ctx.state.nowcast.snapshot()
    for t, codes in snap.history:
        if _frame_id(t) == frame_id:
            extra = {
                "Cache-Control": "public, max-age=3600, immutable",
                "X-Frame-Time": t.isoformat(),
                "X-Lead": "0",
                "X-Enc-Min": str(RADAR_ENCODING.min),
                "X-Enc-Max": str(RADAR_ENCODING.max),
                "Access-Control-Expose-Headers": "X-Grid-NY, X-Grid-NX, X-Frame-Time, X-Lead, X-Enc-Min, X-Enc-Max",
            }
            return _binary(codes, f"radar-{frame_id}", ctx, extra)
    raise ProductError(404, detail="radar frame not available")


def nowcast_status(ctx: Context) -> dict:
    return {**ctx.state.nowcast.status, "leads": list(LEADS), "stale_after_min": STALE_AFTER_MIN}


MAX_PUSH_BODY = 4096


def _push(ctx: Context) -> PushService:
    service = ctx.state.push
    if service is None:
        raise ProductError(404, detail="push notifications are disabled")
    return service


class PushKeys(BaseModel):
    p256dh: str = Field(min_length=1, max_length=200)
    auth: str = Field(min_length=1, max_length=64)


class PushSubscription(BaseModel):
    """The browser's ``PushSubscription.toJSON()``."""

    endpoint: str = Field(min_length=1, max_length=MAX_ENDPOINT_LEN)
    keys: PushKeys


class PushPrefs(BaseModel):
    storm: bool = True
    heavy_rain: bool = True
    cyclone: bool = True
    quiet_start: int = Field(22, ge=0, le=23)
    quiet_end: int = Field(6, ge=0, le=23)
    heat: bool = False


class PushSubscribe(BaseModel):
    subscription: PushSubscription
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    label: str = Field("", max_length=MAX_LABEL_LEN)
    prefs: PushPrefs = PushPrefs()


def _checked(sub: PushSubscription) -> PushSubscription:
    try:
        validate_endpoint(sub.endpoint)
        if len(b64url_decode(sub.keys.p256dh)) != 65 or len(b64url_decode(sub.keys.auth)) < 16:
            raise PushError("invalid subscription keys")
    except (ValueError, binascii.Error):
        raise ProductError(422, detail="invalid subscription keys") from None
    except PushError as exc:
        raise ProductError(exc.status, detail=str(exc)) from None
    return sub


def push_public_key(ctx: Context) -> dict:
    return {"public_key": _push(ctx).keys.public}


def push_subscribe(body: PushSubscribe, ctx: Context) -> dict:
    """Register (or update, when the endpoint + auth secret match) a subscription for a location."""
    service = _push(ctx)
    _checked(body.subscription)
    if not ctx.state.nowcast.grid.contains(body.lat, body.lon):
        raise ProductError(422, detail="location outside the supported domain")
    p = body.prefs
    try:
        sub = service.store.upsert(
            body.subscription.endpoint,
            body.subscription.keys.p256dh,
            body.subscription.keys.auth,
            body.lat,
            body.lon,
            body.label,
            Prefs(p.storm, p.heavy_rain, p.cyclone, p.quiet_start, p.quiet_end, p.heat),
        )
    except PushError as exc:
        raise ProductError(exc.status, detail=str(exc)) from None
    return {"id": sub.id, "lat": sub.lat, "lon": sub.lon, "label": sub.label, "prefs": asdict(sub.prefs)}


def push_unsubscribe(body: PushSubscription, ctx: Context) -> dict:
    service = _push(ctx)
    _checked(body)
    stored = service.store.by_endpoint(body.endpoint)
    if stored is None:
        return {"ok": True, "deleted": False}
    if not auth_matches(stored, body.keys.auth):
        raise ProductError(403, detail="subscription credentials do not match")
    return {"ok": True, "deleted": service.store.delete(stored.id)}


def push_status(ctx: Context) -> dict:
    service = ctx.state.push
    return {"enabled": False} if service is None else service.status()
