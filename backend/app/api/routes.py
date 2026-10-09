from __future__ import annotations

import binascii
import math
import time
from dataclasses import asdict
from datetime import UTC, datetime
from functools import cache

import numpy as np
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from ..config import get_settings
from ..core.provinces_meta import REGIONS
from ..core.static import DATA_DIR, load_static
from ..downscale.layers import LAYERS
from ..downscale.observations import Observation
from ..downscale.pipeline import explain_point
from ..nowcast.cyclones import position_at, proximity
from ..nowcast.nowcast import point_nowcast
from ..nowcast.service import LEADS, RADAR_ENCODING, STALE_AFTER_MIN
from ..products.scales import weather_scales
from ..push.messages import with_label
from ..push.sender import PushFailed, PushGone
from ..push.service import PushService
from ..push.store import MAX_ENDPOINT_LEN, MAX_LABEL_LEN, Prefs, PushError, auth_matches, validate_endpoint
from ..push.vapid import b64url_decode
from ..store import Run

router = APIRouter(prefix="/api/v1")


def current_run(request: Request) -> Run:
    run = request.app.state.store.latest()
    if run is None:
        raise HTTPException(503, detail="The first forecast run is still being computed – try again shortly.")
    return run


def require_admin(authorization: str | None = Header(default=None)) -> None:
    token = get_settings().admin_token
    if token and authorization != f"Bearer {token}":
        raise HTTPException(401, detail="admin token required")


def _binary(data: np.ndarray, etag: str, request: Request, extra: dict | None = None) -> Response:
    headers = {
        "ETag": f'"{etag}"',
        "Cache-Control": "public, max-age=900",
        "X-Grid-NY": str(data.shape[0]),
        "X-Grid-NX": str(data.shape[1]),
        "Access-Control-Expose-Headers": "X-Grid-NY, X-Grid-NX, X-Run-Id",
        **(extra or {}),
    }
    if request.headers.get("if-none-match") == headers["ETag"]:
        return Response(status_code=304, headers=headers)
    return Response(np.ascontiguousarray(data).tobytes(), media_type="application/octet-stream", headers=headers)


# ------------------------------------------------------------------ meta
@router.get("/health")
def health(request: Request) -> dict:
    run = request.app.state.store.latest()
    return {
        "ok": True,
        "run": run.run_id if run else None,
        "refresher": request.app.state.refresher.status,
        "nowcast": request.app.state.nowcast.status,
    }


@router.get("/meta")
def meta(request: Request) -> dict:
    run = request.app.state.store.latest()
    static = load_static()
    return {
        "status": request.app.state.refresher.status,
        "run": run.meta if run else None,
        "layers": [lyr.describe() for lyr in LAYERS.values()],
        "regions": [{"id": k, "name_th": v[0], "name_en": v[1]} for k, v in REGIONS.items()],
        "scales": weather_scales(),
        "fine_grid": static.grid.describe(),
    }


# ---------------------------------------------------------------- layers
@router.get("/layers/{layer}")
def layer(
    layer: str,
    request: Request,
    step: int = 0,
    day: int = 0,
    res: str = Query("fine", pattern="^(fine|coarse)$"),
    run: Run = Depends(current_run),
) -> Response:
    if layer not in LAYERS:
        raise HTTPException(404, detail=f"unknown layer {layer}")
    arr = run.array(res, layer)
    i = day if LAYERS[layer].daily else step
    if not 0 <= i < arr.shape[0]:
        raise HTTPException(404, detail="time index out of range")
    return _binary(np.asarray(arr[i]), f"{run.run_id}-{res}-{layer}-{i}", request, {"X-Run-Id": run.run_id})


@cache
def _hillshade() -> np.ndarray:
    static = load_static()
    z = static.elev_land
    dzdy = np.gradient(z, axis=0) / static.dy_m
    dzdx = np.gradient(z, axis=1) / static.dx_m[:, None]
    # light from the north-west, 45° altitude; north is +y on our grid
    az, alt = np.radians(315.0), np.radians(45.0)
    slope = np.arctan(2.5 * np.hypot(dzdx, dzdy))
    aspect = np.arctan2(-dzdx, -dzdy)
    shade = np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect)
    # 0 on flat ground, increasing on slopes facing away from the light
    shade = np.clip((np.sin(alt) - shade) / np.sin(alt), 0, 1) * 255
    return np.where(static.land, shade, 0).astype(np.uint8)


@router.get("/static/{name}")
def static_layer(name: str, request: Request) -> Response:
    static = load_static()
    if name == "hillshade":
        data = _hillshade()
    elif name == "thai":
        data = static.thai.astype(np.uint8)
    elif name == "elevation":  # 0..255 → 0..2550 m
        data = np.clip(static.elev_land / 10.0, 0, 255).astype(np.uint8)
    else:
        raise HTTPException(404, detail="unknown static layer")
    return _binary(data, f"static-{name}-v2", request)


