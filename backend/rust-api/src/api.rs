use crate::{
    engine::Engine,
    error::{ApiError, ApiResult},
    files,
    places::Places,
    quota::{Limiter, Tier},
};
use axum::{
    Json, Router,
    body::to_bytes,
    extract::{Path, Request, State},
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri},
    middleware::{self, Next},
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    env,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::Semaphore;
use tower_http::{
    compression::{CompressionLayer, predicate::SizeAbove},
    cors::{Any, CorsLayer},
};

#[derive(Clone)]
pub struct Config {
    pub data_dir: PathBuf,
    pub static_dir: PathBuf,
    pub admin_token: Option<String>,
    pub public: Tier,
    pub site: Tier,
    pub cors_origins: Vec<HeaderValue>,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        fn number(name: &str, default: u32) -> Result<u32, String> {
            match env::var(name) {
                Ok(value) => value
                    .parse::<u32>()
                    .ok()
                    .filter(|n| *n > 0)
                    .ok_or_else(|| format!("{name} must be a positive integer")),
                Err(env::VarError::NotPresent) => Ok(default),
                Err(_) => Err(format!("invalid {name}")),
            }
        }
        let origins: Vec<String> = serde_json::from_str(
            &env::var("THWX_CORS_ORIGINS").unwrap_or_else(|_| "[\"*\"]".into()),
        )
        .map_err(|_| "THWX_CORS_ORIGINS must be a JSON string array")?;
        Ok(Self {
            data_dir: env::var_os("THWX_DATA_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("var")),
            static_dir: env::var_os("THWX_STATIC_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("app/data")),
            admin_token: env::var("THWX_ADMIN_TOKEN").ok().filter(|v| !v.is_empty()),
            public: Tier {
                name: "public",
                per_min: number("THWX_RATE_PER_MIN", 60)?,
                per_day: number("THWX_RATE_PER_DAY", 5000)?,
            },
            site: Tier {
                name: "site",
                per_min: number("THWX_RATE_SITE_PER_MIN", 3000)?,
                per_day: number("THWX_RATE_SITE_PER_DAY", 200_000)?,
            },
            cors_origins: origins
                .iter()
                .map(|s| {
                    s.parse::<HeaderValue>()
                        .map_err(|_| "invalid CORS origin".to_string())
                })
                .collect::<Result<_, _>>()?,
        })
    }
}

pub struct AppState {
    pub config: Config,
    pub engine: Engine,
    pub places: Arc<Places>,
    pub searches: Arc<Semaphore>,
    pub limiter: Mutex<Limiter>,
}

impl AppState {
    pub fn new(config: Config, engine: Engine, places: Places) -> Arc<Self> {
        Arc::new(Self {
            config,
            engine,
            places: Arc::new(places),
            searches: Arc::new(Semaphore::new(8)),
            limiter: Mutex::new(Limiter::new(50_000)),
        })
    }
}

const EXPOSE: [&str; 13] = [
    "x-grid-ny",
    "x-grid-nx",
    "x-run-id",
    "x-frame-time",
    "x-lead",
    "x-enc-min",
    "x-enc-max",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
    "x-ratelimit-limit-day",
    "x-ratelimit-remaining-day",
    "retry-after",
];

pub fn router(state: Arc<AppState>) -> Router {
    let mut cors = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST])
        .allow_headers(Any)
        .expose_headers(EXPOSE.map(HeaderName::from_static))
        .max_age(std::time::Duration::from_secs(600));
    cors = if state
        .config
        .cors_origins
        .iter()
        .any(|v| v.as_bytes() == b"*")
    {
        cors.allow_origin(Any)
    } else {
        cors.allow_origin(state.config.cors_origins.clone())
    };
    let mut router = Router::new();
    for path in [
        "health",
        "meta",
        "provinces",
        "air/forecast",
        "air/stations",
        "nowcast/frames",
        "nowcast/status",
        "push/public-key",
        "push/status",
    ] {
        router = router.route(&format!("/api/v1/{path}"), get(simple));
    }
    router
        .route("/api/v1/places", get(places))
        .route("/api/v1/layers/{name}", get(layer))
        .route("/api/v1/static/{name}", get(static_layer))
        .route("/api/v1/geo/{name}", get(geo))
        .route("/api/v1/verification", get(verification))
        .route("/api/v1/openapi.json", get(openapi))
        .route("/api/v1/provinces/{pid}", get(province))
        .route("/api/v1/alerts", get(alerts))
        .route("/api/v1/point", get(coordinates))
        .route("/api/v1/forecast", get(coordinates))
        .route("/api/v1/nowcast", get(coordinates))
        .route("/api/v1/nowcast/layer", get(radar_layer))
        .route("/api/v1/nowcast/frame/{id}", get(radar_frame))
        .route("/api/v1/observations", post(mutation))
        .route("/api/v1/runs", post(mutation))
        .route("/api/v1/push/subscribe", post(mutation))
        .route("/api/v1/push/unsubscribe", post(mutation))
        .fallback(|| async { ApiError::detail(StatusCode::NOT_FOUND, "Not Found") })
        .method_not_allowed_fallback(|| async {
            ApiError::detail(StatusCode::METHOD_NOT_ALLOWED, "Method Not Allowed")
        })
        .layer(middleware::from_fn(canonical_path))
        .layer(middleware::from_fn_with_state(state.clone(), quota))
        .layer(CompressionLayer::new().compress_when(SizeAbove::new(1024)))
        .layer(cors)
        .with_state(state)
}

