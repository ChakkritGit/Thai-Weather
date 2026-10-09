from __future__ import annotations

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
from ..products.aggregate import thai_date, thai_hhmm
from ..products.alerts import is_partial, normalise_day, province_alerts
from ..products.scales import weather_scales
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
        "run": {**run.meta, "days": list(_day_coverage(run).values())} if run else None,
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
def alerts(min_severity: int = Query(1, ge=1, le=3), run: Run = Depends(current_run)) -> dict:
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
