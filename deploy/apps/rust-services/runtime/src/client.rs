use axum::http::{HeaderMap, Method, Request, Uri};
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper_util::{
    client::legacy::{Client, connect::HttpConnector},
    rt::TokioExecutor,
};
use std::time::Duration;

#[derive(Clone)]
pub struct Http {
    client: Client<HttpConnector, Full<Bytes>>,
}
pub struct Reply {
    pub status: u16,
    pub body: Vec<u8>,
}
#[derive(Debug, Clone, Copy)]
pub enum Failure {
    Timeout,
    Network,
}
impl Http {
    pub fn new() -> Self {
        let mut connector = HttpConnector::new();
        connector.enforce_http(true);
        connector.set_connect_timeout(Some(Duration::from_secs(10)));
        Self {
            client: Client::builder(TokioExecutor::new()).build(connector),
        }
    }
    pub async fn request(
        &self,
        method: Method,
        url: &str,
        headers: HeaderMap,
        body: Vec<u8>,
        timeout: Duration,
    ) -> Result<Reply, Failure> {
        let request = async {
            let uri: Uri = url.parse().map_err(|_| Failure::Network)?;
            if uri.scheme_str() != Some("http") || uri.authority().is_none() {
                return Err(Failure::Network);
            }
            let mut req = Request::builder()
                .method(method)
                .uri(uri)
                .body(Full::new(Bytes::from(body)))
                .map_err(|_| Failure::Network)?;
            *req.headers_mut() = headers;
            let mut response = self
                .client
                .request(req)
                .await
                .map_err(|_| Failure::Network)?;
            let status = response.status().as_u16();
            let mut bytes = Vec::new();
            while let Some(frame) = response.body_mut().frame().await {
                let frame = frame.map_err(|_| Failure::Network)?;
                if let Ok(data) = frame.into_data() {
                    if bytes.len() + data.len() > 2 * 1024 * 1024 {
                        return Err(Failure::Network);
                    }
                    bytes.extend_from_slice(&data);
                }
            }
            Ok(Reply {
                status,
                body: bytes,
            })
        };
        tokio::time::timeout(timeout, request)
            .await
            .map_err(|_| Failure::Timeout)?
    }
}
