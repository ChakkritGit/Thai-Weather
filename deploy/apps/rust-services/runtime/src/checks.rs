use crate::{
    client::{Failure, Http},
    health::Config,
};
use axum::http::{HeaderMap, HeaderValue, Method};
use serde::Serialize;
use serde_json::Value;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

pub fn millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub id: &'static str,
    pub ok: bool,
    pub ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
}
impl Check {
    fn new(id: &'static str) -> Self {
        Self {
            id,
            ok: false,
            ms: 0,
            reason: None,
            http_status: None,
        }
    }
}
pub fn fresh(value: &Value, now: i64) -> bool {
    value
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|t| t.timestamp_millis())
        .is_some_and(|t| t <= now + 300_000 && now - t <= 26 * 3_600_000)
}
pub async fn simple(http: &Http, config: &Config, music: bool) -> Check {
    let mut result = Check::new(if music { "musicsync" } else { "rooms" });
    let url = format!(
        "{}{}",
        if music { &config.sync } else { &config.rooms },
        if music { "/health" } else { "/__health" }
    );
    for attempt in 0..2 {
        if attempt > 0 {
            tokio::time::sleep(config.retry_delay).await;
        }
        let t = Instant::now();
        let r = http
            .request(
                Method::GET,
                &url,
                HeaderMap::new(),
                Vec::new(),
                config.probe_timeout,
            )
            .await;
        result.ok = r.ok().is_some_and(|r| {
            if !(200..300).contains(&r.status) {
                return false;
            }
            if !music {
                return String::from_utf8_lossy(&r.body).trim() == "ok";
            }
            serde_json::from_slice::<Value>(&r.body)
                .ok()
                .is_some_and(|v| {
                    v["status"] == "ok"
                        && v["service"] == "drive-music-sync"
                        && v["protocol"].as_f64() == Some(2.)
                })
        });
        result.ms = t.elapsed().as_millis() as u64;
        if result.ok {
            break;
        }
    }
    result
}
pub async fn reminders(http: &Http, config: &Config) -> Check {
    let mut result = Check::new("reminders");
    let mut headers = HeaderMap::new();
    headers.insert("content-type", HeaderValue::from_static("application/json"));
    // A malformed configured secret is a failed probe, never an unauthenticated job request.
    let Ok(secret) = HeaderValue::from_str(&config.status_secret) else {
        result.reason = Some("network");
        return result;
    };
    headers.insert("x-status-secret", secret);
    for attempt in 0..2 {
        if attempt > 0 {
            tokio::time::sleep(config.retry_delay).await;
        }
        let t = Instant::now();
        let r = http
            .request(
                Method::POST,
                &config.reminders,
                headers.clone(),
                br#"{"health":true}"#.to_vec(),
                config.probe_timeout,
            )
            .await;
        result.ok = false;
        result.reason = None;
        result.http_status = None;
        match r {
            Err(Failure::Timeout) => result.reason = Some("timeout"),
            Err(Failure::Network) => result.reason = Some("network"),
            Ok(r) if !(200..300).contains(&r.status) => {
                result.reason = Some("http-error");
                result.http_status = Some(r.status);
            }
            Ok(r) => match serde_json::from_slice::<Value>(&r.body)
                .ok()
                .and_then(|v| v.as_object().cloned())
            {
                Some(v) if v.contains_key("lastRun") => {
                    result.ok = fresh(&v["lastRun"], millis());
                    if !result.ok {
                        result.reason = Some("heartbeat-stale");
                    }
                }
                _ => result.reason = Some("invalid-response"),
            },
        }
        result.ms = t.elapsed().as_millis() as u64;
        let transient = matches!(result.reason, Some("timeout" | "network"))
            || (result.reason == Some("http-error")
                && matches!(result.http_status, Some(502..=504)));
        if result.ok || !transient {
            break;
        }
    }
    result
}
#[derive(Debug, Serialize, PartialEq)]
pub struct Container {
    pub name: String,
    pub state: String,
    pub health: Option<&'static str>,
}
pub fn snapshot(text: &str) -> (i64, Vec<Container>) {
    let mut lines = text.trim().split('\n');
    let at = lines
        .next()
        .unwrap_or("")
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|t| t.is_finite())
        .map(|t| (t * 1000.) as i64)
        .unwrap_or(0);
    let mut containers = Vec::new();
    for line in lines {
        let fields: Vec<_> = line.split('\t').collect();
        if fields.len() < 3 || fields[0].is_empty() {
            continue;
        }
        let name = fields[0];
        let name = name
            .rsplit_once('-')
            .filter(|(_, s)| !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit()))
            .map_or(name, |(base, _)| base);
        let status = fields[2];
        let health = if status.contains("(unhealthy)") {
            Some("unhealthy")
        } else if status.contains("(health: starting)") {
            Some("starting")
        } else if status.contains("(healthy)") {
            Some("healthy")
        } else {
            None
        };
        containers.push(Container {
            name: name.into(),
            state: fields[1].into(),
            health,
        });
    }
    containers.sort_by(|a, b| a.name.cmp(&b.name));
    (at, containers)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snapshot_preserves_time_suffix_health_and_missing_file_contract() {
        let (at, c) = snapshot(
            "1792150000\napps-expenses-17\trunning\tUp 2 hours (healthy)\ndock\trunning\tUp 9 hours\napps-chat\trunning\tUp 1 minute (health: starting)\napps-db\texited\tExited (1) 3 minutes ago\napps-rest\trunning\tUp 1 hour (unhealthy)\n",
        );
        assert_eq!(at, 1792150000000);
        assert_eq!(
            c.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(),
            vec!["apps-chat", "apps-db", "apps-expenses", "apps-rest", "dock"]
        );
        assert_eq!(c[0].health, Some("starting"));
        assert_eq!(c[1].health, None);
        assert_eq!(c[2].health, Some("healthy"));
        assert_eq!(c[3].health, Some("unhealthy"));
        assert_eq!(snapshot(""), (0, Vec::new()));
    }
    #[test]
    fn reminder_freshness_boundaries_future_skew_and_invalid_values() {
        let now = 1792300000000i64;
        for (delta, expected) in [
            (-26 * 3_600_000, true),
            (-26 * 3_600_000 - 1, false),
            (300_000, true),
            (300_001, false),
            (0, true),
        ] {
            let time = chrono::DateTime::from_timestamp_millis(now + delta)
                .unwrap()
                .to_rfc3339();
            assert_eq!(fresh(&Value::String(time), now), expected);
        }
        for v in [Value::Null, Value::Bool(true), Value::String("bad".into())] {
            assert!(!fresh(&v, now));
        }
    }
}
