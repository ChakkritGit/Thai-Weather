//! Portfolio's UUID-named media store. All writes use same-directory atomic rename.
use crate::util;
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{Request, State},
    http::{Method, header},
    response::Response,
};
use serde_json::json;
use std::{path::PathBuf, sync::Arc};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
const MAX: usize = 20 * 1024 * 1024;
struct Store {
    dir: PathBuf,
    token: String,
}
pub fn safe_path(raw: &str) -> Option<String> {
    // Reject malformed escapes as decodeURIComponent does.
    let b = raw.as_bytes();
    for i in 0..b.len() {
        if b[i] == b'%'
            && (i + 2 >= b.len() || !b[i + 1].is_ascii_hexdigit() || !b[i + 2].is_ascii_hexdigit())
        {
            return None;
        }
    }
    let p = percent_encoding::percent_decode_str(raw)
        .decode_utf8()
        .ok()?;
    if p.is_empty()
        || p.len() > 301
        || !p.as_bytes()[0].is_ascii_alphanumeric()
        || !p
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._/-".contains(&b))
        || p.split('/').any(|s| s.is_empty() || s.starts_with('.'))
    {
        return None;
    }
    Some(p.into_owned())
}
fn content_type(path: &str) -> Option<&'static str> {
    Some(
        match path.rsplit('.').next()?.to_ascii_lowercase().as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "webp" => "image/webp",
            "gif" => "image/gif",
            "avif" => "image/avif",
            "svg" => "image/svg+xml",
            "pdf" => "application/pdf",
            "zip" => "application/zip",
            "txt" => "text/plain; charset=utf-8",
            "md" => "text/markdown; charset=utf-8",
            "json" => "application/json",
            "csv" => "text/csv; charset=utf-8",
            "mp4" => "video/mp4",
            "webm" => "video/webm",
            _ => return None,
        },
    )
}
async fn handle(State(store): State<Arc<Store>>, req: Request) -> Response {
    let path = req.uri().path();
    let method = req.method().clone();
    if (path == "/health" || path == "/health/")
        && (method == Method::GET || method == Method::HEAD)
    {
        return util::json(200, json!({"ok":true}));
    }
    let public = path.strip_prefix("/media/");
    let private = path.strip_prefix("/internal/media/");
    let read = public.is_some() && (method == Method::GET || method == Method::HEAD);
    let write = private.is_some() && (method == Method::PUT || method == Method::DELETE);
    if !read && !write {
        return util::text(404, "NOT_FOUND");
    }
    if write
        && !util::secret(
            req.headers()
                .get("x-media-token")
                .and_then(|v| v.to_str().ok())
                .unwrap_or(""),
            &store.token,
        )
    {
        return util::text(403, "forbidden");
    }
    let Some(p) = safe_path(public.or(private).unwrap()) else {
        return util::text(
            if read { 404 } else { 400 },
            if read { "not found" } else { "bad path" },
        );
    };
    let file = store.dir.join(&p);
    if read {
        let Ok(mut f) = tokio::fs::File::open(&file).await else {
            return util::text(404, "not found");
        };
        let Ok(meta) = f.metadata().await else {
            return util::text(404, "not found");
        };
        if !meta.is_file() {
            return util::text(404, "not found");
        }
        let total = meta.len();
        let mut status = 200;
        let mut start = 0;
        let mut len = total;
        if let Some(r) = req
            .headers()
            .get(header::RANGE)
            .and_then(|h| h.to_str().ok())
            .and_then(|h| h.strip_prefix("bytes="))
            && let Some((a, b)) = r.split_once('-')
        {
            let range = if a.is_empty() {
                b.parse::<u64>()
                    .ok()
                    .filter(|&n| n > 0)
                    .map(|n| (total.saturating_sub(n), total.saturating_sub(1)))
            } else {
                a.parse::<u64>().ok().and_then(|a| {
                    let b = if b.is_empty() {
                        Some(total.saturating_sub(1))
                    } else {
                        b.parse::<u64>().ok()
                    };
                    b.map(|b| (a, b.min(total.saturating_sub(1))))
                })
            };
            if let Some((a, b)) = range.filter(|&(a, b)| a <= b && a < total) {
                status = 206;
                start = a;
                len = b - a + 1;
            } else {
                return Response::builder()
                    .status(416)
                    .header("content-range", format!("bytes */{total}"))
                    .body(Body::empty())
                    .unwrap();
            }
        }
        if start > 0 && f.seek(std::io::SeekFrom::Start(start)).await.is_err() {
            return util::text(500, "read failed");
        }
        let body = if method == Method::HEAD {
            Body::empty()
        } else {
            Body::from_stream(tokio_util::io::ReaderStream::new(f.take(len)))
        };
        let mut response = Response::builder()
            .status(status)
            .header(
                "content-type",
                content_type(&p).unwrap_or("application/octet-stream"),
            )
            .header("content-length", len)
            .header("accept-ranges", "bytes")
            .header("cache-control", "public, max-age=31536000, immutable")
            .header("x-content-type-options", "nosniff")
            .header(
                "content-security-policy",
                "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
            );
        if status == 206 {
            response = response.header(
                "content-range",
                format!("bytes {start}-{}/{total}", start + len - 1),
            );
        }
        if content_type(&p).is_none() {
            response = response.header("content-disposition", "attachment");
        }
        return response.body(body).unwrap();
    }
    if method == Method::DELETE {
        return match tokio::fs::remove_file(file).await {
            Ok(()) => util::text(204, Body::empty()),
            Err(_) => util::text(404, "not found"),
        };
    }
    let Ok(bytes) = to_bytes(req.into_body(), MAX + 1).await else {
        return util::text(413, "too large");
    };
    if bytes.len() > MAX {
        return util::text(413, "too large");
    }
    let parent = file.parent().unwrap();
    if tokio::fs::create_dir_all(parent).await.is_err() {
        return util::text(500, "write failed");
    }
    let tmp = parent.join(format!(".upload-{}", uuid::Uuid::new_v4()));
    let result = async {
        tokio::fs::write(&tmp, &bytes).await?;
        tokio::fs::rename(&tmp, &file).await
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(tmp).await;
        return util::text(500, "write failed");
    }
    util::text(201, Body::empty())
}
pub fn router() -> Router {
    Router::new().fallback(handle).with_state(Arc::new(Store {
        dir: util::env("MEDIA_DIR", "/data/media").into(),
        token: util::env("MEDIA_TOKEN", ""),
    }))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paths() {
        assert_eq!(
            safe_path("uploads/2026-10/a.png").as_deref(),
            Some("uploads/2026-10/a.png")
        );
        for bad in [
            "../etc/passwd",
            "uploads/../../x",
            "/abs/x.png",
            ".env",
            "uploads/.hidden",
            "a//b",
            "%2e%2e/x",
            "a\\b",
            "x%",
            "x%zz",
        ] {
            assert!(safe_path(bad).is_none(), "{bad}");
        }
    }
}
