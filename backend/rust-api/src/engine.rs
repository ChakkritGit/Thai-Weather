//! Bounded binary IPC with the one long-lived numerical process.

use crate::error::{ApiError, ApiResult};
use axum::{
    body::Body,
    http::{HeaderName, HeaderValue, StatusCode},
    response::Response,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::HashMap, path::PathBuf, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::UnixStream,
    sync::Semaphore,
    time::timeout,
};

#[derive(Clone)]
pub struct Engine {
    path: PathBuf,
    slots: Arc<Semaphore>,
}

#[derive(Deserialize)]
struct Metadata {
    status: u16,
    headers: HashMap<String, String>,
}

impl Engine {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            slots: Arc::new(Semaphore::new(16)),
        }
    }

    pub async fn call(&self, op: &str, args: Value, etag: Option<&str>) -> ApiResult {
        let _permit = self
            .slots
            .try_acquire()
            .map_err(|_| ApiError::unavailable())?;
        let message = serde_json::to_vec(&json!({
            "op": op, "args": args, "if_none_match": etag.unwrap_or("")
        }))
        .map_err(|_| ApiError::unavailable())?;
        if message.len() > 2 << 20 {
            return Err(ApiError::detail(
                StatusCode::PAYLOAD_TOO_LARGE,
                "request body too large",
            ));
        }
        let operation = async {
            let mut socket = UnixStream::connect(&self.path).await?;
            socket.write_u32(message.len() as u32).await?;
            socket.write_all(&message).await?;
            let header_len = socket.read_u32().await? as usize;
            let body_len = socket.read_u32().await? as usize;
            if header_len == 0 || header_len > 64 << 10 || body_len > 32 << 20 {
                return Err(std::io::Error::other("invalid product frame"));
            }
            let mut metadata = vec![0; header_len];
            socket.read_exact(&mut metadata).await?;
            let metadata: Metadata = serde_json::from_slice(&metadata)?;
            let mut body = vec![0; body_len];
            socket.read_exact(&mut body).await?;
            let status = StatusCode::from_u16(metadata.status)
                .map_err(|_| std::io::Error::other("invalid product status"))?;
            let mut response = Response::new(Body::from(body));
            *response.status_mut() = status;
            for (key, value) in metadata.headers {
                // The worker cannot set transport/hop-by-hop headers.
                if matches!(
                    key.as_str(),
                    "connection" | "transfer-encoding" | "content-length" | "upgrade"
                ) {
                    continue;
                }
                let key: HeaderName = key
                    .parse()
                    .map_err(|_| std::io::Error::other("invalid product header"))?;
                let value: HeaderValue = value
                    .parse()
                    .map_err(|_| std::io::Error::other("invalid product header"))?;
                response.headers_mut().insert(key, value);
            }
            Ok::<_, std::io::Error>(response)
        };
        match timeout(Duration::from_secs(30), operation).await {
            Ok(Ok(response)) => Ok(response),
            _ => {
                tracing::error!(operation = op, "numerical worker IPC failed");
                Err(ApiError::unavailable())
            }
        }
    }
}