async fn canonical_path(request: Request, next: Next) -> Response {
    let path = request.uri().path();
    if path.ends_with('/') {
        let trimmed = path.trim_end_matches('/');
        let fixed = matches!(
            trimmed,
            "/api/v1/health"
                | "/api/v1/meta"
                | "/api/v1/places"
                | "/api/v1/point"
                | "/api/v1/forecast"
                | "/api/v1/verification"
                | "/api/v1/provinces"
                | "/api/v1/alerts"
                | "/api/v1/air/forecast"
                | "/api/v1/air/stations"
                | "/api/v1/observations"
                | "/api/v1/runs"
                | "/api/v1/nowcast"
                | "/api/v1/nowcast/layer"
                | "/api/v1/nowcast/frames"
                | "/api/v1/nowcast/status"
                | "/api/v1/push/public-key"
                | "/api/v1/push/status"
                | "/api/v1/push/subscribe"
                | "/api/v1/push/unsubscribe"
                | "/api/v1/openapi.json"
        );
        let parameterized = [
            "/api/v1/layers/",
            "/api/v1/static/",
            "/api/v1/geo/",
            "/api/v1/provinces/",
            "/api/v1/nowcast/frame/",
        ]
        .iter()
        .any(|prefix| {
            trimmed
                .strip_prefix(prefix)
                .is_some_and(|tail| !tail.is_empty() && !tail.contains('/'))
        });
        if fixed || parameterized {
            let mut target = trimmed.to_owned();
            if let Some(query) = request.uri().query() {
                target.push('?');
                target.push_str(query);
            }
            return Redirect::temporary(&target).into_response();
        }
    }
    next.run(request).await
}

fn params(uri: &Uri) -> Result<HashMap<String, String>, ApiError> {
    let query = uri.query().unwrap_or("");
    if query.len() > 8192 {
        return Err(ApiError::detail(StatusCode::URI_TOO_LONG, "query too long"));
    }
    Ok(form_urlencoded::parse(query.as_bytes())
        .into_owned()
        .collect())
}

fn integer(p: &HashMap<String, String>, name: &str, default: i64) -> Result<i64, ApiError> {
    p.get(name).map_or(Ok(default), |v| {
        let value = v.trim();
        let integer = if let Some((whole, fraction)) = value.split_once('.') {
            if fraction.is_empty() || !fraction.bytes().all(|b| b == b'0') {
                return Err(ApiError::invalid(name, "Input should be a valid integer"));
            }
            whole
        } else {
            value
        };
        integer
            .parse()
            .map_err(|_| ApiError::invalid(name, "Input should be a valid integer"))
    })
}

fn coordinate(p: &HashMap<String, String>, name: &str, bound: f64) -> Result<f64, ApiError> {
    let value = p
        .get(name)
        .ok_or_else(|| ApiError::invalid(name, "Field required"))?;
    value
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|n| n.is_finite() && n.abs() <= bound)
        .ok_or_else(|| {
            ApiError::invalid(
                name,
                "Input should be a finite coordinate within its WGS84 bounds",
            )
        })
}

fn etag(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("if-none-match")
        .and_then(|v| v.to_str().ok())
        .filter(|v| v.len() <= 512)
}

fn admin(state: &AppState, headers: &HeaderMap) -> Result<(), ApiError> {
    if let Some(token) = &state.config.admin_token {
        let expected = format!("Bearer {token}");
        if headers
            .get("authorization")
            .is_none_or(|v| v.as_bytes() != expected.as_bytes())
        {
            return Err(ApiError::detail(
                StatusCode::UNAUTHORIZED,
                "admin token required",
            ));
        }
    }
    Ok(())
}

