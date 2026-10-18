use axum::{Router, body::Body, http::Response};
use std::{
    io::{Read, Write},
    time::Duration,
};
use subtle::ConstantTimeEq;
pub fn env(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.into())
}
pub fn secret(given: &str, expected: &str) -> bool {
    !expected.is_empty() && bool::from(given.as_bytes().ct_eq(expected.as_bytes()))
}
pub fn text(status: u16, body: impl Into<Body>) -> Response<Body> {
    Response::builder()
        .status(status)
        .body(body.into())
        .unwrap()
}
pub fn json(status: u16, value: serde_json::Value) -> Response<Body> {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&value).unwrap()))
        .unwrap()
}
pub async fn serve(port: u16, router: Router) -> Result<(), Box<dyn std::error::Error>> {
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let mut term =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("SIGTERM");
            tokio::select! { _=tokio::signal::ctrl_c()=>{}, _=term.recv()=>{} }
        })
        .await?;
    Ok(())
}
pub fn healthcheck(port: u16, path: &str) -> Result<(), Box<dyn std::error::Error>> {
    let mut c = std::net::TcpStream::connect_timeout(
        &([127, 0, 0, 1], port).into(),
        Duration::from_secs(3),
    )?;
    c.set_read_timeout(Some(Duration::from_secs(3)))?;
    c.write_all(
        format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").as_bytes(),
    )?;
    let mut bytes = [0u8; 128];
    let n = c.read(&mut bytes)?;
    if !bytes[..n].starts_with(b"HTTP/1.1 200 ") {
        return Err("unhealthy".into());
    }
    Ok(())
}
