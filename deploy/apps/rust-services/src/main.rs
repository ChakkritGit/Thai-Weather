mod collector;
mod history;
mod host;
mod logs;
mod security;

use axum::{
    Router,
    body::Body,
    extract::{RawQuery, State},
    http::{Response, StatusCode},
    routing::{get, post},
};
use collector::{Collector, now};
use security::Security;
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    os::fd::AsRawFd,
    sync::{Arc, Mutex},
    time::Duration,
};

#[derive(Clone)]
struct App {
    collector: Arc<Mutex<Collector>>,
    serializers: Arc<tokio::sync::Semaphore>,
    fixed: Option<f64>,
    /// None in serve-only mode: the security watch writes state and reads host views
    security: Option<Arc<Mutex<Security>>>,
}
async fn not_found() -> Response<Body> {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .body(Body::from("NOT_FOUND"))
        .unwrap()
}
async fn metrics(State(app): State<App>, RawQuery(query): RawQuery) -> Response<Body> {
    let range = form_urlencoded::parse(query.as_deref().unwrap_or("").as_bytes())
        .filter(|(k, _)| k == "range")
        .last()
        .map(|(_, v)| v.into_owned())
        .unwrap_or_else(|| "1h".into());
    if history::tier(&range).is_none() {
        return Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .body(Body::from("bad range"))
            .unwrap();
    }
    // Queue asynchronously before starting a blocking worker. The mutex alone
    // permits many worker threads and detached payloads to accumulate under load.
    let Ok(permit) = app.serializers.clone().acquire_owned().await else {
        return Response::builder()
            .status(StatusCode::SERVICE_UNAVAILABLE)
            .body(Body::from("metrics unavailable"))
            .unwrap();
    };
    let result = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let _permit = permit;
        app.collector
            .lock()
            .map_err(|_| "collector unavailable")?
            .gzip_payload(&range, app.fixed.unwrap_or_else(now))
            .map_err(|e| e.to_string())
    })
    .await;
    match result {
        Ok(Ok(bytes)) => Response::builder()
            .header("content-type", "application/json")
            .header("content-encoding", "gzip")
            .header("cache-control", "no-store")
            .body(Body::from(bytes))
            .unwrap(),
        _ => Response::builder()
            .status(StatusCode::INTERNAL_SERVER_ERROR)
            .body(Body::from("metrics unavailable"))
            .unwrap(),
    }
}
fn json_response(status: StatusCode, body: serde_json::Value) -> Response<Body> {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .header("cache-control", "no-store")
        .body(Body::from(body.to_string()))
        .unwrap()
}
/// Runs `f` on the security state off the async workers (a first run reads whole logs).
async fn with_security(
    app: &App,
    f: impl FnOnce(&mut Security, f64) -> serde_json::Value + Send + 'static,
) -> Response<Body> {
    let Some(security) = app.security.clone() else {
        return json_response(StatusCode::OK, serde_json::json!({ "enabled": false }));
    };
    let result = tokio::task::spawn_blocking(move || {
        security
            .lock()
            .map(|mut s| f(&mut s, now()))
            .map_err(|_| ())
    })
    .await;
    match result {
        Ok(Ok(body)) => json_response(StatusCode::OK, body),
        _ => json_response(
            StatusCode::SERVICE_UNAVAILABLE,
            serde_json::json!({ "error": "security unavailable" }),
        ),
    }
}
async fn security_view(State(app): State<App>) -> Response<Body> {
    with_security(&app, |s, t| s.payload(t)).await
}
async fn security_ack(State(app): State<App>) -> Response<Body> {
    with_security(&app, |s, t| {
        s.ack(t);
        serde_json::json!({ "ok": true })
    })
    .await
}
/// New alert events for apps-chat (internal network only; Dock's nginx does not forward this path)
async fn security_outbox(State(app): State<App>, RawQuery(query): RawQuery) -> Response<Body> {
    let after = form_urlencoded::parse(query.as_deref().unwrap_or("").as_bytes())
        .filter(|(k, _)| k == "after")
        .last()
        .and_then(|(_, v)| v.parse::<u64>().ok())
        .unwrap_or(0);
    with_security(&app, move |s, _| s.outbox(after)).await
}
fn port() -> Result<u16, Box<dyn std::error::Error>> {
    Ok(std::env::var("PORT")
        .unwrap_or_else(|_| "9100".into())
        .parse()?)
}
fn healthcheck() -> Result<(), Box<dyn std::error::Error>> {
    let mut socket = std::net::TcpStream::connect_timeout(
        &([127, 0, 0, 1], port()?).into(),
        Duration::from_secs(3),
    )?;
    socket.set_read_timeout(Some(Duration::from_secs(3)))?;
    socket.write_all(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")?;
    let mut bytes = [0u8; 128];
    let n = socket.read(&mut bytes)?;
    if !bytes[..n].starts_with(b"HTTP/1.1 200 ") {
        return Err("unhealthy".into());
    }
    Ok(())
}
#[tokio::main(worker_threads = 2)]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args().nth(1).as_deref() == Some("--healthcheck") {
        return healthcheck();
    }
    let serve_only = std::env::var("METRICS_SERVE_ONLY").as_deref() == Ok("true");
    let fixed = std::env::var("METRICS_FIXED_NOW")
        .ok()
        .map(|s| s.parse::<f64>())
        .transpose()?;
    if fixed.is_some_and(|t| !t.is_finite() || t < 0.) || (fixed.is_some() && !serve_only) {
        return Err("fixed clock is only valid in serve-only mode".into());
    }
    let paths = host::Paths::from_env();
    let security_roots = security::Roots::from_env(&paths);
    let _lease = if serve_only {
        None
    } else {
        fs::create_dir_all(&paths.data)?;
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(paths.data.join("collector.lock"))?;
        // SAFETY: file owns a valid open descriptor; the lease lives through final history save.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err("another collector owns this history".into());
        }
        Some(file)
    };
    let app = App {
        collector: Arc::new(Mutex::new(Collector::load(
            paths,
            fixed.unwrap_or_else(now),
        ))),
        serializers: Arc::new(tokio::sync::Semaphore::new(1)),
        fixed,
        security: (!serve_only)
            .then(|| Arc::new(Mutex::new(Security::load(security_roots, now())))),
    };
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port()?)).await?;
    let (stop, mut stopped) = tokio::sync::watch::channel(false);
    let sampler = if serve_only {
        None
    } else {
        let shared = app.collector.clone();
        Some(tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(5));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut last_save = now();
            loop {
                tokio::select! {
                    _=stopped.changed()=>break,
                    _=interval.tick()=>{
                        let Ok(mut c)=shared.lock()else{break};let t=now();
                        if let Err(e)=c.tick(t){eprintln!("sample error: {e}");}
                        if t-last_save>300. {match c.save(){Ok(())=>last_save=t,Err(e)=>eprintln!("history save error: {e}")}}
                    }
                }
            }
        }))
    };
    let watcher = app.security.clone().map(|shared| {
        let mut stopped = stop.subscribe();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(5));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {
                    _ = stopped.changed() => break,
                    _ = interval.tick() => {
                        let shared = shared.clone();
                        let done = tokio::task::spawn_blocking(move || {
                            if let Ok(mut s) = shared.lock() {
                                s.tick(now());
                            }
                        })
                        .await;
                        if done.is_err() {
                            eprintln!("security pass failed");
                        }
                    }
                }
            }
        })
    });
    let router = Router::new()
        .route("/metrics", get(metrics))
        .route("/metrics/", get(metrics))
        .route("/security", get(security_view))
        .route("/security/ack", post(security_ack))
        .route("/security/outbox", get(security_outbox))
        .fallback(not_found)
        .method_not_allowed_fallback(not_found)
        .route("/healthz", get(|| async { "ok" }))
        .with_state(app.clone());
    eprintln!("dock-metrics Rust listening on :{}", port()?);
    let served = axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let mut term =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("SIGTERM handler");
            tokio::select! {_=tokio::signal::ctrl_c()=>{},_=term.recv()=>{}}
        })
        .await;
    let _ = stop.send(true);
    if let Some(sampler) = sampler {
        sampler.await?;
    }
    if let Some(watcher) = watcher {
        watcher.await?;
    }
    if let Some(security) = &app.security
        && let Err(e) = security
            .lock()
            .map_err(|_| std::io::Error::other("security unavailable"))
            .and_then(|mut s| s.save())
    {
        eprintln!("security save error: {e}");
    }
    if !serve_only {
        app.collector
            .lock()
            .map_err(|_| "collector unavailable")?
            .save()?;
    }
    served?;
    Ok(())
}
