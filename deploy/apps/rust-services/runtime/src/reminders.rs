//! Bill reminders with committed daily receipts and no replay after uncertain delivery.
use crate::{
    chat_report as r,
    checks::millis,
    push::{self, Error},
    util,
};
use axum::{
    Router,
    body::Bytes,
    extract::State,
    http::{HeaderMap, Method},
    response::Response,
};
use chrono::{Datelike, NaiveDate};
use futures_util::{StreamExt, stream};
use jsonwebtoken::{EncodingKey, Header, encode};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    sync::Arc,
    time::Duration,
};
struct App {
    client: reqwest::Client,
    push_client: reqwest::Client,
    jobs_disabled: bool,
    run_lock: tokio::sync::Mutex<()>,
}
fn add(day: &str, n: i64) -> Result<String, Error> {
    Ok(
        (NaiveDate::parse_from_str(day, "%Y-%m-%d")? + chrono::Duration::days(n))
            .format("%Y-%m-%d")
            .to_string(),
    )
}
fn next_month(m: &str) -> String {
    let d = NaiveDate::parse_from_str(&format!("{m}-01"), "%Y-%m-%d").unwrap();
    format!(
        "{:04}-{:02}-01",
        d.year() + i32::from(d.month() == 12),
        d.month() % 12 + 1
    )
}
fn amount(v: &Value) -> f64 {
    v.as_f64()
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        .unwrap_or(0.)
}
fn money(v: f64) -> String {
    let s = format!("{v:.2}");
    let parts = s.split('.').collect::<Vec<_>>();
    let raw = parts[0];
    let count = raw.len();
    let a = raw
        .chars()
        .enumerate()
        .flat_map(|(i, c)| {
            if i > 0 && c != '-' && (count - i).is_multiple_of(3) && raw.as_bytes()[i - 1] != b'-' {
                vec![',', c]
            } else {
                vec![c]
            }
        })
        .collect::<String>();
    let fraction = parts[1].trim_end_matches('0');
    format!(
        "฿{a}{}",
        if fraction.is_empty() {
            String::new()
        } else {
            format!(".{fraction}")
        }
    )
}
fn reminder(entries: &[Value], today: &str) -> Result<Option<Value>, Error> {
    let tomorrow = add(today, 1)?;
    let mut overdue = entries
        .iter()
        .filter(|e| e["due_date"].as_str().is_some_and(|d| d < today))
        .collect::<Vec<_>>();
    overdue.sort_by_key(|e| e["due_date"].as_str());
    let today_rows = entries
        .iter()
        .filter(|e| e["due_date"] == today)
        .collect::<Vec<_>>();
    let tomorrow_rows = entries
        .iter()
        .filter(|e| e["due_date"] == tomorrow)
        .collect::<Vec<_>>();
    let title = if !overdue.is_empty() {
        format!("เกินกำหนด {} รายการ", overdue.len())
    } else if !today_rows.is_empty() {
        format!("ครบกำหนดวันนี้ {} รายการ", today_rows.len())
    } else if !tomorrow_rows.is_empty() {
        format!("พรุ่งนี้ครบกำหนด {} รายการ", tomorrow_rows.len())
    } else {
        return Ok(None);
    };
    let body = [
        ("เกินกำหนด", overdue),
        ("ครบวันนี้", today_rows),
        ("พรุ่งนี้", tomorrow_rows),
    ]
    .iter()
    .filter(|(_, es)| !es.is_empty())
    .map(|(label, es)| {
        format!(
            "{label}: {}{}",
            es.iter()
                .take(3)
                .map(|e| format!(
                    "{} {}",
                    e["name"].as_str().unwrap_or(""),
                    money(amount(&e["amount"]))
                ))
                .collect::<Vec<_>>()
                .join(", "),
            if es.len() > 3 {
                format!(" และอีก {} รายการ", es.len() - 3)
            } else {
                String::new()
            }
        )
    })
    .collect::<Vec<_>>()
    .join("\n");
    Ok(Some(json!({"title":title,"body":body,"url":"/"})))
}
fn missing(plans: &Value, existing: &Value, m: &str) -> Vec<Value> {
    let users = r::arr(existing)
        .iter()
        .filter_map(|v| v["user_id"].as_str())
        .collect::<HashSet<_>>();
    r::arr(plans).iter().filter(|p|p["active"]==true&&!users.contains(p["user_id"].as_str().unwrap_or(""))).map(|p|json!({"user_id":p["user_id"],"plan_id":p["id"],"name":p["name"],"amount":amount(&p["amount"]),"category":p["category"],"due_date":format!("{m}-{:02}",(amount(&p["day_of_month"]) as u32).min(r::days(m))),"paid_at":null})).collect()
}
fn next_run(now: i64) -> i64 {
    let mut at = now.div_euclid(600_000) * 600_000 + 600_000;
    while !(1..=16).contains(&at.div_euclid(3_600_000).rem_euclid(24)) {
        at += 600_000;
    }
    at
}
fn list_filter(v: impl Iterator<Item = String>) -> String {
    format!(
        "in.({})",
        v.map(|s| format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\"")))
            .collect::<Vec<_>>()
            .join(",")
    )
}
impl App {
    async fn db(
        &self,
        method: &str,
        path: &str,
        query: &[(&str, String)],
        body: Option<Value>,
        prefer: &str,
        timeout: u64,
    ) -> Result<Value, Error> {
        let url = format!(
            "{}/rest/v1/{path}",
            util::env("DB_URL", "http://apps-dbgw:8791").trim_end_matches('/')
        );
        let now = millis() / 1000;
        let token = encode(
            &Header::default(),
            &json!({"role":"service_role","iat":now,"exp":now+600}),
            &EncodingKey::from_secret(util::env("PGRST_JWT_SECRET", "").as_bytes()),
        )?;
        let method = reqwest::Method::from_bytes(method.as_bytes())?;
        // The deadline covers all clock-skew retries too, especially the read-only status probe.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout);
        for attempt in 0..=2 {
            let mut req = self
                .client
                .request(method.clone(), &url)
                .query(query)
                .bearer_auth(&token)
                .header("apikey", &token)
                .timeout(deadline.saturating_duration_since(tokio::time::Instant::now()));
            if !prefer.is_empty() {
                req = req.header("prefer", prefer);
            }
            if let Some(v) = &body {
                req = req.json(v);
            }
            let response = req.send().await?;
            let status = response.status();
            let b = response.bytes().await?;
            let v: Value = if b.is_empty() {
                Value::Null
            } else {
                serde_json::from_slice(&b)?
            };
            if attempt < 2
                && status.as_u16() == 401
                && v["code"] == "PGRST303"
                && v["message"] == "JWT issued at future"
            {
                let wait = Duration::from_secs(attempt + 1);
                if tokio::time::Instant::now() + wait >= deadline {
                    return Err("database deadline".into());
                }
                tokio::time::sleep(wait).await;
                continue;
            }
            if !status.is_success() {
                return Err(format!("database request failed ({status})").into());
            }
            return Ok(v);
        }
        unreachable!()
    }
    async fn heartbeat(&self) -> Result<Option<String>, Error> {
        let v = self
            .db(
                "GET",
                "heartbeats",
                &[
                    ("name", "eq.push-reminders".into()),
                    ("select", "at".into()),
                    ("limit", "1".into()),
                ],
                None,
                "",
                5,
            )
            .await?;
        let rows = v.as_array().ok_or("invalid heartbeat response")?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        let at = row["at"].as_str().ok_or("invalid heartbeat timestamp")?;
        chrono::DateTime::parse_from_rfc3339(at)?;
        Ok(Some(at.into()))
    }
    async fn ensure_months(&self, today: &str) -> Result<(), Error> {
        let tomorrow = add(today, 1)?;
        let mut months = vec![today[..7].to_string()];
        if tomorrow[..7] != today[..7] {
            months.push(tomorrow[..7].into());
        }
        for m in months {
            let plan_query = [
                (
                    "select",
                    "id,user_id,name,amount,category,day_of_month,active".into(),
                ),
                ("active", "eq.true".into()),
            ];
            let existing_query = [
                ("select", "user_id".into()),
                ("plan_id", "not.is.null".into()),
                ("due_date", format!("gte.{m}-01")),
                ("due_date", format!("lt.{}", next_month(&m))),
            ];
            let (plans, existing) = tokio::try_join!(
                self.db("GET", "plans", &plan_query, None, "", 30),
                self.db("GET", "entries", &existing_query, None, "", 30)
            )?;
            if !plans.is_array() || !existing.is_array() {
                return Err("invalid plan response".into());
            }
            let rows = missing(&plans, &existing, &m);
            if !rows.is_empty() {
                self.db(
                    "POST",
                    "entries",
                    &[("on_conflict", "plan_id,due_date".into())],
                    Some(json!(rows)),
                    "resolution=ignore-duplicates,return=minimal",
                    30,
                )
                .await?;
            }
        }
        Ok(())
    }
    async fn one(&self, sub: &Value, msg: &Value, day: &str) -> Result<Delivery, Error> {
        let endpoint = sub["endpoint"].as_str().ok_or("missing push endpoint")?;
        // Users write their own push_subscriptions rows: only POST to a browser push service,
        // never to an arbitrary host they chose (chat checks the same list when subscribing).
        if !push::allowed(endpoint) {
            return Ok(Delivery {
                failed: 1,
                ..Delivery::default()
            });
        }
        let hash = format!("{:x}", Sha256::digest(endpoint.as_bytes()));
        let token = uuid::Uuid::new_v4().to_string();
        let params =
            json!({"p_day":day,"p_user":sub["user_id"],"p_endpoint_hash":hash,"p_claim":token});
        let claim = self
            .db(
                "POST",
                "rpc/claim_reminder_delivery",
                &[],
                Some(params.clone()),
                "",
                30,
            )
            .await?;
        let claim = claim.as_str().ok_or("invalid receipt claim")?;
        match claim {
            "sent" => {
                return Ok(Delivery {
                    already: 1,
                    ..Default::default()
                });
            }
            "gone" => {
                return Ok(Delivery {
                    gone: Some(endpoint.into()),
                    ..Default::default()
                });
            }
            "busy" => {
                return Ok(Delivery {
                    failed: 1,
                    pending: 1,
                    ..Default::default()
                });
            }
            "uncertain" => {
                return Ok(Delivery {
                    failed: 1,
                    uncertain: 1,
                    ..Default::default()
                });
            }
            "exhausted" => {
                return Ok(Delivery {
                    failed: 1,
                    ..Default::default()
                });
            }
            "claimed" => {}
            _ => return Err("invalid receipt claim".into()),
        }
        let keys = json!({"publicKey":util::env("VAPID_PUBLIC_KEY",""),"privateJwk":{"d":util::env("VAPID_PRIVATE_KEY","")}});
        let outcome = match push::send(
            &self.push_client,
            &keys,
            endpoint,
            sub["p256dh"].as_str().unwrap_or(""),
            sub["auth"].as_str().unwrap_or(""),
            msg,
            push::Options {
                ttl: "43200",
                topic: Some(&format!("bill-reminder-{}", day.replace('-', ""))),
                subject: &util::env("VAPID_SUBJECT", "https://expenses.chakkritton.com"),
            },
        )
        .await
        {
            Ok(s) if (200..300).contains(&s) => "sent",
            Ok(404 | 410) => "gone",
            Ok(400..=599) => "failed",
            _ => "uncertain",
        };
        let mut finish = params;
        finish["p_outcome"] = json!(outcome);
        let ack = self
            .db(
                "POST",
                "rpc/finish_reminder_delivery",
                &[],
                Some(finish),
                "",
                30,
            )
            .await?;
        if ack != true {
            return Err("daily receipt was not confirmed".into());
        }
        Ok(match outcome {
            "sent" => Delivery {
                sent: 1,
                ..Default::default()
            },
            "gone" => Delivery {
                gone: Some(endpoint.into()),
                ..Default::default()
            },
            "uncertain" => Delivery {
                failed: 1,
                uncertain: 1,
                ..Default::default()
            },
            _ => Delivery {
                failed: 1,
                ..Default::default()
            },
        })
    }
    async fn run(&self) -> Result<(u16, Value), Error> {
        if self.jobs_disabled {
            return Ok((503, json!({"error":"jobs disabled"})));
        }
        let _guard = self.run_lock.lock().await;
        let today = r::day(millis());
        let config = self
            .db(
                "GET",
                "reminder_retry_config",
                &[
                    ("select", "start_day".into()),
                    ("singleton", "eq.true".into()),
                ],
                None,
                "",
                30,
            )
            .await?;
        let rows = config.as_array().ok_or("invalid retry configuration")?;
        if rows.len() != 1 {
            return Err("missing retry configuration".into());
        }
        let start = rows[0]["start_day"]
            .as_str()
            .ok_or("missing retry configuration")?;
        NaiveDate::parse_from_str(start, "%Y-%m-%d")?;
        if today.as_str() < start {
            return Ok((200, json!({"skipped":"rollout","startDay":start})));
        }
        if let Some(at) = self.heartbeat().await?
            && r::day(chrono::DateTime::parse_from_rfc3339(&at)?.timestamp_millis()) == today
        {
            return Ok((200, json!({"skipped":"already completed"})));
        }
        self.ensure_months(&today).await?;
        let entries = self
            .db(
                "GET",
                "entries",
                &[
                    ("select", "user_id,name,amount,due_date".into()),
                    ("paid_at", "is.null".into()),
                    ("due_date", format!("lte.{}", add(&today, 1)?)),
                ],
                None,
                "",
                30,
            )
            .await?;
        let mut byuser = BTreeMap::<String, Vec<Value>>::new();
        for e in entries.as_array().ok_or("invalid entries")? {
            byuser
                .entry(e["user_id"].as_str().ok_or("missing user")?.into())
                .or_default()
                .push(e.clone());
        }
        let mut messages = BTreeMap::<String, Value>::new();
        for (user, es) in byuser {
            if let Some(m) = reminder(&es, &today)? {
                messages.insert(user, m);
            }
        }
        let mut result = json!({"users":messages.len(),"sent":0,"removed":0,"failed":0,"alreadySent":0,"uncertain":0,"pending":0});
        if !messages.is_empty() {
            let subs = self
                .db(
                    "GET",
                    "push_subscriptions",
                    &[
                        ("select", "endpoint,p256dh,auth,user_id".into()),
                        ("user_id", list_filter(messages.keys().cloned())),
                    ],
                    None,
                    "",
                    30,
                )
                .await?;
            let mut gone = Vec::<String>::new();
            let results = stream::iter(subs.as_array().ok_or("invalid subscriptions")?.clone())
                .map(|sub| {
                    let messages = &messages;
                    let today = &today;
                    async move {
                        let Some(msg) = messages.get(sub["user_id"].as_str().unwrap_or("")) else {
                            return Err("unexpected subscription user".into());
                        };
                        self.one(&sub, msg, today).await
                    }
                })
                .buffer_unordered(8)
                .collect::<Vec<Result<Delivery, Error>>>()
                .await;
            for outcome in results {
                let d = outcome.unwrap_or(Delivery {
                    failed: 1,
                    pending: 1,
                    ..Default::default()
                });
                for (k, v) in [
                    ("sent", d.sent),
                    ("failed", d.failed),
                    ("alreadySent", d.already),
                    ("uncertain", d.uncertain),
                    ("pending", d.pending),
                ] {
                    result[k] = json!(result[k].as_u64().unwrap() + v);
                }
                if let Some(e) = d.gone {
                    gone.push(e);
                }
            }
            result["removed"] = json!(gone.len());
            if !gone.is_empty() {
                self.db(
                    "DELETE",
                    "push_subscriptions",
                    &[("endpoint", list_filter(gone.into_iter()))],
                    None,
                    "",
                    30,
                )
                .await?;
            }
        }
        if result["failed"].as_u64().unwrap() > 0 {
            result["error"] = json!("delivery failed");
            return Ok((503, result));
        }
        self.db("POST","heartbeats",&[],Some(json!({"name":"push-reminders","at":chrono::DateTime::from_timestamp_millis(millis()).unwrap().to_rfc3339_opts(chrono::SecondsFormat::Millis,true)})),"resolution=merge-duplicates,return=minimal",30).await?;
        Ok((200, result))
    }
}
#[derive(Default)]
struct Delivery {
    sent: u64,
    failed: u64,
    already: u64,
    uncertain: u64,
    pending: u64,
    gone: Option<String>,
}
async fn handle(
    a: Arc<App>,
    method: Method,
    h: HeaderMap,
    b: Bytes,
) -> Result<(u16, Value), Error> {
    if method == Method::OPTIONS {
        return Ok((200, Value::Null));
    }
    if let Some(status) = h.get("x-status-secret") {
        if !util::secret(
            status.to_str().unwrap_or(""),
            &util::env("STATUS_SECRET", ""),
        ) {
            return Ok((403, json!({"error":"forbidden"})));
        }
        let v: Value = serde_json::from_slice(&b).unwrap_or(Value::Null);
        if v["health"] != true {
            return Ok((400, json!({"error":"bad request"})));
        }
        return Ok((200, json!({"lastRun":a.heartbeat().await?})));
    }
    if let Some(cron) = h.get("x-cron-secret") {
        if !util::secret(
            cron.to_str().unwrap_or(""),
            &util::env("PUSH_CRON_SECRET", ""),
        ) {
            return Ok((403, json!({"error":"forbidden"})));
        }
        return a.run().await;
    }
    Ok((401, json!({"error":"unauthorized"})))
}
async fn handler(State(a): State<Arc<App>>, method: Method, h: HeaderMap, b: Bytes) -> Response {
    let (status, v) = handle(a, method.clone(), h, b).await.unwrap_or_else(|_| {
        eprintln!("reminders request failed");
        (500, json!({"error":"failed"}))
    });
    let mut res = if method == Method::OPTIONS {
        util::text(status, "")
    } else {
        util::json(status, v)
    };
    res.headers_mut()
        .insert("access-control-allow-origin", "*".parse().unwrap());
    res.headers_mut().insert(
        "access-control-allow-headers",
        "authorization, x-client-info, apikey, content-type"
            .parse()
            .unwrap(),
    );
    res
}
pub fn router() -> Result<Router, Error> {
    let a = Arc::new(App {
        client: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()?,
        push_client: push::client(10)?,
        jobs_disabled: util::env("REMINDERS_JOBS_DISABLED", "") == "true",
        run_lock: tokio::sync::Mutex::new(()),
    });
    if !a.jobs_disabled && util::env("REMINDERS_SCHEDULE_DISABLED", "") != "true" {
        let a = a.clone();
        tokio::spawn(async move {
            loop {
                let now = millis();
                tokio::time::sleep(Duration::from_millis((next_run(now) - now) as u64)).await;
                if a.run().await.is_err() {
                    eprintln!("reminders scheduled work failed");
                }
            }
        });
    }
    Ok(Router::new()
        .route(
            "/health",
            axum::routing::get(|| async { util::json(200, json!({"ok":true})) }),
        )
        .route("/", axum::routing::any(handler))
        .with_state(a))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn schedule_months_and_messages() {
        let at = |s: &str| {
            chrono::DateTime::parse_from_rfc3339(s)
                .unwrap()
                .timestamp_millis()
        };
        assert_eq!(
            next_run(at("2026-10-19T00:59:59Z")),
            at("2026-10-19T01:00:00Z")
        );
        assert_eq!(
            next_run(at("2026-10-19T16:50:00Z")),
            at("2026-10-20T01:00:00Z")
        );
        let rows = missing(
            &json!([{"active":true,"id":"p","user_id":"u","day_of_month":31,"name":"Test","amount":"1234.50","category":"bill"}]),
            &json!([]),
            "2028-02",
        );
        assert_eq!(rows[0]["due_date"], "2028-02-29");
        assert!(
            missing(
                &json!([{"active":true,"user_id":"u"}]),
                &json!([{"user_id":"u"}]),
                "2026-10"
            )
            .is_empty()
        );
        assert_eq!(money(1234.5), "฿1,234.5");
        let m = reminder(
            &[
                json!({"name":"Old","amount":100,"due_date":"2026-10-18"}),
                json!({"name":"Now","amount":200,"due_date":"2026-10-19"}),
            ],
            "2026-10-19",
        )
        .unwrap()
        .unwrap();
        assert_eq!(m["title"], "เกินกำหนด 1 รายการ");
        assert_eq!(m["body"], "เกินกำหนด: Old ฿100\nครบวันนี้: Now ฿200");
    }
}