@router.get("/geo/{name}")
def geo(name: str) -> FileResponse:
    if name not in ("provinces", "countries"):
        raise HTTPException(404)
    return FileResponse(DATA_DIR / "geo" / f"{name}.geojson", media_type="application/geo+json")


# ----------------------------------------------------------------- point
@router.get("/point")
def point(
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
    run: Run = Depends(current_run),
) -> dict:
    static = load_static()
    fine = run.fine_grid
    if not fine.contains(lat, lon):
        raise HTTPException(422, detail="location outside the forecast domain")
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


# ------------------------------------------------------------- provinces
def _province_days(run: Run, i: int) -> list[dict]:
    return [d["provinces"][i] for d in run.provinces["days"]]


@router.get("/provinces")
def provinces(run: Run = Depends(current_run)) -> dict:
    static = load_static()
    return {
        "run_id": run.run_id,
        "provinces": [{**p, "days": _province_days(run, i)} for i, p in enumerate(static.provinces)],
    }


@router.get("/provinces/{pid}")
def province(pid: str, run: Run = Depends(current_run)) -> dict:
    static = load_static()
    p = static.province_by_id(pid)
    if p is None:
        raise HTTPException(404, detail="unknown province")
    i = p["index"] - 1
    steps = run.provinces["steps"]
    return {
        **p,
        "run_id": run.run_id,
        "times": run.meta["times"],
        "hourly": {k: [row[i] for row in v] for k, v in steps.items()},
        "days": _province_days(run, i),
    }


@router.get("/alerts")
def alerts(min_severity: int = Query(2, ge=1, le=3), run: Run = Depends(current_run)) -> dict:
    static = load_static()
    out = []
    for day in run.provinces["days"]:
        for p, summary in zip(static.provinces, day["provinces"], strict=False):
            hits = [a for a in summary["alerts"] if a["severity"] >= min_severity]
            if hits:
                out.append(
                    {
                        "date": day["date"],
                        "province": {k: p[k] for k in ("id", "name_th", "name_en", "region", "lat", "lon")},
                        "alerts": hits,
                    }
                )
    out.sort(key=lambda a: (a["date"], -max(x["severity"] for x in a["alerts"])))
    return {"run_id": run.run_id, "demo": run.meta["demo"], "alerts": out}


# ------------------------------------------------------- admin / ingest
class ObservationIn(BaseModel):
    station_id: str = Field(..., max_length=64)
    lat: float = Field(..., ge=-90, le=90)
    lon: float = Field(..., ge=-180, le=180)
    time: datetime
    t2m: float = Field(..., ge=-30, le=60, description="2 m air temperature (°C)")
    elevation: float | None = Field(None, ge=-100, le=9000)


@router.post("/observations", dependencies=[Depends(require_admin)])
def ingest_observations(items: list[ObservationIn], request: Request) -> dict:
    obs = [Observation(**o.model_dump()) for o in items]
    for o in obs:
        if o.time.tzinfo is None:
            raise HTTPException(422, detail="observation times must include a timezone")
    total = request.app.state.observations.add(obs)
    return {"accepted": len(obs), "buffered": total, "applied_on": "next forecast run"}


@router.post("/runs", status_code=202, dependencies=[Depends(require_admin)])
def trigger_run(request: Request) -> dict:
    request.app.state.refresher.trigger()
    return {"status": "scheduled"}


# --------------------------------------------------------------- nowcast
ATTRIBUTION = [
    {"name": "RainViewer", "url": "https://www.rainviewer.com"},
    {"name": "GDACS", "url": "https://www.gdacs.org"},
]


def _cyclones_for(request: Request, lat: float, lon: float, now: datetime) -> list[dict]:
    out = []
    for c in request.app.state.nowcast.snapshot().cyclones:
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


@router.get("/nowcast")
def nowcast(
    request: Request,
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
) -> dict:
    """Radar-based 0-60 min rain/storm nowcast for a point, plus active tropical cyclones."""
    service = request.app.state.nowcast
    if not service.grid.contains(lat, lon):
        raise HTTPException(422, detail="location outside the nowcast domain")
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
        "motion": None,
        "cyclones": _cyclones_for(request, lat, lon, now),
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
    if snap.coverage is not None and not snap.coverage[iy, ix]:
        out["reason"] = "no_coverage"
        return out
    out.update(point_nowcast(snap.latest, snap.u, snap.v, service.grid, lat, lon, snap.coverage))
    out["available"] = True
    return out


