"""Thin ASGI compatibility adapter and contract oracle for the Rust migration."""

from fastapi import APIRouter, Depends, Header, HTTPException, Path, Query, Request, Response
from fastapi.responses import FileResponse

from app.config import get_settings
from app.engine import products
from app.engine.types import Context, Product, ProductError
from app.store import Run

router = APIRouter(prefix="/api/v1")
ObservationIn = products.ObservationIn
PushSubscribe = products.PushSubscribe
PushSubscription = products.PushSubscription
MAX_PUSH_BODY = products.MAX_PUSH_BODY


def _call(operation, **kwargs):
    request = kwargs.pop("request", None)
    if request is not None:
        kwargs["ctx"] = Context(request.app.state, dict(request.headers))
    response = kwargs.pop("response", None)
    try:
        result = getattr(products, operation)(**kwargs)
    except ProductError as exc:
        raise HTTPException(exc.status_code, detail=exc.detail) from None
    if response is not None:
        response.headers["Cache-Control"] = "public, max-age=3600"
    if isinstance(result, Product):
        return Response(
            result.body, status_code=result.status_code, headers=result.headers, media_type=result.media_type
        )
    return result


def current_run(request: Request) -> Run:
    return _call("current_run", request=request)


def require_admin(authorization: str | None = Header(default=None)) -> None:
    token = get_settings().admin_token
    if token and authorization != f"Bearer {token}":
        raise HTTPException(401, detail="admin token required")


def _limit_body(content_length: int | None = Header(default=None)) -> None:
    if content_length is not None and content_length > MAX_PUSH_BODY:
        raise HTTPException(413, detail="request body too large")


@router.get("/health", tags=["status"], summary="Service health and the current forecast run")
def health(request: Request) -> dict:
    return _call("health", request=request)


@router.get(
    "/meta", tags=["forecast"], summary="Current run, layers with their encodings, colour scales and the 2 km grid"
)
def meta(request: Request) -> dict:
    return _call("meta", request=request)


@router.get("/places", tags=["locations"], summary="Search Thai provinces, districts and populated places (GeoNames)")
def places(
    response: Response, q: str = Query("", max_length=80, description="Thai or English name, at least 2 characters")
) -> dict:
    return _call("places", response=response, q=q)


@router.get("/layers/{layer}", include_in_schema=False)
def layer(
    layer: str,
    request: Request,
    step: int = 0,
    day: int = 0,
    res: str = Query("fine", pattern="^(fine|coarse)$"),
    run: Run = Depends(current_run),
) -> Response:
    return _call("layer", layer=layer, request=request, step=step, day=day, res=res, run=run)


@router.get("/static/{name}", include_in_schema=False)
def static_layer(name: str, request: Request) -> Response:
    return _call("static_layer", name=name, request=request)


@router.get("/geo/{name}", include_in_schema=False)
def geo(name: str) -> FileResponse:
    return _call("geo", name=name)


@router.get("/point", tags=["forecast"], summary="Hourly 2 km forecast (and the raw ~25 km model) for one location")
def point(
    lat: float = Query(..., ge=-90, le=90, description="latitude, WGS84 (Thailand: 5.5-20.5)"),
    lon: float = Query(..., ge=-180, le=180, description="longitude, WGS84 (Thailand: 97.3-105.7)"),
    run: Run = Depends(current_run),
) -> dict:
    return _call("point", lat=lat, lon=lon, run=run)


@router.get(
    "/forecast",
    tags=["forecast"],
    summary="A weather app's view of one place: now, 48 hours, 10 days, sun, moon, PM2.5",
)
def forecast(
    request: Request,
    lat: float = Query(..., ge=-90, le=90, description="latitude, WGS84 (Thailand: 5.5-20.5)"),
    lon: float = Query(..., ge=-180, le=180, description="longitude, WGS84 (Thailand: 97.3-105.7)"),
    run: Run = Depends(current_run),
) -> dict:
    """Days 1-2 and the hours from the 2.2 km forecast; days 3-10, pressure and the clear-sky UV
    index from MET Norway; PM2.5 from the nearest Air4Thai station; sun and moon computed. Each hour
    and day carries a condition code (clear, partly_cloudy, rain, thunderstorm, ...) for an icon."""
    return _call("forecast", request=request, lat=lat, lon=lon, run=run)


@router.get("/air/forecast", tags=["air"], summary="PM2.5 forecast field over Thailand (FMI SILAM, 0.2°, hourly, 72 h)")
def air_forecast(request: Request) -> Response:
    """Hourly PM2.5 (µg/m³) on SILAM's 0.2° grid over Thailand for the next 72 hours: one base64 byte per
    cell, rows from the south, adjusted to the Air4Thai stations' latest readings (fading with distance
    and lead time; `stations_used` says how many). Refreshed every 3 hours; 503 until the first fetch."""
    return _call("air_forecast", request=request)


