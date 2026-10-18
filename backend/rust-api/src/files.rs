//! Serve persisted uint8 map slices directly, without entering Python/NumPy.

use crate::error::{ApiError, ApiResult};
use axum::{
    body::Body,
    http::{HeaderMap, HeaderValue, StatusCode},
    response::Response,
};
use std::{io::SeekFrom, path::Path};
use tokio::{
    fs::File,
    io::{AsyncReadExt, AsyncSeekExt},
};

pub const LAYERS: [&str; 11] = [
    "temp", "heat", "rh", "rain", "pop", "heavy", "storm", "wind", "wind_dir", "cloud", "rain24",
];

fn bad_file() -> ApiError {
    ApiError::detail(
        StatusCode::SERVICE_UNAVAILABLE,
        "forecast layer unavailable",
    )
}

pub async fn latest(root: &Path) -> Result<String, ApiError> {
    let bytes = tokio::fs::read(root.join("runs/LATEST"))
        .await
        .map_err(|_| {
            ApiError::detail(
                StatusCode::SERVICE_UNAVAILABLE,
                "The first forecast run is still being computed – try again shortly.",
            )
        })?;
    let value = std::str::from_utf8(&bytes).map_err(|_| bad_file())?.trim();
    if value.is_empty()
        || value.len() > 96
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_".contains(&c))
    {
        return Err(bad_file());
    }
    Ok(value.to_owned())
}

pub async fn layer(
    root: &Path,
    name: &str,
    res: &str,
    index: i64,
    request: &HeaderMap,
) -> ApiResult {
    let run = latest(root).await?;
    if !LAYERS.contains(&name) {
        return Err(ApiError::detail(
            StatusCode::NOT_FOUND,
            format!("unknown layer {name}"),
        ));
    }
    if !matches!(res, "fine" | "coarse") {
        return Err(ApiError::invalid(
            "res",
            "String should match pattern '^(fine|coarse)$'",
        ));
    }
    let mut file = File::open(
        root.join("runs")
            .join(&run)
            .join(format!("{res}_{name}.npy")),
    )
    .await
    .map_err(|_| bad_file())?;
    let mut prefix = [0; 8];
    file.read_exact(&mut prefix).await.map_err(|_| bad_file())?;
    if &prefix[..6] != b"\x93NUMPY" || prefix[7] != 0 {
        return Err(bad_file());
    }
    let (header_len, preamble) = match prefix[6] {
        1 => (
            file.read_u16_le().await.map_err(|_| bad_file())? as usize,
            10,
        ),
        2 | 3 => (
            file.read_u32_le().await.map_err(|_| bad_file())? as usize,
            12,
        ),
        _ => return Err(bad_file()),
    };
    if header_len == 0 || header_len > 64 << 10 {
        return Err(bad_file());
    }
    let mut header = vec![0; header_len];
    file.read_exact(&mut header).await.map_err(|_| bad_file())?;
    let shape = crate::npy::parse_npy_header(std::str::from_utf8(&header).map_err(|_| bad_file())?)
        .map_err(|_| bad_file())?;
    if index < 0 || index as usize >= shape.steps {
        return Err(ApiError::detail(
            StatusCode::NOT_FOUND,
            "time index out of range",
        ));
    }
    let cells = shape.ny * shape.nx;
    let start = (preamble + header_len) as u64;
    if file.metadata().await.map_err(|_| bad_file())?.len() < start + (shape.steps * cells) as u64 {
        return Err(bad_file());
    }
    let etag = format!("\"{run}-{res}-{name}-{index}\"");
    let cached = request
        .get("if-none-match")
        .is_some_and(|v| v.as_bytes() == etag.as_bytes());
    let mut response = if cached {
        let mut response = Response::new(Body::empty());
        *response.status_mut() = StatusCode::NOT_MODIFIED;
        response
    } else {
        file.seek(SeekFrom::Start(start + index as u64 * cells as u64))
            .await
            .map_err(|_| bad_file())?;
        let mut bytes = vec![0; cells];
        file.read_exact(&mut bytes).await.map_err(|_| bad_file())?;
        let mut response = Response::new(Body::from(bytes));
        response.headers_mut().insert(
            "content-type",
            HeaderValue::from_static("application/octet-stream"),
        );
        response
    };
    for (name, value) in [
        ("etag", etag),
        ("cache-control", "public, max-age=900".into()),
        ("x-grid-ny", shape.ny.to_string()),
        ("x-grid-nx", shape.nx.to_string()),
        ("x-run-id", run),
    ] {
        response.headers_mut().insert(
            HeaderName::from_static(name),
            value.parse().map_err(|_| bad_file())?,
        );
    }
    Ok(response)
}

use axum::http::HeaderName;

pub async fn json_file(
    path: &Path,
    content_type: &'static str,
    cache: Option<&'static str>,
    detail: &str,
) -> ApiResult {
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|_| ApiError::detail(StatusCode::NOT_FOUND, detail))?;
    let mut response = Response::new(Body::from(bytes));
    response
        .headers_mut()
        .insert("content-type", HeaderValue::from_static(content_type));
    if let Some(cache) = cache {
        response
            .headers_mut()
            .insert("cache-control", HeaderValue::from_static(cache));
    }
    Ok(response)
}
