//! Read-only machine text/RSS presentation for Weather; never starts a forecast.
use crate::{client::Http, util};
use axum::{
    Router,
    extract::{Query, State},
    http::{HeaderMap, Method},
    response::Response,
    routing::get,
};
use chrono::{DateTime, Datelike, FixedOffset, NaiveDate, Timelike, Utc};
use serde::{Deserialize, de::DeserializeOwned};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant, SystemTime},
};
use tokio::sync::Mutex;

const CACHE: &str = "public, max-age=600, stale-while-revalidate=3600";
const MONTHS: [&str; 12] = [
    "มกราคม",
    "กุมภาพันธ์",
    "มีนาคม",
    "เมษายน",
    "พฤษภาคม",
    "มิถุนายน",
    "กรกฎาคม",
    "สิงหาคม",
    "กันยายน",
    "ตุลาคม",
    "พฤศจิกายน",
    "ธันวาคม",
];
const SHORT_MONTHS: [&str; 12] = [
    "ม.ค.",
    "ก.พ.",
    "มี.ค.",
    "เม.ย.",
    "พ.ค.",
    "มิ.ย.",
    "ก.ค.",
    "ส.ค.",
    "ก.ย.",
    "ต.ค.",
    "พ.ย.",
    "ธ.ค.",
];

#[derive(Deserialize)]
struct Run {
    run_id: String,
    created: String,
    times: Vec<String>,
    model: Option<String>,
    source: Option<String>,
    ensemble_members: Option<u64>,
}
#[derive(Deserialize)]
struct Grid {
    nx: u64,
    ny: u64,
}
#[derive(Deserialize)]
struct Meta {
    run: Option<Run>,
    fine_grid: Grid,
    scales: Option<ApiScales>,
}
#[derive(Deserialize)]
struct ApiScales {
    // Object.entries in the old renderer preserves upstream category order.
    #[serde(deserialize_with = "ordered_categories")]
    categories: Vec<(String, Category)>,
}
fn ordered_categories<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Vec<(String, Category)>, D::Error> {
    struct Ordered;
    impl<'de> serde::de::Visitor<'de> for Ordered {
        type Value = Vec<(String, Category)>;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("an ordered category object")
        }
        fn visit_map<M: serde::de::MapAccess<'de>>(
            self,
            mut m: M,
        ) -> Result<Self::Value, M::Error> {
            let mut out = Vec::new();
            while let Some(pair) = m.next_entry()? {
                out.push(pair);
            }
            Ok(out)
        }
    }
    d.deserialize_map(Ordered)
}
#[derive(Deserialize)]
struct Category {
    source: String,
    levels: Vec<Level>,
}
#[derive(Deserialize)]
struct Level {
    id: String,
    min: Option<f64>,
    max: Option<f64>,
    severity: f64,
    label_th: String,
    label_en: String,
}
#[derive(Deserialize)]
struct Tier {
    name_th: String,
    name_en: String,
    advice_th: String,
}
#[derive(Deserialize)]
struct Tokens {
    categories: HashMap<String, Category>,
    severity: HashMap<String, Tier>,
}
#[derive(Deserialize)]
struct Place {
    id: String,
    name_th: String,
    name_en: String,
}
#[derive(Deserialize)]
struct Alert {
    hazard: String,
    severity: f64,
    value: f64,
    label_th: String,
    label_en: String,
}
#[derive(Deserialize)]
struct AlertEntry {
    date: String,
    partial: Option<bool>,
    until: Option<String>,
    province: Place,
    alerts: Vec<Alert>,
}
#[derive(Deserialize)]
struct Alerts {
    alerts: Vec<AlertEntry>,
}
#[derive(Deserialize)]
struct Day {
    date: String,
    hours: f64,
    partial: Option<bool>,
    until: Option<String>,
    tmin: f64,
    tmax: f64,
    tmin_low: f64,
    heat_max: f64,
    rain_p95: f64,
    rain_coverage: f64,
    storm_max: f64,
}
#[derive(Deserialize)]
struct Province {
    #[serde(flatten)]
    place: Place,
    days: Vec<Day>,
}
#[derive(Deserialize)]
struct Provinces {
    provinces: Vec<Province>,
}

