mod collector;
mod history;
mod host;
mod logs;

use axum::{
    Router,
    body::Body,
    extract::{RawQuery, State},
    http::{Response, StatusCode},
    routing::get,
};
use collector::{Collector, now};
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
    let router = Router::new()
        .route("/metrics", get(metrics))
        .route("/metrics/", get(metrics))
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
    if !serve_only {
        app.collector
            .lock()
            .map_err(|_| "collector unavailable")?
            .save()?;
    }
    served?;
    Ok(())
}
