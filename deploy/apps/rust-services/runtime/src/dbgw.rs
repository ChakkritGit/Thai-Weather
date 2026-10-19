//! Supabase Auth JWT -> local PostgREST JWT, preserving RLS and streaming bodies.
use crate::{checks::millis, util};
use axum::{
    Router,
    body::Body,
    extract::{Request, State},
    http::{HeaderMap, HeaderValue, Method, Response},
    response::Response as HttpResponse,
};
use jsonwebtoken::{
    Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, decode_header, encode,
    jwk::{JwkSet, KeyOperations, PublicKeyUse},
};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
struct Keys {
    set: JwkSet,
    fetched: Instant,
}
struct Gateway {
    rest: String,
    reminders: String,
    issuer: String,
    anon: String,
    secret: String,
    http: reqwest::Client,
    keys: Mutex<Option<Keys>>,
    known: Mutex<HashSet<String>>,
    read_only: bool,
}
enum Caller {
    Anon,
    Local(String),
    User(Value),
}
fn times_ok(v: &Value) -> bool {
    let now = millis() as f64 / 1000.0;
    for key in ["exp", "nbf", "iat"] {
        if let Some(v) = v.get(key)
            && !v.is_number()
        {
            return false;
        }
    }
    !v.get("exp")
        .is_some_and(|v| v.as_f64().is_none_or(|t| t <= now.floor()))
        && !v
            .get("nbf")
            .is_some_and(|v| v.as_f64().is_none_or(|t| t > now.floor()))
}
fn validation(alg: Algorithm) -> Validation {
    let mut v = Validation::new(alg);
    v.required_spec_claims.clear();
    v.leeway = 0;
    v.validate_exp = false;
    v.validate_nbf = false;
    v.validate_aud = false;
    v
}
impl Gateway {
    async fn identify(&self, h: &HeaderMap) -> Option<Caller> {
        let raw = h
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let token = if raw
            .get(..6)
            .is_some_and(|s| s.eq_ignore_ascii_case("bearer"))
            && raw.as_bytes().get(6).is_some_and(u8::is_ascii_whitespace)
        {
            raw[6..].trim()
        } else {
            raw.trim()
        };
        if token.is_empty() || token == self.anon {
            return Some(Caller::Anon);
        }
        if !self.secret.is_empty()
            && decode::<Value>(
                token,
                &DecodingKey::from_secret(self.secret.as_bytes()),
                &validation(Algorithm::HS256),
            )
            .ok()
            .is_some_and(|v| times_ok(&v.claims))
        {
            return Some(Caller::Local(token.into()));
        }
        if self.issuer.is_empty() {
            return None;
        }
        let header = decode_header(token).ok()?;
        if !matches!(
            header.alg,
            Algorithm::ES256
                | Algorithm::ES384
                | Algorithm::RS256
                | Algorithm::RS384
                | Algorithm::RS512
                | Algorithm::PS256
                | Algorithm::PS384
                | Algorithm::PS512
                | Algorithm::EdDSA
        ) {
            return None;
        }
        let kid = header.kid.as_deref();
        let mut cache = self.keys.lock().await;
        let expired = cache
            .as_ref()
            .is_none_or(|k| k.fetched.elapsed() > Duration::from_secs(600));
        let missing = cache.as_ref().is_some_and(|k| {
            kid.is_some_and(|id| k.set.find(id).is_none())
                && k.fetched.elapsed() > Duration::from_secs(30)
        });
        if expired || missing {
            let response = self
                .http
                .get(format!("{}/.well-known/jwks.json", self.issuer))
                .timeout(Duration::from_secs(5))
                .send()
                .await
                .ok()?;
            if !response.status().is_success() {
                return None;
            }
            let set = response.json::<JwkSet>().await.ok()?;
            *cache = Some(Keys {
                set,
                fetched: Instant::now(),
            });
        }
        let set = &cache.as_ref()?.set;
        let key = match kid {
            Some(id) => set.find(id)?,
            None => {
                if set.keys.len() != 1 {
                    return None;
                }
                &set.keys[0]
            }
        };
        // JOSE's JWK algorithm/use restrictions remain in force; never use a signing-only or symmetric key.
        if key
            .common
            .key_algorithm
            .as_ref()
            .is_some_and(|a| a.to_string() != format!("{:?}", header.alg))
        {
            return None;
        }
        if key
            .common
            .public_key_use
            .as_ref()
            .is_some_and(|u| *u != PublicKeyUse::Signature)
        {
            return None;
        }
        if key
            .common
            .key_operations
            .as_ref()
            .is_some_and(|ops| !ops.contains(&KeyOperations::Verify))
        {
            return None;
        }
        let decoding = DecodingKey::from_jwk(key).ok()?;
        let mut v = validation(header.alg);
        v.set_issuer(&[&self.issuer]);
        v.set_audience(&["authenticated"]);
        v.validate_aud = true;
        v.set_required_spec_claims(&["iss", "aud"]);
        let claims = decode::<Value>(token, &decoding, &v).ok()?.claims;
        if !times_ok(&claims) || claims["role"] != "authenticated" || !claims["sub"].is_string() {
            return None;
        }
        Some(Caller::User(claims))
    }
    fn sign(&self, claims: &Value) -> Result<String, jsonwebtoken::errors::Error> {
        encode(
            &Header::new(Algorithm::HS256),
            claims,
            &EncodingKey::from_secret(self.secret.as_bytes()),
        )
    }
    fn token(&self, c: &Caller) -> Option<String> {
        match c {
            Caller::Anon => None,
            Caller::Local(t) => Some(t.clone()),
            Caller::User(c) => {
                let now = millis() / 1000;
                let mut out = serde_json::Map::new();
                out.insert("role".into(), json!("authenticated"));
                out.insert("aud".into(), json!("authenticated"));
                out.insert("sub".into(), c["sub"].clone());
                out.insert("iat".into(), json!(now));
                out.insert(
                    "exp".into(),
                    json!(
                        c["exp"]
                            .as_f64()
                            .unwrap_or(f64::INFINITY)
                            .min((now + 3600) as f64)
                    ),
                );
                for key in ["email", "session_id", "aal", "is_anonymous"] {
                    if let Some(v) = c.get(key) {
                        out.insert(key.into(), v.clone());
                    }
                }
                self.sign(&Value::Object(out)).ok()
            }
        }
    }
    async fn profile(&self, id: &str) {
        if self.read_only || self.known.lock().await.contains(id) {
            return;
        }
        let now = millis() / 1000;
        let Ok(token) = self.sign(&json!({"role":"service_role","iat":now,"exp":now+3600})) else {
            return;
        };
        let r = self
            .http
            .post(format!("{}/profiles", self.rest))
            .bearer_auth(token)
            .header("prefer", "resolution=ignore-duplicates,return=minimal")
            .json(&json!({"id":id}))
            .send()
            .await;
        if r.is_ok_and(|r| r.status().is_success()) {
            self.known.lock().await.insert(id.into());
        } else {
            eprintln!("profile creation failed");
        }
    }
}
async fn handle(State(g): State<Arc<Gateway>>, request: Request) -> HttpResponse {
    let path = request
        .uri()
        .path()
        .strip_prefix("/data/")
        .map(|p| format!("/{p}"))
        .unwrap_or_else(|| request.uri().path().into());
    if (path == "/health" || path == "/health/")
        && (request.method() == Method::GET || request.method() == Method::HEAD)
    {
        let ok = g
            .http
            .head(format!("{}/", g.rest))
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .is_ok_and(|r| r.status().as_u16() < 500);
        return util::json(if ok { 200 } else { 503 }, json!({"ok":ok}));
    }
    let function = path.trim_end_matches('/') == "/functions/v1/push-reminders";
    if !function && !path.starts_with("/rest/v1/") {
        return util::text(404, "NOT_FOUND");
    }
    if g.read_only && !matches!(*request.method(), Method::GET | Method::HEAD) {
        return util::json(503, json!({"error":"read only"}));
    }
    let mut headers = request.headers().clone();
    if !function {
        let Some(caller) = g.identify(&headers).await else {
            return util::json(
                401,
                json!({"code":"PGRST301","message":"invalid or expired session"}),
            );
        };
        if let Caller::User(c) = &caller
            && !g.read_only
        {
            g.profile(c["sub"].as_str().unwrap()).await;
        }
        for h in [
            "host",
            "connection",
            "content-length",
            "accept-encoding",
            "apikey",
            "authorization",
            "x-forwarded-for",
            "cf-connecting-ip",
        ] {
            headers.remove(h);
        }
        if let Some(t) = g.token(&caller) {
            let Ok(v) = HeaderValue::from_str(&format!("Bearer {t}")) else {
                return util::json(
                    401,
                    json!({"code":"PGRST301","message":"invalid or expired session"}),
                );
            };
            headers.insert("authorization", v);
        }
    } else {
        for h in ["host", "connection", "content-length", "accept-encoding"] {
            headers.remove(h);
        }
    }
    let target = if function {
        format!("{}/", g.reminders)
    } else {
        format!(
            "{}{}{}",
            g.rest,
            &path[8..],
            request
                .uri()
                .query()
                .map(|q| format!("?{q}"))
                .unwrap_or_default()
        )
    };
    let method = request.method().clone();
    let mut forward = g.http.request(method.clone(), &target).headers(headers);
    if !matches!(method, Method::GET | Method::HEAD) {
        forward = forward.body(reqwest::Body::wrap_stream(
            request.into_body().into_data_stream(),
        ));
    }
    let Ok(upstream) = forward.send().await else {
        return util::json(502, json!({"error":"upstream unreachable"}));
    };
    let mut response = Response::builder().status(upstream.status());
    if function {
        response = response.header(
            "content-type",
            upstream
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("application/json"),
        );
    } else {
        for (name, value) in upstream.headers() {
            if name != "content-encoding"
                && name != "content-length"
                && name != "transfer-encoding"
                && name != "connection"
            {
                response = response.header(name, value);
            }
        }
    }
    response
        .body(Body::from_stream(upstream.bytes_stream()))
        .unwrap()
}
pub fn router() -> Result<Router, Box<dyn std::error::Error>> {
    let base = util::env("SUPABASE_URL", "")
        .trim_end_matches('/')
        .to_string();
    let g = Gateway {
        rest: util::env("REST_URL", "http://apps-rest:3000"),
        reminders: util::env("REMINDERS_URL", "http://apps-reminders:8792")
            .trim_end_matches('/')
            .into(),
        issuer: if base.is_empty() {
            String::new()
        } else {
            format!("{base}/auth/v1")
        },
        anon: util::env("SUPABASE_ANON_KEY", ""),
        secret: util::env("PGRST_JWT_SECRET", ""),
        http: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .build()?,
        keys: Mutex::new(None),
        known: Mutex::new(HashSet::new()),
        read_only: util::env("DBGW_READ_ONLY", "") == "true",
    };
    Ok(Router::new().fallback(handle).with_state(Arc::new(g)))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn temporal_claims() {
        let now = millis() / 1000;
        assert!(times_ok(&json!({})));
        assert!(times_ok(&json!({"exp":now+60,"nbf":now,"iat":now})));
        for v in [
            json!({"exp":now}),
            json!({"nbf":now+1}),
            json!({"exp":"invalid"}),
            json!({"iat":null}),
        ] {
            assert!(!times_ok(&v));
        }
    }
}
