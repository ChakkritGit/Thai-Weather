//! The Rust process owns HTTP and supervises one private numerical worker.

use std::{
    error::Error,
    future::IntoFuture,
    net::SocketAddr,
    os::unix::fs::DirBuilderExt,
    path::PathBuf,
    process::Stdio,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use thwx_api::{
    api::{AppState, Config, router},
    engine::Engine,
    places::Places,
};
use tokio::{
    net::TcpListener,
    process::Command,
    signal,
    sync::oneshot,
    time::{sleep, timeout},
};

struct RuntimeDirectory(PathBuf);

impl RuntimeDirectory {
    fn create() -> std::io::Result<Self> {
        let id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        // macOS TMPDIR paths can exceed sockaddr_un's limit once the socket is appended.
        let path = PathBuf::from("/tmp").join(format!("thwx-{}-{id:x}", std::process::id()));
        std::fs::DirBuilder::new().mode(0o700).create(&path)?;
        Ok(Self(path))
    }
}

impl Drop for RuntimeDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(self.0.join("engine.sock"));
        let _ = std::fs::remove_dir(&self.0);
    }
}

async fn shutdown_signal() {
    let mut term =
        signal::unix::signal(signal::unix::SignalKind::terminate()).expect("SIGTERM handler");
    tokio::select! { _ = term.recv() => {}, _ = signal::ctrl_c() => {} }
}

#[tokio::main(worker_threads = 2)]
async fn main() -> Result<(), Box<dyn Error + Send + Sync>> {
    tracing_subscriber::fmt().with_target(false).init();
    let config = Config::from_env().map_err(std::io::Error::other)?;
    let places = Places::load(&config.static_dir.join("places.json"))?;
    let addr: SocketAddr = std::env::var("THWX_HTTP_ADDR")
        .unwrap_or_else(|_| "0.0.0.0:8000".into())
        .parse()?;
    // Fail before starting any numerical job if the configured HTTP port is unavailable.
    let listener = TcpListener::bind(addr).await?;
    let runtime = RuntimeDirectory::create()?;
    let socket = runtime.0.join("engine.sock");
    let engine = Engine::new(socket.clone());
    let mut worker =
        Command::new(std::env::var_os("THWX_PYTHON").unwrap_or_else(|| "python".into()))
            .args(["-m", "app.engine.worker"])
            .arg(&socket)
            .stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()?;
    let readiness = async {
        loop {
            if worker.try_wait()?.is_some() {
                return Err(std::io::Error::other(
                    "numerical worker exited during startup",
                ));
            }
            if socket.exists()
                && let Ok(response) = engine.call("health", serde_json::json!({}), None).await
                && response.status().is_success()
            {
                return Ok(());
            }
            sleep(Duration::from_millis(200)).await;
        }
    };
    timeout(Duration::from_secs(90), readiness).await??;
    let state = AppState::new(config, engine.clone(), places);
    let (stop, stopped) = oneshot::channel();
    let mut http = Box::pin(
        axum::serve(listener, router(state))
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .into_future(),
    );
    tracing::info!(%addr, "Rust API ready; Python numerical worker connected");
    tokio::select! {
        result = &mut http => { result?; }
        status = worker.wait() => {
            let _ = stop.send(());
            let _ = timeout(Duration::from_secs(5), &mut http).await;
            tracing::error!(?status, "numerical worker exited; stopping API for container restart");
            return Err(std::io::Error::other("numerical worker exited").into());
        }
        _ = shutdown_signal() => {
            let _ = stop.send(());
            // Finish in-flight HTTP requests before closing the worker socket.
            let _ = timeout(Duration::from_secs(35), &mut http).await;
        }
    }
    let _ = engine.call("shutdown", serde_json::json!({}), None).await;
    // A normal stop can wait for an already-running forecast to publish; deployment must still
    // check refresher.state == idle before a cutover, so it never kills/repeats a scheduled run.
    if timeout(Duration::from_secs(15 * 60), worker.wait())
        .await
        .is_err()
    {
        worker.kill().await?;
    }
    Ok(())
}