struct Cache<T>(Mutex<Option<(Instant, Option<Arc<T>>)>>);
impl<T: DeserializeOwned> Cache<T> {
    fn new() -> Self {
        Self(Mutex::new(None))
    }
    async fn get(&self, app: &App, path: &str) -> Option<Arc<T>> {
        // Holding one path's lock through its fetch provides singleflight while
        // meta, alerts and provinces can still be fetched independently.
        let mut cached = self.0.lock().await;
        if let Some((at, value)) = &*cached
            && at.elapsed() < Duration::from_secs(if value.is_some() { 600 } else { 5 })
        {
            return value.clone();
        }
        let value = app
            .http
            .request(
                Method::GET,
                &format!("{}{path}", app.api),
                HeaderMap::new(),
                Vec::new(),
                Duration::from_secs(10),
            )
            .await
            .ok()
            .filter(|r| (200..300).contains(&r.status))
            .and_then(|r| serde_json::from_slice(&r.body).ok())
            .map(Arc::new);
        // Briefly coalesce failures without hiding a recovered API for ten minutes.
        *cached = Some((Instant::now(), value.clone()));
        value
    }
}
struct App {
    api: String,
    site: String,
    http: Http,
    meta: Cache<Meta>,
    alerts: Cache<Alerts>,
    provinces: Cache<Provinces>,
    tokens: Tokens,
}
impl App {
    async fn data(&self) -> (Option<Arc<Meta>>, Option<Arc<Alerts>>) {
        tokio::join!(
            self.meta.get(self, "/api/v1/meta"),
            self.alerts.get(self, "/api/v1/alerts")
        )
    }
    fn tier(&self, severity: f64) -> Option<&Tier> {
        self.tokens.severity.get(&number(severity))
    }
    fn category(&self, name: &str, value: f64) -> Option<&Level> {
        self.tokens
            .categories
            .get(name)?
            .levels
            .iter()
            .rev()
            .find(|l| {
                l.min.unwrap_or(f64::NEG_INFINITY) <= value
                    && value <= l.max.unwrap_or(f64::INFINITY)
            })
    }
}
fn number(value: f64) -> String {
    if value == 0.0 {
        "0".into()
    } else {
        value.to_string()
    }
}
fn rounded(value: f64) -> String {
    number((value + 0.5).floor())
}
fn fill(template: &str, slots: &[String]) -> String {
    // Replace only placeholders from the template, never placeholder-looking
    // text in upstream values inserted by an earlier replacement.
    let mut out = String::new();
    let mut rest = template;
    while let Some(start) = rest.find("@THWX_") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 6..];
        let Some(end) = after.find('@') else { break };
        let slot = after[..end].parse::<usize>().expect("static template slot");
        out.push_str(&slots[slot]);
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out
}
fn xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
fn thai_place(place: &Place) -> String {
    if place.name_th == "กรุงเทพมหานคร" {
        place.name_th.clone()
    } else {
        format!("จังหวัด{}", place.name_th)
    }
}
fn province_path(place: &Place) -> String {
    let mut slug = String::new();
    let mut dash = false;
    for c in place.name_en.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if dash && !slug.is_empty() {
                slug.push('-');
            }
            slug.push(c);
            dash = false;
        } else {
            dash = true;
        }
    }
    format!("/provinces/{slug}")
}
fn thai_day(date: &str) -> String {
    let Ok(d) = NaiveDate::parse_from_str(date, "%Y-%m-%d") else {
        return "Invalid Date".into();
    };
    let days = ["จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์", "อาทิตย์"];
    format!(
        "วัน{}ที่ {} {} {}",
        days[d.weekday().num_days_from_monday() as usize],
        d.day(),
        MONTHS[d.month0() as usize],
        d.year() + 543
    )
}
fn bangkok_time(iso: &str) -> String {
    let Ok(d) = DateTime::parse_from_rfc3339(iso) else {
        return "Invalid Date".into();
    };
    let d = d.with_timezone(&FixedOffset::east_opt(7 * 3600).unwrap());
    format!(
        "{} {} {} {:02}:{:02}",
        d.day(),
        SHORT_MONTHS[d.month0() as usize],
        d.year() + 543,
        d.hour(),
        d.minute()
    )
}
fn built_date(run: Option<&Run>) -> String {
    let d = if let Some(run) = run {
        let Ok(d) = DateTime::parse_from_rfc3339(&run.created) else {
            return "Invalid Date".into();
        };
        d.with_timezone(&Utc)
    } else {
        DateTime::<Utc>::from(SystemTime::now())
    };
    d.format("%a, %d %b %Y %H:%M:%S GMT").to_string()
}
fn severity(entry: &AlertEntry) -> f64 {
    entry.alerts.iter().fold(0.0, |max, a| max.max(a.severity))
}
fn hazard(alert: &Alert, th: bool) -> String {
    let name = match (alert.hazard.as_str(), th) {
        ("heat", true) => "ดัชนีความร้อน",
        ("heat", false) => "Heat index",
        ("rain", true) => "ฝน",
        ("rain", false) => "Rain",
        ("storm", true) => "พายุฝนฟ้าคะนอง",
        ("storm", false) => "Thunderstorms",
        ("wind", true) => "ลม",
        ("wind", false) => "Wind",
        ("hot", true) => "อุณหภูมิสูง",
        ("hot", false) => "High temperature",
        ("cold", true) => "อุณหภูมิต่ำ",
        ("cold", false) => "Low temperature",
        _ => &alert.hazard,
    };
    format!(
        "{name}: {}",
        if th { &alert.label_th } else { &alert.label_en }
    )
}
fn alert_value(alert: &Alert) -> String {
    let unit = match alert.hazard.as_str() {
        "heat" | "hot" | "cold" => "°",
        "rain" => " มม.",
        "storm" => "%",
        "wind" => " ม./วินาที",
        _ => "",
    };
    format!("{}{unit}", rounded(alert.value))
}
fn forecast(app: &App, d: &Day, th: bool) -> String {
    let partial = d.partial.unwrap_or(d.hours < 18.0);
    let cov = number((d.rain_coverage / 10.0 + 0.5).floor() * 10.0);
    let rain = app.category("rainCoverage", d.rain_coverage);
    let amount = app.category("rainDaily", d.rain_p95);
    let heavy = amount.is_some_and(|l| ["heavy", "veryHeavy", "extreme"].contains(&l.id.as_str()));
    let thunder = d.storm_max >= 40.0;
    let lo = (d.tmin + 0.5).floor();
    let hi = (d.tmax + 0.5).floor();
    let mut parts = Vec::new();
    if let Some(rain) = rain {
        if th {
            parts.push(format!(
                "{}ร้อยละ {cov} ของพื้นที่ ({})",
                if thunder {
                    "มีฝนฟ้าคะนอง"
                } else {
                    "มีฝน"
                },
                rain.label_th
            ));
            if heavy {
                parts.push(format!("และมี{}บางแห่ง", amount.unwrap().label_th));
            }
        } else {
            parts.push(format!(
                "{} over {cov}% of the area ({})",
                if thunder { "Thunderstorms" } else { "Rain" },
                rain.label_en.to_lowercase()
            ));
            if heavy {
                parts.push(format!(
                    "with {} in places.",
                    amount.unwrap().label_en.to_lowercase()
                ));
            } else {
                parts.last_mut().unwrap().push('.');
            }
        }
    } else {
        parts.push(
            match (th, d.heat_max >= 41.0) {
                (true, true) => "อากาศร้อนอบอ้าว",
                (true, false) => "ท้องฟ้ามีเมฆบางส่วน ฝนน้อย",
                (false, true) => "Hot and humid.",
                (false, false) => "Partly cloudy, little rain.",
            }
            .into(),
        );
    }
    if partial {
        let until = d.until.as_deref().filter(|s| !s.is_empty());
        let note = until
            .map(|u| {
                if th {
                    format!("ข้อมูลถึง {u} น. ")
                } else {
                    format!("Data until {u}. ")
                }
            })
            .unwrap_or_default();
        parts.push(if th {
            format!(
                "{note}อุณหภูมิต่ำสุดเท่าที่มีข้อมูล {} องศาเซลเซียส สูงสุดเท่าที่มีข้อมูล {} องศาเซลเซียส",
                number(lo),
                number(hi)
            )
        } else {
            format!(
                "{note}Lowest so far {} °C, highest so far {} °C (not the full-day extremes).",
                number(lo),
                number(hi)
            )
        });
    } else {
        parts.push(if th {
            format!(
                "อุณหภูมิต่ำสุด {}–{} องศาเซลเซียส สูงสุด {}–{} องศาเซลเซียส",
                number(lo - 1.0),
                number(lo),
                number(hi),
                number(hi + 1.0)
            )
        } else {
            format!(
                "Low {}–{} °C, high {}–{} °C.",
                number(lo - 1.0),
                number(lo),
                number(hi),
                number(hi + 1.0)
            )
        });
    }
    if d.tmin_low < d.tmin - 4.0 {
        parts.push(if th {
            format!(
                "ยอดดอยต่ำสุด{} {} องศาเซลเซียส",
                if partial {
                    "เท่าที่มีข้อมูล"
                } else {
                    ""
                },
                rounded(d.tmin_low)
            )
        } else {
            format!("Mountain tops down to {} °C.", rounded(d.tmin_low))
        });
    }
    if d.heat_max >= 32.0 {
        let heat = app.category("heatIndex", d.heat_max);
        parts.push(if th {
            format!(
                "ดัชนีความร้อนสูงสุด{} {} °C (เกณฑ์กรมอนามัย: ระดับ{})",
                if partial {
                    "เท่าที่มีข้อมูล"
                } else {
                    ""
                },
                rounded(d.heat_max),
                heat.map(|l| l.label_th.as_str()).unwrap_or("")
            )
        } else {
            format!(
                "Heat index up to {} °C (Dept. of Health level: {}).",
                rounded(d.heat_max),
                heat.map(|l| l.label_en.to_lowercase()).unwrap_or_default()
            )
        });
    }
    parts.join(" ")
}
fn text(body: String, rss: bool) -> Response {
    let mut r = util::text(200, body);
    r.headers_mut().insert(
        "content-type",
        if rss {
            "application/rss+xml; charset=utf-8"
        } else {
            "text/plain; charset=utf-8"
        }
        .parse()
        .unwrap(),
    );
    r.headers_mut()
        .insert("cache-control", CACHE.parse().unwrap());
    r
}
async fn llms(State(app): State<Arc<App>>) -> Response {
    let (meta, _) = app.data().await;
    let run = meta.as_deref().and_then(|m| m.run.as_ref());
    let mut slots = vec![String::new(); 26];
    slots[0] = run
        .map(|r| {
            format!(
                "Current forecast run: {}, created {} (Bangkok time).",
                r.run_id,
                bangkok_time(&r.created)
            )
        })
        .unwrap_or_default();
    slots[1] = "60".into();
    for slot in [
        2, 4, 6, 8, 10, 12, 14, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
    ] {
        slots[slot] = app.site.clone();
    }
    for (slot, path) in [
        (3, "/"),
        (5, "/provinces"),
        (7, "/provinces/chiang-mai"),
        (9, "/alerts"),
        (11, "/method"),
        (13, "/verification"),
        (15, "/developers"),
    ] {
        slots[slot] = path.into();
    }
    text(
        fill(include_str!("../assets/weather-llms.txt"), &slots),
        false,
    )
}
fn category_name(id: &str) -> &str {
    match id {
        "heatIndex" => "Heat index (°C)",
        "rainDaily" => "Rain in 24 h (mm)",
        "rainCoverage" => "Rain coverage (% of area)",
        "tempMax" => "Daily maximum temperature (°C)",
        "tempMin" => "Daily minimum temperature (°C)",
        "thunder" => "Thunderstorm chance (%)",
        "wind" => "Wind (m/s)",
        _ => id,
    }
}
async fn full(State(app): State<Arc<App>>) -> Response {
    let ((meta, alerts), provinces) =
        tokio::join!(app.data(), app.provinces.get(&app, "/api/v1/provinces"));
    let run = meta.as_deref().and_then(|m| m.run.as_ref());
    let prefix = fill(
        include_str!("../assets/weather-full-prefix.txt"),
        &[
            app.site.clone(),
            app.site.clone(),
            "/developers".into(),
            run.map(|r| {
                format!(
                    "\nForecast run {}, created {} Bangkok time, {} hourly steps from {}.",
                    r.run_id,
                    bangkok_time(&r.created),
                    r.times.len(),
                    bangkok_time(r.times.first().map(String::as_str).unwrap_or(""))
                )
            })
            .unwrap_or_default(),
            meta.as_ref()
                .map(|m| format!("{} × {}", m.fine_grid.ny, m.fine_grid.nx))
                .unwrap_or_else(|| "751 × 421".into()),
            run.and_then(|r| r.ensemble_members)
                .unwrap_or(8)
                .to_string(),
        ],
    );
    let mut out = vec![prefix];
    if let Some(scales) = meta.as_ref().and_then(|m| m.scales.as_ref()) {
        for (id, cat) in &scales.categories {
            let levels = cat
                .levels
                .iter()
                .filter(|l| l.severity > 0.0)
                .map(|l| {
                    let range = l
                        .min
                        .map(|min| format!("≥ {}", number(min)))
                        .unwrap_or_else(|| {
                            format!(
                                "≤ {}",
                                l.max.map(number).unwrap_or_else(|| "undefined".into())
                            )
                        });
                    format!(
                        "{} / {} {range} (severity {})",
                        l.label_en,
                        l.label_th,
                        number(l.severity)
                    )
                })
                .collect::<Vec<_>>();
            if !levels.is_empty() {
                out.push(format!(
                    "- {}: {}. Source: {}",
                    category_name(id),
                    levels.join("; "),
                    cat.source
                ));
            }
        }
    }
    let warnings = alerts
        .as_ref()
        .map(|a| {
            a.alerts
                .iter()
                .filter(|a| severity(a) >= 2.0)
                .map(|a| {
                    format!(
                        "- {} {} ({}): {} — {}",
                        a.date,
                        a.province.name_en,
                        thai_place(&a.province),
                        app.tier(severity(a))
                            .map(|t| t.name_en.as_str())
                            .unwrap_or(""),
                        a.alerts
                            .iter()
                            .map(|a| hazard(a, false))
                            .collect::<Vec<_>>()
                            .join(", ")
                    )
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    out.push("\n## Orange and red alerts\n".into());
    out.push(if warnings.is_empty() {
        "- none in this run".into()
    } else {
        warnings.join("\n")
    });
    out.push(format!("\n## Forecast by province\n\nOne line per province for each forecast day (Bangkok dates). Province pages: {}/provinces/<name>, e.g. {}/provinces/chiang-mai.\n", app.site, app.site));
    if let Some(provinces) = provinces {
        for p in &provinces.provinces {
            out.push(format!(
                "### {} — {} ({})\n",
                p.place.name_en,
                thai_place(&p.place),
                p.place.id
            ));
            for d in &p.days {
                out.push(format!(
                    "- {} ({}): {} / {}",
                    d.date,
                    thai_day(&d.date),
                    forecast(&app, d, false),
                    forecast(&app, d, true)
                ));
            }
            out.push(String::new());
        }
    }
    out.push(fill(
        include_str!("../assets/weather-full-suffix.txt"),
        &[app.site.clone(), app.site.clone()],
    ));
    text(out.join("\n"), false)
}
async fn feed(State(app): State<Arc<App>>, Query(query): Query<Vec<(String, String)>>) -> Response {
    let all = query
        .iter()
        .find(|(k, _)| k == "all")
        .is_some_and(|(_, v)| v == "1");
    let (meta, alerts) = app.data().await;
    let run = meta.as_deref().and_then(|m| m.run.as_ref());
    let built = built_date(run);
    let entries = alerts.as_ref().map(|a| a.alerts.as_slice()).unwrap_or(&[]);
    let mut items = Vec::new();
    if let Some(run) = run {
        let count = |s| entries.iter().filter(|a| severity(a) == s).count();
        let title = format!(
            "พยากรณ์รอบใหม่ {} น.: แดง {} · ส้ม {} · เหลือง {} จังหวัด-วัน",
            bangkok_time(&run.created),
            count(3.0),
            count(2.0),
            count(1.0)
        );
        let description = format!(
            "พยากรณ์อากาศความละเอียด 2.2 กม. ทั่วประเทศไทย {} ชั่วโมงข้างหน้า ({})",
            run.times.len(),
            run.model.as_deref().or(run.source.as_deref()).unwrap_or("")
        );
        items.push(format!("    <item>\n      <title>{}</title>\n      <link>{}/alerts</link>\n      <guid isPermaLink=\"false\">{}</guid>\n      <pubDate>{built}</pubDate>\n      <description>{}</description>\n    </item>", xml(&title), app.site, xml(&run.run_id), xml(&description)));
    }
    for a in entries
        .iter()
        .filter(|a| severity(a) >= if all { 1.0 } else { 2.0 })
    {
        let tier = app.tier(severity(a));
        let name = tier.map(|t| t.name_th.as_str()).unwrap_or("");
        let advice = tier.map(|t| t.advice_th.as_str()).unwrap_or("");
        let what = a
            .alerts
            .iter()
            .map(|a| hazard(a, true))
            .collect::<Vec<_>>()
            .join(" · ");
        let detail = a
            .alerts
            .iter()
            .map(|a| format!("{} ({})", hazard(a, true), alert_value(a)))
            .collect::<Vec<_>>()
            .join(", ");
        let mut parts = a
            .alerts
            .iter()
            .map(|a| format!("{}{}", a.hazard, number(a.severity)))
            .collect::<Vec<_>>();
        parts.sort();
        let guid = format!("{}-{}-{}", a.date, a.province.id, parts.join("-"));
        let partial = if a.partial.unwrap_or(false) {
            format!(" (ข้อมูลถึง {} น.)", a.until.as_deref().unwrap_or("null"))
        } else {
            String::new()
        };
        let title = format!(
            "{name}: {} {} – {what}",
            thai_place(&a.province),
            thai_day(&a.date)
        );
        let description = format!("{advice}. {detail}{partial} · {}", a.province.name_en);
        items.push(format!("    <item>\n      <title>{}</title>\n      <link>{}</link>\n      <guid isPermaLink=\"false\">{}</guid>\n      <pubDate>{built}</pubDate>\n      <category>{}</category>\n      <description>{}</description>\n    </item>", xml(&title), xml(&format!("{}{}", app.site, province_path(&a.province))), xml(&guid), xml(name), xml(&description)));
    }
    text(
        fill(
            include_str!("../assets/weather-feed.txt"),
            &[
                app.site.clone(),
                "/alerts".into(),
                app.site.clone(),
                if all { "?all=1" } else { "" }.into(),
                built,
                app.site.clone(),
                app.site.clone(),
                "/alerts".into(),
                items.join("\n"),
            ],
        ),
        true,
    )
}
pub fn router() -> Router {
    let app = Arc::new(App {
        api: util::env("THWX_API_URL", "http://127.0.0.1:8000")
            .trim_end_matches('/')
            .into(),
        site: util::env("SITE_URL", "http://localhost:3000")
            .trim_end_matches('/')
            .into(),
        http: Http::new(),
        meta: Cache::new(),
        alerts: Cache::new(),
        provinces: Cache::new(),
        tokens: serde_json::from_str(include_str!("../assets/weather-scales.json"))
            .expect("static weather tokens"),
    });
    Router::new()
        .route(
            "/health",
            get(|| async { util::json(200, serde_json::json!({"ok":true})) }),
        )
        .route("/llms.txt", get(llms))
        .route("/llms-full.txt", get(full))
        .route("/feed.xml", get(feed))
        .with_state(app)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dates_and_javascript_rounding() {
        assert_eq!(thai_day("2026-10-20"), "วันอังคารที่ 20 ตุลาคม 2569");
        assert_eq!(bangkok_time("2026-01-01T17:00:00Z"), "2 ม.ค. 2569 00:00");
        assert_eq!(rounded(-1.5), "-1");
        assert_eq!(rounded(-0.5), "0");
        assert_eq!(rounded(24.5), "25");
    }
    #[test]
    fn template_values_are_not_interpreted_as_slots() {
        assert_eq!(
            fill("@THWX_0@ @THWX_1@", &["@THWX_1@".into(), "value".into()]),
            "@THWX_1@ value"
        );
    }
    #[test]
    fn categories_keep_upstream_order_and_malformed_shapes_fail() {
        let scales: ApiScales = serde_json::from_str(
            r#"{"categories":{"z":{"source":"z","levels":[]},"a":{"source":"a","levels":[]}}}"#,
        )
        .unwrap();
        assert_eq!(scales.categories[0].0, "z");
        assert!(serde_json::from_str::<Alerts>(r#"{"alerts":"invalid"}"#).is_err());
        assert!(serde_json::from_str::<Meta>(r#"{"run":{"times":[]}}"#).is_err());
    }
}