@router.get("/air/stations", tags=["air"], summary="PM2.5 now at every Air4Thai station (Pollution Control Department)")
def air_stations(request: Request) -> Response:
    """Each station's latest hour (under 6 h old): PM2.5 µg/m³, AQI and the PCD level and colour.
    Refreshed every 20 minutes; empty when the source is unreachable."""
    return _call("air_stations", request=request)


@router.get(
    "/verification", tags=["status"], summary="How accurate the forecast has been: the latest verification report"
)
def verification() -> Response:
    """The verify service's hourly report as data (forecast vs. station reports over 30 days, and what
    the forecast has learned from them). 404 until the first report exists."""
    return _call("verification")


@router.get("/provinces", tags=["provinces"], summary="Daily summary for all 77 provinces")
def provinces(run: Run = Depends(current_run)) -> dict:
    return _call("provinces", run=run)


@router.get("/provinces/{pid}", tags=["provinces"], summary="Hourly and daily forecast for one province")
def province(
    pid: str = Path(..., description="province id from /provinces, e.g. TH-10"), run: Run = Depends(current_run)
) -> dict:
    return _call("province", pid=pid, run=run)


@router.get("/alerts", tags=["alerts"], summary="Province alerts (heavy rain, storms, wind, heat, cold, frost) by day")
def alerts(
    min_severity: int = Query(1, ge=1, le=3, description="1 yellow (watch), 2 orange (warning), 3 red (danger)"),
    run: Run = Depends(current_run),
) -> dict:
    return _call("alerts", min_severity=min_severity, run=run)


@router.post("/observations", dependencies=[Depends(require_admin)], include_in_schema=False)
def ingest_observations(items: list[ObservationIn], request: Request) -> dict:
    return _call("ingest_observations", items=items, request=request)


@router.post("/runs", status_code=202, dependencies=[Depends(require_admin)], include_in_schema=False)
def trigger_run(request: Request) -> dict:
    return _call("trigger_run", request=request)


@router.get("/nowcast", tags=["nowcast"], summary="Radar nowcast 0-60 min for a point, plus active tropical cyclones")
def nowcast(
    request: Request,
    lat: float = Query(..., ge=-90, le=90, description="latitude, WGS84 (Thailand: 5.5-20.5)"),
    lon: float = Query(..., ge=-180, le=180, description="longitude, WGS84 (Thailand: 97.3-105.7)"),
) -> dict:
    """Radar-based 0-60 min rain/storm nowcast for a point, plus active tropical cyclones."""
    return _call("nowcast", request=request, lat=lat, lon=lon)


@router.get("/nowcast/layer", include_in_schema=False)
def nowcast_layer(request: Request, lead: int = Query(0, ge=0, le=60)) -> Response:
    """Radar reflectivity as uint8 (``linear`` -10..75 dBZ, 0 = no echo), advected ``lead`` min ahead."""
    return _call("nowcast_layer", request=request, lead=lead)


@router.get("/nowcast/frames", include_in_schema=False)
def nowcast_frames(request: Request) -> dict:
    """Observed radar frames of the last ~hour for playback, oldest first (ids are stable unix times).

    Listed from the same snapshot that ``/nowcast/frame/{id}`` serves, so an id stays valid until the
    frame ages out (then 404).  ``stale`` is true when the newest frame is too old to call "latest".
    """
    return _call("nowcast_frames", request=request)


@router.get("/nowcast/frame/{frame_id}", include_in_schema=False)
def nowcast_frame(frame_id: str, request: Request) -> Response:
    """One observed radar frame as uint8 (same encoding as ``/nowcast/layer``); 404 once it aged out."""
    return _call("nowcast_frame", frame_id=frame_id, request=request)


@router.get("/nowcast/status", include_in_schema=False)
def nowcast_status(request: Request) -> dict:
    return _call("nowcast_status", request=request)


@router.get("/push/public-key", include_in_schema=False)
def push_public_key(request: Request) -> dict:
    return _call("push_public_key", request=request)


@router.post("/push/subscribe", dependencies=[Depends(_limit_body)], include_in_schema=False)
def push_subscribe(body: PushSubscribe, request: Request) -> dict:
    """Register (or update, when the endpoint + auth secret match) a subscription for a location."""
    return _call("push_subscribe", body=body, request=request)


@router.post("/push/unsubscribe", dependencies=[Depends(_limit_body)], include_in_schema=False)
def push_unsubscribe(body: PushSubscription, request: Request) -> dict:
    return _call("push_unsubscribe", body=body, request=request)


@router.get("/push/status", dependencies=[Depends(require_admin)], include_in_schema=False)
def push_status(request: Request) -> dict:
    return _call("push_status", request=request)
