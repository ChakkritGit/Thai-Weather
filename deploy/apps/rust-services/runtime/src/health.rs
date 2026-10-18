use crate::{checks, client};
use axum::{
    Router,
    body::{Body, Bytes},
    extract::State,
    http::{HeaderMap, HeaderValue, Method, Response, StatusCode},
    routing::{get, post},
};
use serde_json::json;
use std::{
    io::{Read, Write},
    sync::Arc,
    time::Duration,
};
use subtle::ConstantTimeEq;

pub(crate) struct Config {
    pub(crate) port: u16,
    pub(crate) snapshot: String,
    pub(crate) rooms: String,
    pub(crate) sync: String,
    pub(crate) reminders: String,
    pub(crate) alert: String,
    pub(crate) probe_secret: String,
    pub(crate) status_secret: String,
    pub(crate) alert_secret: String,
    pub(crate) alerts_disabled: bool,
    pub(crate) probe_timeout: Duration,
    pub(crate) retry_delay: Duration,
}
impl Config {
    fn load() -> Result<Self, Box<dyn std::error::Error>> {
        fn env(k: &str, fallback: &str) -> String {
            std::env::var(k).unwrap_or_else(|_| fallback.into())
        }
        fn duration(k: &str, default: u64, max: u64) -> Duration {
            Duration::from_millis(
                std::env::var(k)
                    .ok()
                    .and_then(|s| s.parse::<u64>().ok())
                    .unwrap_or(default)
                    .min(max),
            )
        }
        Ok(Self {
            port: env("PORT", "8789").parse()?,
            snapshot: env("CONTAINERS_FILE", "/host/containers.tsv"),
            rooms: env("ROOMS_URL", "http://apps-rooms:8787"),
            sync: env("SYNC_URL", "http://apps-sync:8788"),
            reminders: env("REMINDERS_URL", "http://apps-reminders:8792/"),
            alert: env("ALERT_URL", "http://apps-chat:8795/chat/alert"),
            probe_secret: env("PROBE_SECRET", ""),
            status_secret: env("STATUS_SECRET", ""),
            alert_secret: env("ALERT_SECRET", ""),
            alerts_disabled: env("HEALTH_ALERTS_DISABLED", "") == "true",
            probe_timeout: duration("HEALTH_PROBE_TIMEOUT_MS", 10000, 10000),
            retry_delay: duration("HEALTH_RETRY_DELAY_MS", 5000, 5000),
        })
    }
    fn authorized(&self, h: &HeaderMap) -> bool {
        let given = h
            .get("x-probe-secret")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        !self.probe_secret.is_empty()
            && bool::from(self.probe_secret.as_bytes().ct_eq(given.as_bytes()))
    }
}
#[derive(Clone)]
struct App {
    config: Arc<Config>,
    http: client::Http,
}
fn response(status: u16, value: serde_json::Value) -> Response<Body> {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(
            serde_json::to_vec(&value).expect("JSON response"),
        ))
        .unwrap()
}
fn denied() -> Response<Body> {
    response(401, json!({"error":"unauthorized"}))
}
async fn health(State(app): State<App>, headers: HeaderMap) -> Response<Body> {
    if !app.config.authorized(&headers) {
        return denied();
    }
    let snapshot = tokio::fs::read_to_string(&app.config.snapshot);
    let (snap, rooms, music, reminders) = tokio::join!(
        snapshot,
        checks::simple(&app.http, &app.config, false),
        checks::simple(&app.http, &app.config, true),
        checks::reminders(&app.http, &app.config)
    );
    let (at, containers) = checks::snapshot(&snap.unwrap_or_default());
    let mut r = response(
        200,
        json!({"at":at,"containers":containers,"checks":[rooms,music,reminders]}),
    );
    r.headers_mut()
        .insert("cache-control", HeaderValue::from_static("no-store"));
    r
}
async fn alert(State(app): State<App>, headers: HeaderMap, body: Bytes) -> Response<Body> {
    if !app.config.authorized(&headers) {
        return denied();
    }
    if app.config.alerts_disabled {
        return response(503, json!({"error":"alerts disabled"}));
    }
    let value = if body.is_empty() {
        serde_json::Value::Null
    } else {
        match serde_json::from_slice::<serde_json::Value>(&body) {
            Ok(v) => v,
            Err(_) => return response(400, json!({"error":"invalid JSON"})),
        }
    };
    let mut h = HeaderMap::new();
    h.insert("content-type", HeaderValue::from_static("application/json"));
    let Ok(secret) = HeaderValue::from_str(&app.config.alert_secret) else {
        return response(502, json!({"error":"chat unreachable"}));
    };
    h.insert("x-alert-secret", secret);
    match app
        .http
        .request(
            Method::POST,
            &app.config.alert,
            h,
            serde_json::to_vec(&value).unwrap(),
            Duration::from_secs(15),
        )
        .await
    {
        Ok(reply) => response(
            reply.status,
            serde_json::from_slice(&reply.body).unwrap_or_else(|_| json!({})),
        ),
        Err(_) => response(502, json!({"error":"chat unreachable"})),
    }
}
async fn missing() -> Response<Body> {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .body(Body::from("NOT_FOUND"))
        .unwrap()
}
fn ping_check(port: u16) -> Result<(), Box<dyn std::error::Error>> {
    let mut c = std::net::TcpStream::connect_timeout(
        &([127, 0, 0, 1], port).into(),
        Duration::from_secs(3),
    )?;
    c.set_read_timeout(Some(Duration::from_secs(3)))?;
    c.write_all(b"GET /ping HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")?;
    let mut bytes = [0u8; 128];
    let n = c.read(&mut bytes)?;
    if !bytes[..n].starts_with(b"HTTP/1.1 200 ") {
        return Err("unhealthy".into());
    }
    Ok(())
}
pub async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let config = Config::load()?;
    if std::env::args().nth(1).as_deref() == Some("--healthcheck") {
        return ping_check(config.port);
    }
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", config.port)).await?;
    let app = App {
        config: Arc::new(config),
        http: client::Http::new(),
    };
    let router = Router::new()
        .route("/health", get(health))
        .route("/health/", get(health))
        .route("/alert", post(alert))
        .route("/alert/", post(alert))
        .route("/ping", get(|| async { "ok" }))
        .route("/ping/", get(|| async { "ok" }))
        .fallback(missing)
        .method_not_allowed_fallback(missing)
        .with_state(app);
    eprintln!("Rust health listening");
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let mut term =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("SIGTERM handler");
            tokio::select! {_=tokio::signal::ctrl_c()=>{},_=term.recv()=>{}}
        })
        .await?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn secrets_are_required_and_compared_as_bytes() {
        let config = Config::load().unwrap();
        let mut config = Config {
            probe_secret: "fixture-secret".into(),
            ..config
        };
        let mut headers = HeaderMap::new();
        assert!(!config.authorized(&headers));
        headers.insert("x-probe-secret", HeaderValue::from_static("fixture-secret"));
        assert!(config.authorized(&headers));
        headers.insert("x-probe-secret", HeaderValue::from_static("fixture-secreu"));
        assert!(!config.authorized(&headers));
        config.probe_secret.clear();
        headers.remove("x-probe-secret");
        assert!(!config.authorized(&headers));
    }
}
