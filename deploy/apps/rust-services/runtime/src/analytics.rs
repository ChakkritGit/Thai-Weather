//! Schema-compatible, daily salted, first-party analytics. No IP or user agent is persisted.
use crate::util::Locked;
use crate::{checks::millis, util};
use axum::{
    Router,
    body::Bytes,
    extract::{Query, State},
    http::HeaderMap,
    response::Response,
    routing::{get, post},
};
use rusqlite::{
    Connection, OptionalExtension, params, params_from_iter,
    types::{Value as Sql, ValueRef},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
const DAY: i64 = 86_400_000;
const VITALS: [&str; 5] = ["LCP", "INP", "CLS", "FCP", "TTFB"];
// Events per client IP per minute (a page view plus its vitals is ~6), and how many IPs one minute tracks.
const PER_MINUTE: u32 = 120;
const MAX_CLIENTS: usize = 50_000;
const HOSTS: &str = "chakkritton.com,expenses.chakkritton.com,whiteboard.chakkritton.com,drive-music.chakkritton.com,calorieflow.chakkritton.com,thai-weather.chakkritton.com";
struct Analytics {
    db: Mutex<Connection>,
    hosts: Vec<String>,
    read_only: bool,
    fixed_now: Option<i64>,
    keep: i64,
    hits: Mutex<(i64, HashMap<String, u32>)>,
}
impl Analytics {
    fn now(&self) -> i64 {
        self.fixed_now.unwrap_or_else(millis)
    }
    /// A fixed one-minute window per client IP, so nobody can flood the counts with fake views.
    fn allow(&self, ip: &str, now: i64) -> bool {
        let minute = now / 60_000;
        let mut w = self.hits.locked();
        if w.0 != minute {
            *w = (minute, HashMap::new());
        }
        if w.1.len() >= MAX_CLIENTS && !w.1.contains_key(ip) {
            return false;
        }
        let n = w.1.entry(ip.into()).or_insert(0);
        *n += 1;
        *n <= PER_MINUTE
    }
}
fn day(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms + 7 * 3_600_000)
        .expect("valid timestamp")
        .format("%Y-%m-%d")
        .to_string()
}
fn device(ua: &str) -> &'static str {
    let u = ua.to_ascii_lowercase();
    if u.contains("ipad")
        || u.contains("tablet")
        || (u.contains("android") && !u.contains("mobile"))
    {
        "tablet"
    } else if ["mobi", "iphone", "android"].iter().any(|p| u.contains(p)) {
        "mobile"
    } else {
        "desktop"
    }
}
fn browser(u: &str) -> &'static str {
    for (matches, name) in [
        (vec!["Edg/"], "Edge"),
        (vec!["SamsungBrowser"], "Samsung"),
        (vec!["Line/"], "LINE"),
        (vec!["FBAN", "FBAV", "Instagram"], "Facebook/IG"),
        (vec!["Firefox", "FxiOS"], "Firefox"),
        (vec!["Chrome", "CriOS"], "Chrome"),
        (vec!["Safari"], "Safari"),
    ] {
        if matches.iter().any(|p| u.contains(p)) {
            return name;
        }
    }
    "Other"
}
fn bot(u: &str) -> bool {
    let u = u.to_ascii_lowercase();
    [
        "bot",
        "crawl",
        "spider",
        "slurp",
        "preview",
        "headless",
        "lighthouse",
        "pagespeed",
        "monitor",
        "curl",
        "wget",
        "python",
        "httpx",
        "node-fetch",
    ]
    .iter()
    .any(|s| u.contains(s))
}
fn clean_path(v: &Value) -> Option<String> {
    let s = v.as_str()?;
    if !s.starts_with('/') {
        return None;
    }
    Some(
        s.split(['?', '#'])
            .next()
            .unwrap()
            .chars()
            .take(200)
            .collect(),
    )
}
fn ref_host(v: &Value, host: &str) -> Option<String> {
    let u = url::Url::parse(v.as_str()?).ok()?;
    let h = u.host_str()?.trim_start_matches("www.");
    if h.is_empty() || h == host.trim_start_matches("www.") {
        None
    } else {
        Some(h.chars().take(100).collect())
    }
}
fn header<'a>(h: &'a HeaderMap, key: &str) -> &'a str {
    h.get(key).and_then(|v| v.to_str().ok()).unwrap_or("")
}
fn sweep(a: &Analytics) -> rusqlite::Result<()> {
    let db = a.db.locked();
    let cut = day(a.now() - a.keep * DAY);
    db.execute("DELETE FROM views WHERE day < ?", [&cut])?;
    db.execute("DELETE FROM vitals WHERE day < ?", [&cut])?;
    Ok(())
}
fn ingest(a: &Analytics, h: &HeaderMap, b: &[u8]) -> rusqlite::Result<()> {
    let host = header(h, "host")
        .split(':')
        .next()
        .unwrap_or("")
        .trim_start_matches("www.")
        .to_ascii_lowercase();
    let ua = header(h, "user-agent");
    if !a.hosts.contains(&host)
        || bot(ua)
        || String::from_utf8_lossy(b).encode_utf16().count() > 2000
    {
        return Ok(());
    }
    let Ok(body) = serde_json::from_slice::<Value>(b) else {
        return Ok(());
    };
    let Some(path) = clean_path(&body["p"]) else {
        return Ok(());
    };
    let now = a.now();
    let today = day(now);
    let dev = device(ua);
    let mut db = a.db.locked();
    if body["t"] == "pv" {
        let tx = db.transaction()?;
        let salt = tx
            .query_row("SELECT value FROM salt WHERE day = ?", [&today], |r| {
                r.get::<_, String>(0)
            })
            .optional()?;
        let salt = match salt {
            Some(v) => v,
            None => {
                let s = uuid::Uuid::new_v4().to_string();
                tx.execute("DELETE FROM salt", [])?;
                tx.execute(
                    "INSERT INTO salt (day,value) VALUES (?,?)",
                    params![today, s],
                )?;
                s
            }
        };
        let ip = h
            .get("cf-connecting-ip")
            .or_else(|| h.get("x-real-ip"))
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let visitor =
            format!("{:x}", Sha256::digest(format!("{salt}|{host}|{ip}|{ua}")))[..16].to_string();
        let country = header(h, "cf-ipcountry")
            .chars()
            .take(2)
            .collect::<String>()
            .to_uppercase();
        let country = if country.is_empty() || country == "XX" {
            None
        } else {
            Some(country)
        };
        tx.execute(
            "INSERT INTO views VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                now,
                today,
                host,
                path,
                ref_host(&body["r"], &host),
                country,
                dev,
                browser(ua),
                visitor
            ],
        )?;
        tx.commit()?;
    } else if body["t"] == "v"
        && body["n"].as_str().is_some_and(|n| VITALS.contains(&n))
        && body["v"]
            .as_f64()
            .is_some_and(|v| v.is_finite() && (0.0..600_000.0).contains(&v))
    {
        db.execute(
            "INSERT INTO vitals VALUES (?, ?, ?, ?, ?, ?, ?)",
            params![
                now,
                today,
                host,
                path,
                body["n"].as_str(),
                body["v"].as_f64(),
                dev
            ],
        )?;
    }
    Ok(())
}
async fn record(State(a): State<Arc<Analytics>>, h: HeaderMap, b: Bytes) -> Response {
    if a.read_only {
        return util::json(503, json!({"error":"read only"}));
    }
    let ip = h
        .get("cf-connecting-ip")
        .or_else(|| h.get("x-real-ip"))
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !a.allow(ip, millis()) {
        return util::json(429, json!({"error":"too many events"}));
    }
    match tokio::task::spawn_blocking(move || ingest(&a, &h, &b)).await {
        Ok(Ok(())) => util::text(204, axum::body::Body::empty()),
        _ => util::json(500, json!({"error":"storage unavailable"})),
    }
}
fn rows(db: &Connection, sql: &str, args: &[Sql]) -> rusqlite::Result<Vec<Value>> {
    let mut stmt = db.prepare(sql)?;
    let columns = stmt
        .column_names()
        .iter()
        .map(|s| s.to_string())
        .collect::<Vec<_>>();
    let data = stmt.query_map(params_from_iter(args), |r| {
        let mut obj = serde_json::Map::new();
        for (i, c) in columns.iter().enumerate() {
            let v = match r.get_ref(i)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(v) => json!(v),
                ValueRef::Real(v) => json!(v),
                ValueRef::Text(v) => json!(String::from_utf8_lossy(v)),
                ValueRef::Blob(_) => Value::Null,
            };
            obj.insert(c.clone(), v);
        }
        Ok(Value::Object(obj))
    })?;
    data.collect()
}
fn stats(a: &Analytics, host: &str, days: f64) -> rusqlite::Result<Value> {
    let from = day(a.now() - ((days - 1.0) * DAY as f64) as i64);
    let host = if a.hosts.iter().any(|h| h == host) {
        host
    } else {
        ""
    };
    let where_sql = if host.is_empty() {
        "day >= ?"
    } else {
        "day >= ? AND host = ?"
    };
    let mut args = vec![Sql::Text(from.clone())];
    if !host.is_empty() {
        args.push(Sql::Text(host.into()));
    }
    let db = a.db.locked();
    let q = |sql: &str| rows(&db, sql, &args);
    let totals=q(&format!("SELECT COUNT(*) AS views, COUNT(DISTINCT visitor || day) AS visitors FROM views WHERE {where_sql}"))?.remove(0);
    let series = q(&format!(
        "SELECT day, COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors FROM views WHERE {where_sql} GROUP BY day ORDER BY day"
    ))?;
    let top = |col: &str, limit: usize| {
        q(&format!(
            "SELECT {col} AS key, COUNT(*) AS views, COUNT(DISTINCT visitor || day) AS visitors FROM views WHERE {where_sql} AND {col} IS NOT NULL GROUP BY {col} ORDER BY views DESC LIMIT {limit}"
        ))
    };
    let per_host = rows(
        &db,
        "SELECT host AS key, COUNT(*) AS views, COUNT(DISTINCT visitor || day) AS visitors FROM views WHERE day >= ? GROUP BY host ORDER BY views DESC",
        &[Sql::Text(from.clone())],
    )?;
    let mut vitals = serde_json::Map::new();
    let p75 = |mut vals: Vec<f64>| -> Value {
        if vals.is_empty() {
            return Value::Null;
        }
        vals.sort_by(f64::total_cmp);
        json!(vals[(vals.len() * 3 / 4).min(vals.len() - 1)])
    };
    for name in VITALS {
        let mut va = args.clone();
        va.push(Sql::Text(name.into()));
        let data = rows(
            &db,
            &format!("SELECT value, device FROM vitals WHERE {where_sql} AND name = ?"),
            &va,
        )?;
        if data.is_empty() {
            continue;
        }
        vitals.insert(name.into(),json!({"p75":p75(data.iter().filter_map(|r|r["value"].as_f64()).collect()),"n":data.len(),"mobile":p75(data.iter().filter(|r|r["device"]!="desktop").filter_map(|r|r["value"].as_f64()).collect()),"desktop":p75(data.iter().filter(|r|r["device"]=="desktop").filter_map(|r|r["value"].as_f64()).collect())}));
    }
    Ok(
        json!({"host":if host.is_empty(){Value::Null}else{json!(host)},"hosts":a.hosts,"days":days,"from":from,"totals":totals,"series":series,"perHost":per_host,"pages":top("path",10)?,"referrers":top("ref",10)?,"countries":top("country",10)?,"devices":top("device",5)?,"browsers":top("browser",8)?,"vitals":vitals}),
    )
}
async fn report(
    State(a): State<Arc<Analytics>>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let days = q
        .get("days")
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|n| n.is_finite() && *n != 0.0)
        .unwrap_or(7.0)
        .clamp(1.0, 400.0);
    let host = q.get("host").cloned().unwrap_or_default();
    match tokio::task::spawn_blocking(move || stats(&a, &host, days)).await {
        Ok(Ok(v)) => util::json(200, v),
        _ => util::json(500, json!({"error":"storage unavailable"})),
    }
}
pub fn router() -> Result<Router, Box<dyn std::error::Error>> {
    let read_only = util::env("ANALYTICS_READ_ONLY", "") == "true";
    let path = util::env("ANALYTICS_DB", "/data/analytics.db");
    let db = if read_only {
        Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?
    } else {
        Connection::open(path)?
    };
    db.busy_timeout(Duration::from_secs(5))?;
    if !read_only {
        db.execute_batch("PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS views (ts INTEGER NOT NULL, day TEXT NOT NULL, host TEXT NOT NULL, path TEXT NOT NULL, ref TEXT, country TEXT, device TEXT, browser TEXT, visitor TEXT NOT NULL); CREATE INDEX IF NOT EXISTS views_host_day ON views (host, day); CREATE TABLE IF NOT EXISTS vitals (ts INTEGER NOT NULL, day TEXT NOT NULL, host TEXT NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL, value REAL NOT NULL, device TEXT); CREATE INDEX IF NOT EXISTS vitals_host_day ON vitals (host, day); CREATE TABLE IF NOT EXISTS salt (day TEXT PRIMARY KEY, value TEXT NOT NULL);")?;
    }
    let a = Arc::new(Analytics {
        db: Mutex::new(db),
        hosts: util::env("HOSTS", HOSTS)
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect(),
        read_only,
        fixed_now: if read_only {
            std::env::var("ANALYTICS_NOW_MS")
                .ok()
                .and_then(|s| s.parse().ok())
        } else {
            None
        },
        keep: util::env("KEEP_DAYS", "400").parse()?,
        hits: Mutex::new((0, HashMap::new())),
    });
    if !read_only {
        sweep(&a)?;
        let a = a.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(DAY as u64)).await;
                let a = a.clone();
                let _ = tokio::task::spawn_blocking(move || sweep(&a)).await;
            }
        });
    }
    Ok(Router::new()
        .route("/_a", post(record))
        .route("/_a/", post(record))
        .route("/stats", get(report))
        .route("/stats/", get(report))
        .route("/health", get(|| async { axum::Json(json!({"ok":true})) }))
        .route("/health/", get(|| async { axum::Json(json!({"ok":true})) }))
        .with_state(a))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn events_are_rate_limited_per_ip_and_minute() {
        let a = Analytics {
            db: Mutex::new(Connection::open_in_memory().unwrap()),
            hosts: vec![],
            read_only: false,
            fixed_now: None,
            keep: 1,
            hits: Mutex::new((0, HashMap::new())),
        };
        let t = 1_791_999_000_000;
        assert!((0..PER_MINUTE).all(|_| a.allow("1.2.3.4", t)));
        assert!(!a.allow("1.2.3.4", t));
        assert!(a.allow("5.6.7.8", t));
        assert!(a.allow("1.2.3.4", t + 60_000));
    }
    #[test]
    fn helpers() {
        assert_eq!(day(1791999000000), "2026-10-15");
        assert_eq!(device("Android Tablet"), "tablet");
        assert_eq!(device("iPhone Mobile Safari"), "mobile");
        assert_eq!(browser("Edg/120 Chrome/120"), "Edge");
        assert_eq!(
            clean_path(&json!("/th/blog?secret=x#x")),
            Some("/th/blog".into())
        );
        assert_eq!(
            ref_host(
                &json!("https://www.google.com/?q=secret"),
                "chakkritton.com"
            ),
            Some("google.com".into())
        );
    }
}
