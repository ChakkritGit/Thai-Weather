//! Dock conversation, monthly reports and Web Push, preserving the existing SQLite database.
use crate::util::Locked;
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
    http::{HeaderMap, Method, Uri},
    response::Response,
};
use futures_util::{StreamExt, stream};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
const HELP: &str = "พิมพ์ได้แบบนี้\n• สรุป — สรุปเดือนนี้ถึงวันนี้\n• เดือนก่อน — สรุปเดือนที่แล้ว\n• ช่วย — คำสั่งทั้งหมด\nทุกสิ้นเดือน (23:55) ระบบจะส่งสรุปของเดือนมาที่นี่เอง";
struct App {
    db: Mutex<Connection>,
    client: reqwest::Client,
    push_client: reqwest::Client,
    readonly: bool,
}
impl App {
    fn post(
        &self,
        role: &str,
        text: &str,
        kind: Option<&str>,
        data: &Value,
    ) -> Result<Value, Error> {
        let ts = millis();
        let read = i64::from(role != "system");
        let db = self.db.locked();
        db.execute(
            "INSERT INTO messages(ts,role,text,read,kind,data) VALUES(?,?,?,?,?,?)",
            params![
                ts,
                role,
                text,
                read,
                kind,
                if data.is_null() {
                    None
                } else {
                    Some(data.to_string())
                }
            ],
        )?;
        Ok(
            json!({"id":db.last_insert_rowid(),"ts":ts,"role":role,"text":text,"read":read,"kind":kind,"data":data}),
        )
    }
    fn keys(&self) -> Result<Value, Error> {
        let db = self.db.locked();
        let row = db
            .query_row("SELECT value FROM settings WHERE key='vapid'", [], |r| {
                r.get::<_, String>(0)
            })
            .optional()?;
        if let Some(v) = row {
            return Ok(serde_json::from_str(&v)?);
        }
        if self.readonly {
            return Err("VAPID key unavailable in read-only mode".into());
        }
        let keys = push::generate();
        db.execute(
            "INSERT OR IGNORE INTO settings(key,value) VALUES('vapid',?)",
            [keys.to_string()],
        )?;
        Ok(keys)
    }
    fn subs(&self) -> Result<Vec<Value>, Error> {
        let db = self.db.locked();
        let mut q = db.prepare("SELECT endpoint,p256dh,auth FROM push_subs")?;
        Ok(q.query_map([],|r|Ok(json!({"endpoint":r.get::<_,String>(0)?,"p256dh":r.get::<_,String>(1)?,"auth":r.get::<_,String>(2)?})))?.collect::<Result<Vec<_>,_>>()?)
    }
    async fn push_one(&self, sub: &Value, msg: &Value) -> Result<u16, Error> {
        let keys = self.keys()?;
        let endpoint = sub["endpoint"].as_str().ok_or("missing endpoint")?;
        let status = push::send(
            &self.push_client,
            &keys,
            endpoint,
            sub["p256dh"].as_str().ok_or("missing key")?,
            sub["auth"].as_str().ok_or("missing auth")?,
            msg,
            push::Options {
                ttl: "86400",
                topic: None,
                subject: &util::env("VAPID_SUBJECT", "https://docker.chakkritton.com"),
            },
        )
        .await?;
        if status == 404 || status == 410 {
            self.db
                .locked()
                .execute("DELETE FROM push_subs WHERE endpoint=?", [endpoint])?;
        }
        Ok(status)
    }
    async fn push_all(&self, msg: Value) {
        let subs = self.subs().unwrap_or_default();
        stream::iter(subs)
            .map(|s| {
                let msg = &msg;
                async move {
                    let _ = self.push_one(&s, msg).await;
                }
            })
            .buffer_unordered(8)
            .collect::<Vec<_>>()
            .await;
    }
    async fn get(&self, url: String) -> Value {
        match self
            .client
            .get(url)
            .timeout(Duration::from_secs(15))
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => r.json().await.unwrap_or(Value::Null),
            _ => Value::Null,
        }
    }
    async fn collect(&self, now: i64) -> Result<(), Error> {
        let m = self
            .get(format!(
                "{}/metrics?range=7d",
                util::env("METRICS_URL", "http://dock-metrics:9100")
            ))
            .await;
        if m.is_null() {
            return Ok(());
        }
        let a = self
            .get(format!(
                "{}/stats?days=8",
                util::env("ANALYTICS_URL", "http://apps-analytics:8790")
            ))
            .await;
        let today = r::day(now);
        let minutes = (now + 25_200_000).rem_euclid(r::DAY) / 60_000;
        let db = self.db.locked();
        for k in (0..=6).rev() {
            let day = r::day(now - k * r::DAY);
            if day == today && minutes < 1430 {
                continue;
            }
            let have = db
                .query_row("SELECT 1 FROM digests WHERE day=?", [&day], |r| {
                    r.get::<_, i64>(0)
                })
                .optional()?
                .is_some();
            if !have && let Some(d) = r::digest(&day, &m, &a) {
                db.execute(
                    "INSERT OR IGNORE INTO digests(day,data) VALUES(?,?)",
                    params![day, d.to_string()],
                )?;
            }
        }
        Ok(())
    }
    async fn report(&self, month: &str, now: i64) -> Result<(String, Value), Error> {
        let ds = {
            let db = self.db.locked();
            let mut q = db.prepare("SELECT data FROM digests WHERE day LIKE ? ORDER BY day")?;
            q.query_map([format!("{month}-%")], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .map(|s| serde_json::from_str::<Value>(&s))
                .collect::<Result<Vec<_>, _>>()?
        };
        let today = r::day(now);
        let current = today.starts_with(month);
        let days = (((now - r::start(&format!("{month}-01")).ok_or("invalid report month")?) as f64
            / r::DAY as f64)
            .round() as i64
            + 1)
        .max(1);
        let raw = self
            .get(format!(
                "{}/stats?days={}",
                util::env("ANALYTICS_URL", "http://apps-analytics:8790"),
                days.min(400)
            ))
            .await;
        let inmonth = r::arr(&raw["series"])
            .iter()
            .filter(|v| v["day"].as_str().is_some_and(|d| d.starts_with(month)))
            .cloned()
            .collect::<Vec<_>>();
        let an = if raw.is_null() {
            Value::Null
        } else {
            json!({"totals":{"views":inmonth.iter().map(|s|r::n(&s["views"])).sum::<f64>(),"visitors":inmonth.iter().map(|s|r::n(&s["visitors"])).sum::<f64>()},"perHost":if current&&days<=31{raw["perHost"].clone()}else{json!([])}})
        };
        let (status, backups) = tokio::join!(
            self.get(format!(
                "{}/api/status",
                util::env("STATUS_URL", "https://status.chakkritton.com")
            )),
            self.get(format!(
                "{}/backups",
                util::env("BACKUP_URL", "http://apps-backup:8794")
            ))
        );
        let e = json!({"analytics":an,"visitorsDaily":inmonth,"status":status,"backups":backups,"untilDay":if current{today[8..].parse::<u32>().ok()}else{None}});
        Ok(r::report(month, &ds, &e, now))
    }
    /// Relays new alert events of Dock's security watch (dock-metrics /security/outbox) into the chat
    /// and to every subscribed device. The first pass only records where the outbox is, so nothing
    /// that happened before is replayed; a reset watch (its ids start again) is re-anchored the same way.
    async fn security_alerts(&self, metrics: &str) -> Result<(), Error> {
        let seen = self
            .db
            .locked()
            .query_row(
                "SELECT value FROM settings WHERE key='security_seen'",
                [],
                |r| r.get::<_, String>(0),
            )
            .optional()?
            .and_then(|v| v.parse::<u64>().ok());
        let out = self
            .get(format!(
                "{metrics}/security/outbox?after={}",
                seen.unwrap_or(0)
            ))
            .await;
        let Some(last) = out["last"].as_u64() else {
            return Ok(());
        };
        let store = |id: u64| {
            self.db.locked().execute(
                "INSERT INTO settings(key,value) VALUES('security_seen',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                [id.to_string()],
            )
        };
        let Some(seen) = seen.filter(|s| *s <= last) else {
            store(last)?;
            return Ok(());
        };
        let events: Vec<&Value> = out["events"]
            .as_array()
            .map(|e| e.iter().filter(|e| e["id"].as_u64() > Some(seen)).collect())
            .unwrap_or_default();
        let Some(newest) = events.iter().filter_map(|e| e["id"].as_u64()).max() else {
            return Ok(());
        };
        let text = |e: &Value, key: &str| e[key].as_str().unwrap_or("").to_string();
        let (title, body) = match events.as_slice() {
            [one] => (text(one, "title"), text(one, "detail")),
            many => (
                format!("ความปลอดภัย: {} เรื่องใหม่", many.len()),
                many.iter()
                    .take(6)
                    .map(|e| format!("• {}", text(e, "title")))
                    .collect::<Vec<_>>()
                    .join("\n"),
            ),
        };
        let link = format!(
            "ดูรายละเอียด: {}/#/security",
            util::env("DOCK_URL", "https://docker.chakkritton.com")
        );
        let message = [title.as_str(), body.as_str(), link.as_str()]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        self.post("system", &message, Some("security"), &Value::Null)?;
        store(newest)?;
        let short: String = body.chars().take(400).collect();
        self.push_all(json!({"title":title,"body":short,"url":"/#/security","tag":format!("security-{newest}")}))
            .await;
        Ok(())
    }
    async fn scheduled(&self, now: i64) -> Result<(), Error> {
        self.collect(now).await?;
        let Some(due) = due(now) else {
            return Ok(());
        };
        {
            let db = self.db.locked();
            if db
                .query_row("SELECT 1 FROM reports WHERE month=?", [&due], |r| {
                    r.get::<_, i64>(0)
                })
                .optional()?
                .is_some()
                || db
                    .query_row(
                        "SELECT 1 FROM digests WHERE day LIKE ? LIMIT 1",
                        [format!("{due}-%")],
                        |r| r.get::<_, i64>(0),
                    )
                    .optional()?
                    .is_none()
            {
                return Ok(());
            }
        }
        let (text, data) = self.report(&due, now).await?;
        {
            let mut db = self.db.locked();
            let tx = db.transaction()?;
            if tx
                .query_row("SELECT 1 FROM reports WHERE month=?", [&due], |r| {
                    r.get::<_, i64>(0)
                })
                .optional()?
                .is_some()
            {
                return Ok(());
            }
            tx.execute("INSERT INTO messages(ts,role,text,read,kind,data) VALUES(?,'system',?,0,'report',?)",params![millis(),text,data.to_string()])?;
            tx.execute(
                "INSERT INTO reports(month,message_id) VALUES(?,?)",
                params![due, tx.last_insert_rowid()],
            )?;
            tx.commit()?;
        }
        self.push_all(json!({"title":"Dock","body":format!("{} — แตะเพื่ออ่าน",text.lines().next().unwrap_or("")),"url":"/#/chat","tag":format!("report-{due}")})).await;
        Ok(())
    }
    async fn reply(&self, text: &str) -> Result<(String, Option<&'static str>, Value), Error> {
        let t = text.trim().to_lowercase();
        let matches = |xs: &[&str]| xs.iter().any(|s| t.starts_with(s));
        if matches(&["ช่วย", "help", "/help", "คำสั่ง"]) {
            return Ok((HELP.into(), None, Value::Null));
        }
        let now = millis();
        let month = r::day(now)[..7].to_string();
        if matches(&[
            "สรุป",
            "รายงาน",
            "report",
            "/report",
            "เดือนก่อน",
            "เดือนที่แล้ว",
            "last month",
        ]) {
            let m = if matches(&["เดือนก่อน", "เดือนที่แล้ว", "last month"])
            {
                r::previous(&month)
            } else {
                month
            };
            let (t, d) = self.report(&m, now).await?;
            return Ok((t, Some("report"), d));
        }
        if !llm() {
            return Ok((
                format!(
                    "ยังไม่ได้เชื่อม LLM จึงตอบได้เฉพาะคำสั่ง\n\n{HELP}\n\nต่อ LLM ได้ภายหลัง: Cloudflare Workers AI หรือเซิร์ฟเวอร์ที่ host เอง (ตั้งค่าใน chat.env)"
                ),
                None,
                Value::Null,
            ));
        }
        let context = self.report(&month, now).await?.0;
        let mut messages = vec![
            json!({"role":"system","content":format!("คุณคือผู้ช่วยดูแลเซิร์ฟเวอร์ VPS ของเจ้าของระบบ ตอบเป็นภาษาไทย สั้น ตรงประเด็น ไม่เดา ถ้าข้อมูลไม่พอให้บอกตรง ๆ\nข้อมูลล่าสุดของระบบ:\n{context}")}),
        ];
        let mut history = {
            let db = self.db.locked();
            let mut q = db.prepare(
                "SELECT role,text FROM messages WHERE role!='system' ORDER BY id DESC LIMIT 12",
            )?;
            q.query_map([],|r|Ok(json!({"role":if r.get::<_,String>(0)?=="user"{"user"}else{"assistant"},"content":r.get::<_,String>(1)?})))?.collect::<Result<Vec<_>,_>>()?
        };
        history.reverse();
        messages.extend(history);
        let cf = util::env("LLM_PROVIDER", "") == "cloudflare";
        let (url, body, key) = if cf {
            (
                format!(
                    "https://api.cloudflare.com/client/v4/accounts/{}/ai/run/{}",
                    util::env("CF_ACCOUNT_ID", ""),
                    util::env("CF_AI_MODEL", "@cf/meta/llama-3.3-70b-instruct-fp8-fast")
                ),
                json!({"messages":messages,"max_tokens":800}),
                util::env("CF_API_TOKEN", ""),
            )
        } else {
            (
                format!(
                    "{}/chat/completions",
                    util::env("LLM_BASE_URL", "").trim_end_matches('/')
                ),
                json!({"messages":messages,"model":util::env("LLM_MODEL",""),"max_tokens":800}),
                util::env("LLM_API_KEY", ""),
            )
        };
        let mut request = self
            .client
            .post(url)
            .json(&body)
            .timeout(Duration::from_secs(if cf { 90 } else { 120 }));
        if !key.is_empty() {
            request = request.bearer_auth(key);
        }
        let res = request.send().await?;
        let status = res.status();
        let j: Value = res.json().await?;
        let content = if cf {
            j["result"]["response"].as_str()
        } else {
            j["choices"][0]["message"]["content"].as_str()
        };
        if !status.is_success() || content.is_none_or(|s| s.is_empty()) {
            return Err(if cf {
                j["errors"][0]["message"]
                    .as_str()
                    .unwrap_or("Workers AI failed")
            } else {
                j["error"]["message"].as_str().unwrap_or("LLM failed")
            }
            .to_string()
            .into());
        }
        Ok((content.unwrap().trim().into(), None, Value::Null))
    }
}
fn due(now: i64) -> Option<String> {
    let today = r::day(now);
    let month = &today[..7];
    let d = today[8..].parse::<u32>().ok()?;
    let minutes = (now + 25_200_000).rem_euclid(r::DAY) / 60_000;
    if d == r::days(month) && minutes >= 1435 {
        Some(month.into())
    } else if d <= 3 {
        Some(r::previous(month))
    } else {
        None
    }
}
fn llm() -> bool {
    match util::env("LLM_PROVIDER", "").as_str() {
        "cloudflare" => {
            !util::env("CF_ACCOUNT_ID", "").is_empty() && !util::env("CF_API_TOKEN", "").is_empty()
        }
        "openai" => {
            !util::env("LLM_BASE_URL", "").is_empty() && !util::env("LLM_MODEL", "").is_empty()
        }
        _ => false,
    }
}
fn query(uri: &Uri) -> std::collections::HashMap<String, String> {
    url::form_urlencoded::parse(uri.query().unwrap_or("").as_bytes())
        .into_owned()
        .collect()
}
fn message(row: &rusqlite::Row) -> rusqlite::Result<Value> {
    let data: Option<String> = row.get(6)?;
    Ok(
        json!({"id":row.get::<_,i64>(0)?,"ts":row.get::<_,i64>(1)?,"role":row.get::<_,String>(2)?,"text":row.get::<_,String>(3)?,"read":row.get::<_,i64>(4)?,"kind":row.get::<_,Option<String>>(5)?,"data":data.and_then(|s|serde_json::from_str::<Value>(&s).ok())}),
    )
}
async fn handle(
    a: Arc<App>,
    method: Method,
    uri: Uri,
    h: HeaderMap,
    b: Bytes,
) -> Result<Response, Error> {
    let path = uri.path().trim_end_matches('/');
    let v: Value = serde_json::from_slice(&b).unwrap_or(Value::Null);
    let ok = || util::json(200, json!({"ok":true}));
    if method == Method::GET && path == "/health" {
        return Ok(ok());
    }
    if a.readonly && method != Method::GET {
        return Ok(util::text(503, "read only"));
    }
    match (method, path) {
        (Method::GET, "/chat") => {
            let q = query(&uri);
            let number = |k: &str| {
                q.get(k)
                    .filter(|v| !v.is_empty())
                    .and_then(|s| s.parse::<f64>().ok())
                    .filter(|x| x.is_finite())
            };
            let before = number("before");
            let after = number("after");
            let limit = number("limit").unwrap_or(30.).clamp(1., 100.) as i64;
            let db = a.db.locked();
            let sql = "SELECT id,ts,role,text,read,kind,data FROM messages";
            let mut rows = if let Some(after) = after {
                db.prepare(&format!("{sql} WHERE id>? ORDER BY id LIMIT 500"))?
                    .query_map([after], message)?
                    .collect::<Result<Vec<_>, _>>()?
            } else {
                let mut rows = if let Some(before) = before {
                    db.prepare(&format!("{sql} WHERE id<? ORDER BY id DESC LIMIT ?"))?
                        .query_map(params![before, limit], message)?
                        .collect::<Result<Vec<_>, _>>()?
                } else {
                    db.prepare(&format!("{sql} ORDER BY id DESC LIMIT ?"))?
                        .query_map([limit], message)?
                        .collect::<Result<Vec<_>, _>>()?
                };
                rows.reverse();
                rows
            };
            let first = rows.first().and_then(|m| m["id"].as_f64()).or(before);
            let more = if after.is_none() {
                if let Some(first) = first {
                    db.query_row("SELECT 1 FROM messages WHERE id<? LIMIT 1", [first], |r| {
                        r.get::<_, i64>(0)
                    })
                    .optional()?
                    .is_some()
                } else {
                    false
                }
            } else {
                false
            };
            Ok(util::json(
                200,
                json!({"messages":std::mem::take(&mut rows),"hasMore":more,"llm":llm()}),
            ))
        }
        (Method::DELETE, "/chat") => {
            a.db.locked().execute("DELETE FROM messages", [])?;
            Ok(ok())
        }
        (Method::GET, "/chat/unread") => {
            let count =
                a.db.locked()
                    .query_row("SELECT COUNT(*) FROM messages WHERE read=0", [], |r| {
                        r.get::<_, i64>(0)
                    })?;
            Ok(util::json(200, json!({"count":count})))
        }
        (Method::POST, "/chat/read") => {
            a.db.locked()
                .execute("UPDATE messages SET read=1 WHERE read=0", [])?;
            Ok(ok())
        }
        (Method::GET, "/chat/push/key") => {
            Ok(util::json(200, json!({"key":a.keys()?["publicKey"]})))
        }
        (Method::POST, "/chat/push/subscribe") => {
            if !v["endpoint"].as_str().is_some_and(push::allowed)
                || !v["keys"]["p256dh"].is_string()
                || !v["keys"]["auth"].is_string()
            {
                return Ok(util::json(400, json!({"error":"subscription ไม่ถูกต้อง"})));
            }
            a.db.locked().execute(
                "INSERT OR REPLACE INTO push_subs(endpoint,p256dh,auth,created) VALUES(?,?,?,?)",
                params![
                    v["endpoint"].as_str(),
                    v["keys"]["p256dh"].as_str(),
                    v["keys"]["auth"].as_str(),
                    millis()
                ],
            )?;
            Ok(ok())
        }
        (Method::POST, "/chat/push/unsubscribe") => {
            if let Some(e) = v["endpoint"].as_str() {
                a.db.locked()
                    .execute("DELETE FROM push_subs WHERE endpoint=?", [e])?;
            }
            Ok(ok())
        }
        (Method::POST, "/chat/push/test") => {
            let sub = a
                .subs()?
                .into_iter()
                .find(|s| s["endpoint"] == v["endpoint"]);
            let Some(sub) = sub else {
                return Ok(util::json(404, json!({"error":"ยังไม่ได้ลงทะเบียนเครื่องนี้"})));
            };
            let status=a.push_one(&sub,&json!({"title":"Dock","body":"เปิดการแจ้งเตือนแล้ว สรุปรายเดือนจะเด้งมาที่เครื่องนี้","url":"/#/chat","tag":"test"})).await?;
            Ok(util::json(200, json!({"status":status})))
        }
        (Method::POST, "/chat/alert") => {
            if !util::secret(
                h.get("x-alert-secret")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or(""),
                &util::env("ALERT_SECRET", ""),
            ) {
                return Ok(util::json(403, json!({"error":"forbidden"})));
            }
            let alert = &v["alert"];
            let (title, body) = match (alert["title"].as_str(), alert["body"].as_str()) {
                (Some(t), Some(b))
                    if t.encode_utf16().count() <= 200 && b.encode_utf16().count() <= 500 =>
                {
                    (t, b)
                }
                _ => return Ok(util::json(400, json!({"error":"bad alert"}))),
            };
            let msg = a.post(
                "system",
                &format!("{title}\n{body}\nดูรายละเอียด: https://status.chakkritton.com"),
                Some(if alert["kind"] == "up" { "up" } else { "down" }),
                &Value::Null,
            )?;
            let id = alert["id"]
                .as_str()
                .unwrap_or("x")
                .chars()
                .take(40)
                .collect::<String>();
            a.push_all(
                json!({"title":title,"body":body,"url":"/#/chat","tag":format!("status-{id}")}),
            )
            .await;
            Ok(util::json(200, json!({"ok":true,"id":msg["id"]})))
        }
        (Method::POST, "/chat") => {
            let text = v["text"].as_str().unwrap_or("").trim();
            if text.is_empty() || text.encode_utf16().count() > 4000 {
                return Ok(util::json(
                    400,
                    json!({"error":"ข้อความต้องยาว 1–4000 ตัวอักษร"}),
                ));
            }
            let mine = a.post("user", text, None, &Value::Null)?;
            let (text, kind, data) = match a.reply(text).await {
                Ok(v) => v,
                Err(e) => (format!("ตอบไม่ได้ตอนนี้: {e}"), None, Value::Null),
            };
            let answer = a.post("assistant", &text, kind, &data)?;
            Ok(util::json(200, json!({"messages":[mine,answer]})))
        }
        _ => Ok(util::text(404, "NOT_FOUND")),
    }
}
async fn handler(
    State(a): State<Arc<App>>,
    method: Method,
    uri: Uri,
    h: HeaderMap,
    b: Bytes,
) -> Response {
    match handle(a, method, uri, h, b).await {
        Ok(r) => r,
        Err(_) => {
            eprintln!("chat request failed");
            util::json(500, json!({"error":"internal error"}))
        }
    }
}
pub fn router() -> Result<Router, Error> {
    let readonly = util::env("CHAT_READ_ONLY", "") == "true";
    let path = util::env("CHAT_DB", "/data/chat.db");
    let db = if readonly {
        Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?
    } else {
        Connection::open(path)?
    };
    db.busy_timeout(Duration::from_secs(5))?;
    if !readonly {
        db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT,ts INTEGER NOT NULL,role TEXT NOT NULL,text TEXT NOT NULL,read INTEGER NOT NULL DEFAULT 1);")?;
        for col in ["kind", "data"] {
            let exists = db
                .query_row(
                    "SELECT 1 FROM pragma_table_info('messages') WHERE name=?",
                    [col],
                    |r| r.get::<_, i64>(0),
                )
                .optional()?
                .is_some();
            if !exists {
                db.execute_batch(&format!("ALTER TABLE messages ADD COLUMN {col} TEXT"))?;
            }
        }
        db.execute_batch("CREATE TABLE IF NOT EXISTS digests(day TEXT PRIMARY KEY,data TEXT NOT NULL);CREATE TABLE IF NOT EXISTS reports(month TEXT PRIMARY KEY,message_id INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS push_subs(endpoint TEXT PRIMARY KEY,p256dh TEXT NOT NULL,auth TEXT NOT NULL,created INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);")?;
    }
    let a = Arc::new(App {
        db: Mutex::new(db),
        client: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()?,
        push_client: push::client(15)?,
        readonly,
    });
    if !readonly && util::env("CHAT_JOBS_DISABLED", "") != "true" {
        let relay = a.clone();
        let a = a.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(10)).await;
            loop {
                if a.scheduled(millis()).await.is_err() {
                    eprintln!("chat scheduled work failed");
                }
                tokio::time::sleep(Duration::from_secs(300)).await;
            }
        });
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(20)).await;
            loop {
                let metrics = util::env("METRICS_URL", "http://dock-metrics:9100");
                if relay.security_alerts(&metrics).await.is_err() {
                    eprintln!("chat security relay failed");
                }
                tokio::time::sleep(Duration::from_secs(30)).await;
            }
        });
    }
    Ok(Router::new().fallback(handler).with_state(a))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn monthly_schedule_bangkok() {
        let at = |s: &str| {
            chrono::DateTime::parse_from_rfc3339(s)
                .unwrap()
                .timestamp_millis()
        };
        assert_eq!(due(at("2026-10-31T23:54:00+07:00")), None);
        assert_eq!(due(at("2026-10-31T23:55:00+07:00")), Some("2026-10".into()));
        assert_eq!(due(at("2026-11-03T23:59:00+07:00")), Some("2026-10".into()));
        assert_eq!(due(at("2026-11-04T00:00:00+07:00")), None);
    }

    #[tokio::test]
    async fn security_relay_anchors_first_then_posts_new_alerts_once() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let metrics = format!("http://{}", listener.local_addr().unwrap());
        let outbox = Arc::new(Mutex::new(json!({"last":3,"events":[]})));
        let served = outbox.clone();
        tokio::spawn(async move {
            loop {
                let (mut s, _) = listener.accept().await.unwrap();
                let mut buf = [0u8; 4096];
                let _ = s.read(&mut buf).await;
                let body = served.lock().unwrap().to_string();
                let head = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    body.len()
                );
                let _ = s.write_all((head + &body).as_bytes()).await;
            }
        });
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT,ts INTEGER NOT NULL,role TEXT NOT NULL,text TEXT NOT NULL,read INTEGER NOT NULL DEFAULT 1,kind TEXT,data TEXT);CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE push_subs(endpoint TEXT PRIMARY KEY,p256dh TEXT NOT NULL,auth TEXT NOT NULL,created INTEGER NOT NULL);").unwrap();
        let a = App {
            db: Mutex::new(db),
            client: reqwest::Client::new(),
            push_client: reqwest::Client::new(),
            readonly: false,
        };
        let messages = |a: &App| {
            a.db.locked()
                .query_row("SELECT (SELECT count(*) FROM messages WHERE kind='security'), coalesce((SELECT text FROM messages WHERE kind='security' ORDER BY id DESC LIMIT 1),'')", [], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
                })
                .unwrap()
        };
        // the first pass only anchors: what happened before the relay existed is not replayed
        a.security_alerts(&metrics).await.unwrap();
        assert_eq!(messages(&a).0, 0);
        *outbox.lock().unwrap() = json!({"last":5,"events":[
            {"id":4,"title":"SSH: ล็อกอินจากเครือข่ายใหม่","detail":"root จาก 192.0.2.1"},
            {"id":5,"title":"มีไฟล์ใหม่: /etc/cron.d/x","detail":""}]});
        a.security_alerts(&metrics).await.unwrap();
        let (n, text) = messages(&a);
        assert_eq!(n, 1);
        assert!(text.starts_with("ความปลอดภัย: 2 เรื่องใหม่\n• SSH"), "{text}");
        assert!(text.ends_with("/#/security"), "{text}");
        // the same outbox again posts nothing
        a.security_alerts(&metrics).await.unwrap();
        assert_eq!(messages(&a).0, 1);
        // a reset watch (ids start again) re-anchors instead of staying silent forever
        *outbox.lock().unwrap() = json!({"last":1,"events":[]});
        a.security_alerts(&metrics).await.unwrap();
        *outbox.lock().unwrap() =
            json!({"last":2,"events":[{"id":2,"title":"พอร์ตใหม่","detail":"TCP 8080"}]});
        a.security_alerts(&metrics).await.unwrap();
        assert_eq!(
            messages(&a),
            (
                2,
                "พอร์ตใหม่\nTCP 8080\nดูรายละเอียด: https://docker.chakkritton.com/#/security".into()
            )
        );
    }
}
