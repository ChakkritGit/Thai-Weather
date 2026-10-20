//! Portfolio's public search and database probe. Studio mutations stay with Next's revalidation/auth.
use crate::{push::Error, util};
use axum::{
    Router,
    extract::{Query, State},
    response::Response,
    routing::get,
};
use serde_json::{Value, json};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
use tokio_postgres::{Client, NoTls, SimpleQueryMessage};
struct App {
    dsn: String,
    client: Mutex<Option<Arc<Client>>>,
}
impl App {
    async fn connection(&self) -> Result<Arc<Client>, Error> {
        let mut current = self.client.lock().await;
        if let Some(c) = current.as_ref().filter(|c| !c.is_closed()) {
            return Ok(c.clone());
        }
        if self.dsn.is_empty() {
            return Err("database unconfigured".into());
        }
        let mut url = url::Url::parse(&self.dsn)?;
        let query = url
            .query_pairs()
            .filter(|(k, _)| {
                !["schema", "pgbouncer", "connection_limit", "pool_timeout"].contains(&k.as_ref())
            })
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect::<Vec<_>>();
        url.set_query(None);
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query);
        }
        let mut config: url::Url = url;
        config.set_fragment(None);
        let mut pg: tokio_postgres::Config = config.as_str().parse()?;
        let options = format!(
            "{} -c default_transaction_read_only=on -c statement_timeout=5000",
            pg.get_options().unwrap_or("")
        );
        pg.options(&options).connect_timeout(Duration::from_secs(5));
        let (c, connection) =
            tokio::time::timeout(Duration::from_secs(5), pg.connect(NoTls)).await??;
        tokio::spawn(async move {
            if connection.await.is_err() {
                eprintln!("portfolio database connection closed");
            }
        });
        let c = Arc::new(c);
        *current = Some(c.clone());
        Ok(c)
    }
    async fn query(&self, sql: &str) -> Result<Vec<Value>, Error> {
        let c = self.connection().await?;
        let messages = tokio::time::timeout(Duration::from_secs(5), c.simple_query(sql)).await??;
        messages
            .into_iter()
            .filter_map(|m| {
                if let SimpleQueryMessage::Row(r) = m {
                    Some(r.get(0).unwrap_or("null").to_string())
                } else {
                    None
                }
            })
            .map(|s| serde_json::from_str(&s).map_err(Into::into))
            .collect()
    }
}
fn select(project: bool) -> String {
    let extra = if project {
        ",'stack',stack,'sortOrder',\"sortOrder\""
    } else {
        ""
    };
    format!(
        "SELECT json_build_object('id',id,'slug',slug,'locale',locale,'translationKey',\"translationKey\",'title',title,'summary',summary,'tags',tags,'publishedAt',to_char(\"publishedAt\",'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),'updatedAt',to_char(\"updatedAt\",'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'){extra})::text FROM \"{}\" WHERE status = 'PUBLISHED'",
        if project { "Project" } else { "Post" }
    )
}
fn entries(rows: Vec<Value>, locale: &str, project: bool) -> Vec<Value> {
    let preference = match locale {
        "en" => ["en", "th", "ja"],
        "ja" => ["ja", "en", "th"],
        _ => ["th", "en", "ja"],
    };
    let mut groups = Vec::<(String, Vec<Value>)>::new();
    for row in rows {
        let key = row["translationKey"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("#{}", row["id"].as_str().unwrap_or("")));
        if let Some((_, g)) = groups.iter_mut().find(|(k, _)| k == &key) {
            g.push(row);
        } else {
            groups.push((key, vec![row]));
        }
    }
    let mut picked = groups
        .into_iter()
        .map(|(_, g)| {
            preference
                .iter()
                .find_map(|l| g.iter().find(|r| r["locale"] == *l))
                .unwrap_or(&g[0])
                .clone()
        })
        .collect::<Vec<_>>();
    let date = |v: &Value| {
        v["publishedAt"]
            .as_str()
            .or(v["updatedAt"].as_str())
            .unwrap_or("")
            .to_string()
    };
    picked.sort_by(|a, b| {
        let order = if project {
            a["sortOrder"]
                .as_i64()
                .unwrap_or(0)
                .cmp(&b["sortOrder"].as_i64().unwrap_or(0))
        } else {
            std::cmp::Ordering::Equal
        };
        order.then_with(|| date(b).cmp(&date(a)))
    });
    picked.into_iter().map(|v|{let mut out=json!({"kind":if project{"project"}else{"post"},"href":format!("/{}/{}",if project{"projects"}else{"blog"},v["slug"].as_str().unwrap_or("")),"title":v["title"],"summary":v["summary"],"tags":v["tags"].as_array().cloned().unwrap_or_default(),"publishedAt":v["publishedAt"]});if project{out["stack"]=json!(v["stack"].as_array().cloned().unwrap_or_default());}out}).collect()
}
fn cached(status: u16, v: Value, cache: &'static str) -> Response {
    let mut r = util::json(status, v);
    r.headers_mut()
        .insert("cache-control", cache.parse().unwrap());
    r
}
async fn search(State(a): State<Arc<App>>, Query(q): Query<Vec<(String, String)>>) -> Response {
    let locale = q
        .iter()
        .find(|(k, _)| k == "locale")
        .map(|(_, v)| v.as_str())
        .filter(|s| ["th", "en", "ja"].contains(s))
        .unwrap_or("th");
    let post_sql = select(false);
    let project_sql = select(true);
    let (posts, projects) = tokio::join!(a.query(&post_sql), a.query(&project_sql));
    let mut out = entries(posts.unwrap_or_default(), locale, false);
    out.extend(entries(projects.unwrap_or_default(), locale, true));
    cached(
        200,
        json!(out),
        "public, s-maxage=60, stale-while-revalidate=300",
    )
}
async fn health(State(a): State<Arc<App>>) -> Response {
    let cache = "public, s-maxage=15";
    if a.dsn.is_empty() {
        return cached(503, json!({"ok":false}), cache);
    }
    let started = Instant::now();
    let ok = tokio::time::timeout(Duration::from_secs(5), a.query("SELECT 1"))
        .await
        .is_ok_and(|r| r.is_ok());
    cached(
        if ok { 200 } else { 503 },
        json!({"ok":ok,"db":{"ok":ok,"ms":(started.elapsed().as_secs_f64()*1000.0).round() as u64}}),
        cache,
    )
}
pub fn router() -> Router {
    let a = Arc::new(App {
        dsn: util::env("DATABASE_URL", ""),
        client: Mutex::new(None),
    });
    Router::new()
        .route(
            "/health",
            get(|| async { util::json(200, json!({"ok":true})) }),
        )
        .route("/api/health", get(health))
        .route("/api/search", get(search))
        .with_state(a)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn translation_fallback_and_order() {
        let row = |id: &str, locale: &str, key: Value, time: &str| json!({"id":id,"slug":id,"locale":locale,"translationKey":key,"title":id,"summary":null,"tags":[],"publishedAt":time,"updatedAt":time});
        let rows = vec![
            row("thai", "th", json!("shared"), "2026-10-01"),
            row("english", "en", json!("shared"), "2026-10-03"),
            row("solo", "th", Value::Null, "2026-10-02"),
        ];
        let es = entries(rows, "ja", false);
        assert_eq!(es[0]["title"], "english");
        assert_eq!(es[1]["title"], "solo");
        assert_eq!(es[0]["href"], "/blog/english");
        assert!(es[0].get("locale").is_none());
    }
}