async fn simple(State(state): State<Arc<AppState>>, uri: Uri, headers: HeaderMap) -> ApiResult {
    let op = match uri.path() {
        "/api/v1/health" => "health",
        "/api/v1/meta" => "meta",
        "/api/v1/provinces" => "provinces",
        "/api/v1/air/forecast" => "air_forecast",
        "/api/v1/air/stations" => "air_stations",
        "/api/v1/nowcast/frames" => "nowcast_frames",
        "/api/v1/nowcast/status" => "nowcast_status",
        "/api/v1/push/public-key" => "push_public_key",
        "/api/v1/push/status" => "push_status",
        _ => return Err(ApiError::detail(StatusCode::NOT_FOUND, "Not Found")),
    };
    if op == "push_status" {
        admin(&state, &headers)?;
    }
    state.engine.call(op, json!({}), etag(&headers)).await
}

async fn places(State(state): State<Arc<AppState>>, uri: Uri) -> ApiResult {
    let p = params(&uri)?;
    let q = p.get("q").cloned().unwrap_or_default();
    if q.chars().count() > 80 {
        return Err(ApiError::invalid(
            "q",
            "String should have at most 80 characters",
        ));
    }
    let permit = state
        .searches
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::unavailable())?;
    let index = state.places.clone();
    let found = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        index.search(&q)
    })
    .await
    .map_err(|_| ApiError::unavailable())?;
    Ok(([("cache-control", "public, max-age=3600")], Json(json!({"places": found, "attribution": {"name": "GeoNames", "url": "https://www.geonames.org/", "license": "CC BY 4.0"}}))).into_response())
}

async fn layer(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
    uri: Uri,
    headers: HeaderMap,
) -> ApiResult {
    let p = params(&uri)?;
    let step = integer(&p, "step", 0)?;
    let day = integer(&p, "day", 0)?;
    let res = p.get("res").map(String::as_str).unwrap_or("fine");
    files::layer(
        &state.config.data_dir,
        &name,
        res,
        if name == "rain24" { day } else { step },
        &headers,
    )
    .await
}

async fn static_layer(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
    headers: HeaderMap,
) -> ApiResult {
    if !matches!(name.as_str(), "hillshade" | "thai" | "elevation") {
        return Err(ApiError::detail(
            StatusCode::NOT_FOUND,
            "unknown static layer",
        ));
    }
    state
        .engine
        .call("static_layer", json!({"name": name}), etag(&headers))
        .await
}

async fn geo(State(state): State<Arc<AppState>>, Path(name): Path<String>) -> ApiResult {
    if !matches!(name.as_str(), "provinces" | "countries") {
        return Err(ApiError::detail(StatusCode::NOT_FOUND, "Not Found"));
    }
    files::json_file(
        &state
            .config
            .static_dir
            .join("geo")
            .join(format!("{name}.geojson")),
        "application/geo+json",
        None,
        "Not Found",
    )
    .await
}

async fn verification(State(state): State<Arc<AppState>>) -> ApiResult {
    files::json_file(
        &state.config.data_dir.join("verification/report.json"),
        "application/json",
        Some("public, max-age=300"),
        "no verification report yet",
    )
    .await
}

async fn openapi() -> Response {
    (
        [("content-type", "application/json")],
        include_str!("../openapi.json"),
    )
        .into_response()
}

async fn province(State(state): State<Arc<AppState>>, Path(pid): Path<String>) -> ApiResult {
    state
        .engine
        .call("province", json!({"pid": pid}), None)
        .await
}

async fn alerts(State(state): State<Arc<AppState>>, uri: Uri) -> ApiResult {
    let level = integer(&params(&uri)?, "min_severity", 1)?;
    if !(1..=3).contains(&level) {
        return Err(ApiError::invalid(
            "min_severity",
            "Input should be between 1 and 3",
        ));
    }
    state
        .engine
        .call("alerts", json!({"min_severity": level}), None)
        .await
}

async fn coordinates(State(state): State<Arc<AppState>>, uri: Uri) -> ApiResult {
    let p = params(&uri)?;
    let args = json!({"lat": coordinate(&p, "lat", 90.0)?, "lon": coordinate(&p, "lon", 180.0)?});
    let op = match uri.path() {
        "/api/v1/point" => "point",
        "/api/v1/forecast" => "forecast",
        _ => "nowcast",
    };
    state.engine.call(op, args, None).await
}