@router.get("/nowcast/layer")
def nowcast_layer(request: Request, lead: int = Query(0, ge=0, le=60)) -> Response:
    """Radar reflectivity as uint8 (``linear`` -10..75 dBZ, 0 = no echo), advected ``lead`` min ahead."""
    service = request.app.state.nowcast
    snap = service.snapshot()
    if not service.radar_enabled or snap.frame_time is None or lead not in snap.layers:
        raise HTTPException(404, detail="radar layer not available")
    if (datetime.now(UTC) - snap.frame_time).total_seconds() / 60.0 > STALE_AFTER_MIN:
        raise HTTPException(404, detail="radar layer is stale")
    frame = snap.frame_time.isoformat()
    extra = {
        "Cache-Control": "public, max-age=60",
        "X-Frame-Time": frame,
        "X-Lead": str(lead),
        "X-Enc-Min": str(RADAR_ENCODING.min),
        "X-Enc-Max": str(RADAR_ENCODING.max),
        "Access-Control-Expose-Headers": "X-Grid-NY, X-Grid-NX, X-Frame-Time, X-Lead, X-Enc-Min, X-Enc-Max",
    }
    return _binary(snap.layers[lead], f"nowcast-{frame}-{lead}", request, extra)


@router.get("/nowcast/status")
def nowcast_status(request: Request) -> dict:
    return {**request.app.state.nowcast.status, "leads": list(LEADS), "stale_after_min": STALE_AFTER_MIN}


# ------------------------------------------------------------------ web push
MAX_PUSH_BODY = 4096


def _limit_body(content_length: int | None = Header(default=None)) -> None:
    if content_length is not None and content_length > MAX_PUSH_BODY:
        raise HTTPException(413, detail="request body too large")


def _push(request: Request) -> PushService:
    service = request.app.state.push
    if service is None:
        raise HTTPException(404, detail="push notifications are disabled")
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
    quiet_start: int = Field(22, ge=0, le=23)  # local (Asia/Bangkok) hours; start == end disables quiet hours
    quiet_end: int = Field(6, ge=0, le=23)


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
        raise HTTPException(422, detail="invalid subscription keys") from None
    except PushError as exc:
        raise HTTPException(exc.status, detail=str(exc)) from None
    return sub


@router.get("/push/public-key")
def push_public_key(request: Request) -> dict:
    return {"public_key": _push(request).keys.public}


@router.post("/push/subscribe", dependencies=[Depends(_limit_body)])
def push_subscribe(body: PushSubscribe, request: Request) -> dict:
    """Register (or update, when the endpoint + auth secret match) a subscription for a location."""
    service = _push(request)
    _checked(body.subscription)
    if not request.app.state.nowcast.grid.contains(body.lat, body.lon):
        raise HTTPException(422, detail="location outside the supported domain")
    p = body.prefs
    try:
        sub = service.store.upsert(
            body.subscription.endpoint,
            body.subscription.keys.p256dh,
            body.subscription.keys.auth,
            body.lat,
            body.lon,
            body.label,
            Prefs(p.storm, p.heavy_rain, p.cyclone, p.quiet_start, p.quiet_end),
        )
    except PushError as exc:
        raise HTTPException(exc.status, detail=str(exc)) from None
    return {"id": sub.id, "lat": sub.lat, "lon": sub.lon, "label": sub.label, "prefs": asdict(sub.prefs)}


@router.post("/push/unsubscribe", dependencies=[Depends(_limit_body)])
def push_unsubscribe(body: PushSubscription, request: Request) -> dict:
    service = _push(request)
    _checked(body)
    stored = service.store.by_endpoint(body.endpoint)
    if stored is None:
        return {"ok": True, "deleted": False}  # idempotent
    if not auth_matches(stored, body.keys.auth):
        raise HTTPException(403, detail="subscription credentials do not match")
    return {"ok": True, "deleted": service.store.delete(stored.id)}


@router.post("/push/test", dependencies=[Depends(_limit_body)])
def push_test(body: PushSubscription, request: Request) -> dict:
    """Send a test notification to this one subscription (at most once a minute)."""
    service = _push(request)
    _checked(body)
    stored = service.store.by_endpoint(body.endpoint)
    if stored is None:
        raise HTTPException(404, detail="subscription not found")
    if not auth_matches(stored, body.keys.auth):
        raise HTTPException(403, detail="subscription credentials do not match")
    wait = service.store.claim_test(stored.id, time.time())
    if wait > 0:
        raise HTTPException(
            429,
            detail="test notifications are limited to one per minute",
            headers={"Retry-After": str(math.ceil(wait))},
        )
    payload = {
        "title": "ทดสอบการแจ้งเตือน",
        "body": with_label(stored.label, "ฟ้าละเอียดจะแจ้งเตือนเมื่อพายุฝนฟ้าคะนองหรือฝนหนักใกล้ถึงตำแหน่งนี้"),
        "lang": "th",
        "url": f"/?lat={stored.lat:.2f}&lon={stored.lon:.2f}",
        "tag": f"thwx-test-{stored.id[:8]}",
        "kind": "test",
    }
    try:
        service.sender(stored, payload, ttl=300, urgent=False)
    except PushGone:
        service.store.delete(stored.id)
        raise HTTPException(410, detail="subscription expired") from None
    except PushFailed:
        raise HTTPException(502, detail="push service rejected the notification") from None
    return {"ok": True}


@router.get("/push/status", dependencies=[Depends(require_admin)])
def push_status(request: Request) -> dict:
    service = request.app.state.push
    return {"enabled": False} if service is None else service.status()