async fn radar_layer(
    State(state): State<Arc<AppState>>,
    uri: Uri,
    headers: HeaderMap,
) -> ApiResult {
    let lead = integer(&params(&uri)?, "lead", 0)?;
    if !(0..=60).contains(&lead) {
        return Err(ApiError::invalid(
            "lead",
            "Input should be between 0 and 60",
        ));
    }
    state
        .engine
        .call("nowcast_layer", json!({"lead": lead}), etag(&headers))
        .await
}

async fn radar_frame(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult {
    state
        .engine
        .call("nowcast_frame", json!({"frame_id": id}), etag(&headers))
        .await
}

async fn mutation(State(state): State<Arc<AppState>>, request: Request) -> ApiResult {
    let path = request.uri().path().to_owned();
    if matches!(path.as_str(), "/api/v1/observations" | "/api/v1/runs") {
        admin(&state, request.headers())?;
    }
    if path == "/api/v1/runs" {
        return state.engine.call("trigger_run", json!({}), None).await;
    }
    let limit = if path.starts_with("/api/v1/push/") {
        4096
    } else {
        1 << 20
    };
    let body = to_bytes(request.into_body(), limit)
        .await
        .map_err(|_| ApiError::detail(StatusCode::PAYLOAD_TOO_LARGE, "request body too large"))?;
    let value: Value = serde_json::from_slice(&body).map_err(|_| ApiError(StatusCode::UNPROCESSABLE_ENTITY, json!({"detail": [{"type": "json_invalid", "loc": ["body"], "msg": "JSON decode error"}]})))?;
    let (op, args) = match path.as_str() {
        "/api/v1/observations" => ("ingest_observations", json!({"items": value})),
        "/api/v1/push/subscribe" => ("push_subscribe", json!({"body": value})),
        "/api/v1/push/unsubscribe" => ("push_unsubscribe", json!({"body": value})),
        _ => return Err(ApiError::detail(StatusCode::NOT_FOUND, "Not Found")),
    };
    state.engine.call(op, args, None).await
}

async fn quota(State(state): State<Arc<AppState>>, request: Request, next: Next) -> Response {
    let path = request.uri().path();
    let client = request
        .headers()
        .get("x-real-ip")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .trim();
    if !path.starts_with("/api/v1/")
        || path == "/api/v1/health"
        || request.method() == Method::OPTIONS
        || client.is_empty()
    {
        return next.run(request).await;
    }
    let own_site = request
        .headers()
        .get("sec-fetch-site")
        .is_some_and(|v| v == "same-origin");
    let tier = if own_site {
        state.config.site
    } else {
        state.config.public
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64();
    let decision = {
        let mut limiter = state.limiter.lock().expect("quota lock");
        // The reverse proxy supplies an IP; bound malformed keys from internal callers too.
        let bounded: String = client.chars().take(64).collect();
        limiter.take(&bounded, tier, now)
    };
    let mut response = if decision.retry > 0 {
        let which = if decision.retry > 60 {
            format!("{}/day", tier.per_day)
        } else {
            format!("{}/min", tier.per_min)
        };
        let mut response = (StatusCode::TOO_MANY_REQUESTS, Json(json!({
            "error": "rate_limited", "detail": format!("Free API limit reached ({which} per IP). Retry after {} s.", decision.retry),
            "retry_after": decision.retry, "docs": "https://thai-weather.chakkritton.com/developers"
        }))).into_response();
        response.headers_mut().insert(
            "retry-after",
            HeaderValue::from_str(&decision.retry.to_string()).expect("integer header"),
        );
        response
            .headers_mut()
            .insert("access-control-allow-origin", HeaderValue::from_static("*"));
        response
    } else {
        next.run(request).await
    };
    if !own_site {
        for (name, value) in decision.headers {
            response.headers_mut().insert(
                HeaderName::from_static(name),
                HeaderValue::from_str(&value.to_string()).expect("integer header"),
            );
        }
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_finite_coordinates_and_duplicate_query_keys() {
        let uri: Uri = "/api/v1/point?lat=13&lat=18.5&lon=100.25".parse().unwrap();
        let p = params(&uri).unwrap_or_else(|_| panic!("valid query"));
        assert_eq!(coordinate(&p, "lat", 90.0).ok(), Some(18.5));
        for value in ["NaN", "inf", "-91", "91", "bad"] {
            let p = HashMap::from([("lat".to_owned(), value.to_owned())]);
            assert!(coordinate(&p, "lat", 90.0).is_err());
        }
        assert!(coordinate(&HashMap::new(), "lon", 180.0).is_err());
    }
}
