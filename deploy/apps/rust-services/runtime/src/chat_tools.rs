//! What Dock's chat model may call (the owner's ask, 2026-11-19: "let it use skills, tools and MCP"): read-only
//! tools over the server's own data, each answering in plain Thai text, and the skills in CHAT_SKILLS (Markdown
//! instructions the model reads before a kind of task). The MCP servers' tools are in chat_mcp.rs.
use crate::chat_report::{self as r, arr, n};
use chrono::{Datelike, Timelike};
use serde_json::{Value, json};

/// Bangkok time as Dock's pages show it, for the model: "19 พ.ย. 2569 17:08"
pub fn when(ms: i64) -> String {
    const MONTHS: [&str; 12] = [
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
    chrono::DateTime::from_timestamp_millis(ms + 25_200_000).map_or_else(
        || "-".into(),
        |t| {
            format!(
                "{} {} {} {:02}:{:02}",
                t.day(),
                MONTHS[t.month0() as usize],
                t.year() + 543,
                t.hour(),
                t.minute()
            )
        },
    )
}
/// A word holding an e-mail address becomes "(อีเมล)": what goes to the model leaves addresses out (Nginx Proxy
/// Manager's sign-ins carry one).
pub fn no_email(s: &str) -> String {
    s.split(' ')
        .map(|w| match w.split_once('@') {
            Some((name, host)) if !name.is_empty() && host.contains('.') => "(อีเมล)",
            _ => w,
        })
        .collect::<Vec<_>>()
        .join(" ")
}
fn text(v: &Value) -> String {
    no_email(v.as_str().unwrap_or(""))
}
fn pct(x: f64) -> String {
    r::pct(&json!(x))
}
fn size(x: f64) -> String {
    r::bytes(&json!(x))
}
/// Epoch seconds or milliseconds (the status page counts in ms, the security watch in s) as ms.
fn ms(v: &Value) -> Option<i64> {
    v.as_f64()
        .filter(|x| x.is_finite() && *x > 0.)
        .map(|x| if x < 1e11 { x * 1000. } else { x } as i64)
}
fn ago(secs: f64) -> String {
    let s = secs.max(0.) as i64;
    match (s / 86_400, s % 86_400 / 3600, s % 3600 / 60) {
        (0, 0, m) => format!("{m} นาที"),
        (0, h, m) => format!("{h} ชั่วโมง {m} นาที"),
        (d, h, _) => format!("{d} วัน {h} ชั่วโมง"),
    }
}

fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({"type":"function","function":{"name":name,"description":description,
        "parameters":{"type":"object","properties":properties,"required":required}}})
}
/// The built-in tools, in the OpenAI shape. All of them only read.
pub fn specs() -> Vec<Value> {
    vec![
        tool(
            "server_status",
            "The server's CPU, memory, load, disk, network and web requests over a recent window, with the busiest \
             moment and the most requested paths. Use it for how the machine is doing now, today or this week.",
            json!({"range":{"type":"string","enum":["1h","24h","7d"],"description":"1h (default), 24h or 7d"}}),
            &[],
        ),
        tool(
            "containers",
            "Every Docker container: running or not, health, uptime, and its CPU and memory over the last hour.",
            json!({}),
            &[],
        ),
        tool(
            "services",
            "The public status page: each service up or down, its 90-day uptime and response time, and the \
             incidents of the last 7 days.",
            json!({}),
            &[],
        ),
        tool(
            "web_traffic",
            "Website visits: views and visitors per day and per site, top pages, referrers, countries, devices and \
             browsers.",
            json!({"days":{"type":"integer","minimum":1,"maximum":90,"description":"days back, default 7"},
                "host":{"type":"string","description":"only this site, e.g. thai-weather.chakkritton.com"}}),
            &[],
        ),
        tool(
            "security",
            "Sign-ins over SSH and to the admin panels (time, IP, network, key or browser), failed sign-ins and \
             the security events, optionally for one IP only.",
            json!({"days":{"type":"integer","minimum":1,"maximum":90,"description":"days back, default 30"},
                "ip":{"type":"string","description":"only items with this IP or a part of it"}}),
            &[],
        ),
        tool(
            "attacks",
            "Where attacks on the server come from: SSH password guessing, port scans and bad web requests, by \
             country, port and IP.",
            json!({"days":{"type":"integer","enum":[1,7,30],"description":"1, 7 (default) or 30"}}),
            &[],
        ),
        tool(
            "backups",
            "The server's backup bundles (when each was made, its size) and the latest backup run.",
            json!({}),
            &[],
        ),
        tool(
            "month_report",
            "A month's report (uptime, CPU, memory, disk, traffic, backups and tips), the same text as the report \
             sent at the end of each month.",
            json!({"month":{"type":"string","description":"YYYY-MM, e.g. 2026-10"}}),
            &["month"],
        ),
    ]
}
/// `use_skill`, when there is a skill to read.
pub fn skill_spec(skills: &[Skill]) -> Option<Value> {
    (!skills.is_empty()).then(|| {
        tool(
            "use_skill",
            "Read a skill: the owner's step-by-step instructions for a kind of task. Read the matching skill \
             before doing that task.",
            json!({"name":{"type":"string","enum":skills.iter().map(|s| s.name.as_str()).collect::<Vec<_>>()}}),
            &["name"],
        )
    })
}
/// A tool call's arguments, as the model wrote them (a JSON object in a string), or none.
pub fn args(raw: &Value) -> Value {
    match raw {
        Value::String(s) => serde_json::from_str::<Value>(s).ok(),
        Value::Object(_) => Some(raw.clone()),
        _ => None,
    }
    .filter(Value::is_object)
    .unwrap_or_else(|| json!({}))
}
/// A whole number argument within `lo..=hi`, or `default`.
pub fn int(v: &Value, lo: i64, hi: i64, default: i64) -> i64 {
    v.as_i64()
        .or_else(|| v.as_f64().map(|x| x as i64))
        .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
        .map_or(default, |x| x.clamp(lo, hi))
}
/// `s` cut to `max` characters, saying so.
pub fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    format!(
        "{}\n(ตัดเหลือ {max} ตัวอักษร)",
        s.chars().take(max).collect::<String>()
    )
}

fn label(range: &str) -> &'static str {
    match range {
        "24h" => "24 ชั่วโมงล่าสุด",
        "7d" => "7 วันล่าสุด",
        _ => "1 ชั่วโมงล่าสุด",
    }
}
/// dock-metrics /metrics?range=… (host series averaged per step, nginx counts per step, the host snapshot, the
/// most requested paths) as the model reads it.
pub fn server(m: &Value, range: &str) -> String {
    let times = arr(&m["times"]);
    if times.is_empty() {
        return "อ่านเมตริกของเครื่องไม่ได้ตอนนี้".into();
    }
    let h = &m["host"];
    let sn = &m["snapshot"];
    let step = n(&m["step"]).max(1.);
    let at = |i: usize| when((n(&times[i]) * 1000.) as i64);
    let col = |k: &str| {
        arr(&h[k])
            .iter()
            .enumerate()
            .filter_map(|(i, v)| v.as_f64().map(|x| (i, x)))
            .collect::<Vec<_>>()
    };
    let mean = |v: &[(usize, f64)]| {
        (!v.is_empty()).then(|| v.iter().map(|x| x.1).sum::<f64>() / v.len() as f64)
    };
    let peak = |v: &[(usize, f64)]| v.iter().copied().max_by(|a, b| a.1.total_cmp(&b.1));
    let cpu = col("cpu_user")
        .into_iter()
        .map(|(i, u)| (i, u + n(&h["cpu_system"][i]) + n(&h["cpu_iowait"][i])))
        .collect::<Vec<_>>();
    let mut out = vec![
        format!(
            "เครื่อง {} ({}) {} คอร์ แรม {} ดิสก์ {} เปิดเครื่องมาแล้ว {}",
            text(&sn["hostname"]),
            text(&sn["os"]),
            n(&sn["cpus"]),
            r::bytes(&sn["mem_total"]),
            r::bytes(&sn["disk_total"]),
            ago(n(&sn["uptime_s"]))
        ),
        format!("ช่วง {}: {} ถึง {}", label(range), at(0), at(times.len() - 1)),
    ];
    match (mean(&cpu), peak(&cpu)) {
        (Some(a), Some((i, p))) => out.push(format!(
            "• CPU เฉลี่ย {} สูงสุด {} เมื่อ {} (iowait เฉลี่ย {} steal เฉลี่ย {})",
            pct(a),
            pct(p),
            at(i),
            pct(mean(&col("cpu_iowait")).unwrap_or(0.)),
            pct(mean(&col("cpu_steal")).unwrap_or(0.))
        )),
        _ => out.push("• CPU: ไม่มีข้อมูลในช่วงนี้".into()),
    }
    let mem = col("mem_used");
    if let (Some(a), Some((i, p))) = (mean(&mem), peak(&mem)) {
        out.push(format!(
            "• แรมใช้เฉลี่ย {} สูงสุด {} เมื่อ {} จาก {} ตอนนี้ยังว่างให้ใช้ {} swap ใช้ {}",
            size(a),
            size(p),
            at(i),
            r::bytes(&sn["mem_total"]),
            r::bytes(&sn["mem_available"]),
            size(n(&sn["swap_total"]) - n(&sn["swap_free"]))
        ));
    }
    let load = arr(&sn["load"])
        .iter()
        .map(|x| format!("{:.2}", n(x)))
        .collect::<Vec<_>>()
        .join(" ");
    out.push(format!("• load ตอนนี้ {load} (1, 5, 15 นาที)"));
    let (used, total) = (n(&sn["disk_used"]), n(&sn["disk_total"]));
    if total > 0. {
        out.push(format!(
            "• ดิสก์ใช้ {} จาก {} ({}) ว่าง {}",
            size(used),
            size(total),
            pct(used / total * 100.),
            r::bytes(&sn["disk_free"])
        ));
    }
    let sum = |k: &str| col(k).iter().map(|x| x.1).sum::<f64>() * step;
    out.push(format!(
        "• เครือข่ายรับ {} ส่ง {} ดิสก์อ่าน {} เขียน {} (รวมทั้งช่วง)",
        size(sum("net_rx")),
        size(sum("net_tx")),
        size(sum("disk_rd")),
        size(sum("disk_wr"))
    ));
    let mut sites = m["nginx"]
        .as_object()
        .map(|o| {
            o.iter()
                .filter(|(k, _)| k.as_str() != "all")
                .map(|(k, c)| {
                    let total = |f: &str| arr(&c[f]).iter().map(n).sum::<f64>();
                    (k.clone(), total("req"), total("s4"), total("s5"))
                })
                .filter(|x| x.1 > 0.)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    sites.sort_by(|a, b| b.1.total_cmp(&a.1));
    let all = |f: fn(&(String, f64, f64, f64)) -> f64| sites.iter().map(f).sum::<f64>();
    out.push(format!(
        "• คำขอเว็บ {} ครั้ง (4xx {} 5xx {}){}",
        r::num(all(|x| x.1)),
        r::num(all(|x| x.2)),
        r::num(all(|x| x.3)),
        if sites.is_empty() {
            ""
        } else {
            " แยกตามเว็บ:"
        }
    ));
    for (host, req, s4, s5) in sites.iter().take(12) {
        out.push(format!(
            "  - {host} {} (4xx {} 5xx {})",
            r::num(*req),
            r::num(*s4),
            r::num(*s5)
        ));
    }
    let top = arr(&m["top"]["paths"]);
    if !top.is_empty() {
        out.push("• ที่ถูกเรียกมากสุด:".into());
        for p in top.iter().take(10) {
            out.push(format!(
                "  - {} {}{} {} ครั้ง",
                text(&p["method"]),
                text(&p["host"]),
                text(&p["path"]),
                r::num(n(&p["count"]))
            ));
        }
    }
    if let Some(c) = m["top"]["unique_clients"].as_f64() {
        out.push(format!("• ผู้เรียกไม่ซ้ำ {} ราย", r::num(c)));
    }
    out.join("\n")
}

/// The containers' snapshot (container-health.sh: written-at, then name, state, status, short id per line) with
/// each one's CPU and memory over the last hour from dock-metrics (keyed by the short id). Trouble first, then by
/// memory.
pub fn containers(tsv: &str, m: &Value, now: i64) -> String {
    let mut lines = tsv.trim().lines();
    let Some(at) = lines
        .next()
        .and_then(|l| l.trim().parse::<f64>().ok())
        .map(|t| (t * 1000.) as i64)
    else {
        return "อ่านรายการคอนเทนเนอร์ไม่ได้ตอนนี้".into();
    };
    struct C {
        name: String,
        state: String,
        status: String,
        cpu: Option<f64>,
        mem: Option<f64>,
    }
    let mut list = Vec::new();
    let mut ids = false;
    for line in lines {
        let f = line.split('\t').collect::<Vec<_>>();
        if f.len() < 3 || f[0].is_empty() {
            continue;
        }
        let cols = f.get(3).filter(|id| id.len() >= 12).map(|id| {
            ids = true;
            &m["containers"][&id[..12]]
        });
        let values = |k: &str| {
            cols.map(|c| {
                arr(&c[k])
                    .iter()
                    .filter_map(Value::as_f64)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
        };
        let cpu = values("cpu");
        list.push(C {
            name: f[0].into(),
            state: f[1].into(),
            status: f[2].into(),
            cpu: (!cpu.is_empty()).then(|| cpu.iter().sum::<f64>() / cpu.len() as f64),
            mem: values("mem").last().copied(),
        });
    }
    let bad = |c: &C| c.state != "running" || c.status.contains("unhealthy");
    list.sort_by(|a, b| {
        bad(b)
            .cmp(&bad(a))
            .then(b.mem.unwrap_or(0.).total_cmp(&a.mem.unwrap_or(0.)))
    });
    let running = list.iter().filter(|c| c.state == "running").count();
    let unhealthy = list
        .iter()
        .filter(|c| c.status.contains("(unhealthy)"))
        .count();
    let stale = now - at > 5 * 60_000;
    let mut out = vec![format!(
        "คอนเทนเนอร์ {} ตัว: ทำงาน {running} ไม่ได้ทำงาน {} unhealthy {unhealthy} (ข้อมูลเมื่อ {}{})",
        list.len(),
        list.len() - running,
        when(at),
        if stale {
            " ข้อมูลเก่า อาจไม่ตรงกับตอนนี้"
        } else {
            ""
        }
    )];
    for c in &list {
        out.push(format!(
            "• {}: {} · {}{}{}",
            c.name,
            c.state,
            c.status,
            c.cpu
                .map_or(String::new(), |x| format!(" · CPU เฉลี่ย {}", pct(x))),
            c.mem
                .map_or(String::new(), |x| format!(" · แรม {}", size(x)))
        ));
    }
    if !ids {
        out.push("(ยังไม่มี CPU และแรมรายคอนเทนเนอร์)".into());
    }
    out.join("\n")
}

/// The public status page's /api/status: services, then the incidents of the last 7 days.
pub fn services(v: &Value) -> String {
    let list = arr(&v["services"]);
    if list.is_empty() {
        return "อ่านหน้าสถานะไม่ได้ตอนนี้".into();
    }
    let down = list.iter().filter(|s| s["status"] != "up").count();
    let mut out = vec![format!(
        "หน้าสถานะ: {} บริการ ปกติ {} มีปัญหา {down}{}",
        list.len(),
        list.len() - down,
        ms(&v["lastRun"]).map_or(String::new(), |t| format!(" (ตรวจล่าสุด {})", when(t)))
    )];
    for s in list {
        let state = match s["status"].as_str() {
            Some("up") => "ปกติ".to_string(),
            Some("down") => "ล่ม".to_string(),
            Some(x) => x.to_string(),
            None => "-".to_string(),
        };
        out.push(format!(
            "• {} ({}): {state}{}{}{}{}",
            text(&s["name"]),
            text(&s["group"]),
            s["uptime90"]
                .as_f64()
                .map_or(String::new(), |u| format!(" · uptime 90 วัน {u:.2}%")),
            s["ms"]
                .as_f64()
                .filter(|x| *x > 0.)
                .map_or(String::new(), |x| format!(" · ตอบใน {x:.0} ms")),
            ms(&s["since"]).map_or(String::new(), |t| format!(" · เป็นแบบนี้ตั้งแต่ {}", when(t))),
            s["reason"]
                .as_str()
                .filter(|x| !x.is_empty())
                .map_or(String::new(), |x| format!(" · สาเหตุ: {}", no_email(x)))
        ));
    }
    let incidents = arr(&v["incidents"]);
    out.push(format!(
        "เหตุขัดข้อง 7 วันล่าสุด:{}",
        if incidents.is_empty() {
            " ไม่มี"
        } else {
            ""
        }
    ));
    for i in incidents.iter().take(20) {
        out.push(format!(
            "• {}: {} ถึง {}",
            text(&i["name"]),
            ms(&i["start"]).map_or("-".into(), when),
            ms(&i["end"]).map_or("ตอนนี้ (ยังไม่หาย)".into(), when)
        ));
    }
    out.join("\n")
}

/// apps-analytics /stats?days=…[&host=…]: totals, days (newest first), sites and the top lists.
pub fn traffic(a: &Value, days: i64) -> String {
    if !a["totals"].is_object() {
        return "อ่านสถิติผู้เข้าชมไม่ได้ตอนนี้".into();
    }
    let t = &a["totals"];
    let mut out = vec![format!(
        "ผู้เข้าชม {days} วันล่าสุด{}: เปิดดู {} ครั้ง ผู้เข้าชม {} คน",
        a["host"]
            .as_str()
            .map_or(String::new(), |h| format!(" เฉพาะ {h}")),
        r::num(n(&t["views"])),
        r::num(n(&t["visitors"]))
    )];
    let series = arr(&a["series"]);
    if !series.is_empty() {
        out.push("รายวัน (ใหม่ไปเก่า):".into());
        for d in series.iter().rev().take(14) {
            out.push(format!(
                "• {}: {} ครั้ง {} คน",
                text(&d["day"]),
                r::num(n(&d["views"])),
                r::num(n(&d["visitors"]))
            ));
        }
    }
    for (title, key, k) in [
        ("แยกตามเว็บ", "perHost", 10),
        ("หน้ายอดนิยม", "pages", 10),
        ("มาจาก", "referrers", 10),
        ("ประเทศ", "countries", 10),
        ("อุปกรณ์", "devices", 5),
        ("เบราว์เซอร์", "browsers", 8),
    ] {
        let xs = arr(&a[key]);
        if xs.is_empty() {
            continue;
        }
        out.push(format!(
            "{title}: {}",
            xs.iter()
                .take(k)
                .map(|x| format!(
                    "{} {} ครั้ง {} คน",
                    text(&x["key"]),
                    r::num(n(&x["views"])),
                    r::num(n(&x["visitors"]))
                ))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    out.join("\n")
}

/// dock-metrics /security/attacks?days=…: totals, countries, ports and the busiest IPs.
pub fn attacks(v: &Value) -> String {
    if v["enabled"] == json!(false) {
        return "ยังไม่ได้เปิดการเก็บข้อมูลการโจมตี".into();
    }
    if !v["totals"].is_object() {
        return "อ่านข้อมูลการโจมตีไม่ได้ตอนนี้".into();
    }
    let t = &v["totals"];
    let mut out = vec![format!(
        "การโจมตี {} วันล่าสุด (ตั้งแต่ {}): รวม {} ครั้ง เดารหัส SSH {} สแกนพอร์ต {} ยิงเว็บ {}",
        n(&v["days"]),
        ms(&v["since"]).map_or("-".into(), when),
        r::num(n(&t["total"])),
        r::num(n(&t["ssh"])),
        r::num(n(&t["scan"])),
        r::num(n(&t["web"]))
    )];
    let line = |x: &Value| {
        format!(
            "{} ครั้ง (SSH {} สแกน {} เว็บ {})",
            r::num(n(&x["total"])),
            r::num(n(&x["ssh"])),
            r::num(n(&x["scan"])),
            r::num(n(&x["web"]))
        )
    };
    let countries = arr(&v["countries"]);
    if !countries.is_empty() {
        out.push("ประเทศ (มากไปน้อย):".into());
        for c in countries.iter().take(10) {
            out.push(format!(
                "• {} ({}) {}",
                text(&c["name"]),
                text(&c["cc"]),
                line(c)
            ));
        }
    }
    let ports = arr(&v["topPorts"]);
    if !ports.is_empty() {
        out.push(format!(
            "พอร์ตที่โดนมากสุด: {}",
            ports
                .iter()
                .take(10)
                .map(|p| format!("{} {}", text(&p["port"]), r::num(n(&p["count"]))))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    let ips = arr(&v["topIps"]);
    if !ips.is_empty() {
        out.push("IP ที่มามากสุด:".into());
        for x in ips.iter().take(10) {
            out.push(format!(
                "• {} ({}) {}",
                text(&x["ip"]),
                text(&x["cc"]),
                line(x)
            ));
        }
    }
    let u = &v["unlocated"];
    if u.is_object() {
        out.push(format!(
            "ระบุประเทศไม่ได้: ผ่าน Cloudflare {} ไม่ทราบ {}",
            r::num(n(&u["webCloudflare"])),
            r::num(n(&u["unknown"]))
        ));
    }
    out.join("\n")
}

/// apps-backup /backups: the bundles, newest first, and the latest run.
pub fn backups(v: &Value) -> String {
    if !v["bundles"].is_array() {
        return "อ่านรายการแบ็กอัปไม่ได้ตอนนี้".into();
    }
    let mut list = arr(&v["bundles"]).iter().collect::<Vec<_>>();
    list.sort_by_key(|b| std::cmp::Reverse(r::created(b)));
    let total = list.iter().map(|b| n(&b["size"])).sum::<f64>();
    let mut out = vec![format!("แบ็กอัป {} ชุด รวม {}", list.len(), size(total))];
    let job = &v["job"];
    if job.is_object() {
        out.push(format!(
            "งานสำรองล่าสุด: {} เริ่ม {} {}",
            text(&job["name"]),
            ms(&job["started"]).map_or("-".into(), when),
            if let Some(e) = job["error"].as_str() {
                format!("ผิดพลาด: {}", no_email(e))
            } else if job["done"] == json!(true) {
                "เสร็จแล้ว".into()
            } else {
                format!("กำลังทำ ({})", text(&job["step"]))
            }
        ));
    }
    for b in list.iter().take(15) {
        out.push(format!(
            "• {} {} {}",
            when(r::created(b)),
            text(&b["name"]),
            r::bytes(&b["size"])
        ));
    }
    out.join("\n")
}

/// What of Dock's security page goes to the model: the system prompt carries `CONTEXT` on every question; the
/// `security` tool can look further back, at more items, or at one IP.
pub struct Scope<'a> {
    pub days: i64,
    pub ip: Option<&'a str>,
    pub logins: usize,
    pub events: usize,
    /// sign-ins only within `days` too (the context shows the latest whatever their age)
    pub logins_in_days: bool,
}
pub const CONTEXT: Scope = Scope {
    days: 14,
    ip: None,
    logins: 15,
    events: 30,
    logins_in_days: false,
};
/// Dock's security page (dock-metrics /security) as lines the model can quote, newest first, in Bangkok time: the
/// latest SSH and panel sign-ins with their IP, network and key or browser (panel user names left out), failed
/// sign-ins over 24 hours, and the events. An unreadable page is said, so the model does not guess.
pub fn security(v: &Value, now: i64, scope: &Scope) -> String {
    if v.is_null() {
        return "ความปลอดภัย: อ่านหน้าความปลอดภัยของ Dock ไม่ได้ตอนนี้".into();
    }
    let ms = |e: &Value| (n(&e["ts"]) * 1000.) as i64;
    let since = now - scope.days * r::DAY;
    let matches = |xs: &[&Value]| {
        scope.ip.is_none_or(|ip| {
            xs.iter()
                .any(|x| x.as_str().is_some_and(|s| s.contains(ip)))
        })
    };
    let fresh = |l: &Value| {
        if l["new"].as_bool() == Some(true) {
            " (เครือข่ายใหม่)"
        } else {
            ""
        }
    };
    let none = |list: &[&Value]| {
        if list.is_empty() {
            " ไม่มี"
        } else {
            ""
        }
    };
    let cats = &v["cats"];
    let logins = |cat: &str| {
        arr(&cats[cat]["logins"])
            .iter()
            .filter(|l| !scope.logins_in_days || ms(l) >= since)
            .filter(|l| matches(&[&l["ip"], &l["net"]]))
            .take(scope.logins)
            .collect::<Vec<_>>()
    };
    let mut out = vec![match (scope.ip, scope.logins_in_days) {
        (Some(ip), _) => format!(
            "ความปลอดภัย {} วันล่าสุด เฉพาะที่มี {ip} (ใหม่ไปเก่า เวลาไทย)",
            scope.days
        ),
        (None, true) => format!("ความปลอดภัย {} วันล่าสุด (ใหม่ไปเก่า เวลาไทย)", scope.days),
        (None, false) => "ความปลอดภัย จากหน้าความปลอดภัยของ Dock (ใหม่ไปเก่า เวลาไทย)".to_string(),
    }];
    let ssh = logins("ssh");
    out.push(format!("ล็อกอิน SSH ล่าสุด:{}", none(&ssh)));
    for l in ssh {
        let how = text(&l["how"]);
        out.push(format!(
            "• {} {} จาก {} ({}){}{}",
            when(ms(l)),
            text(&l["user"]),
            text(&l["ip"]),
            text(&l["net"]),
            if how.is_empty() {
                String::new()
            } else {
                format!(" ด้วย {how}")
            },
            fresh(l)
        ));
    }
    let panel = logins("panel");
    out.push(format!(
        "ล็อกอินหน้าแอดมินล่าสุด (Dock, Portainer, Nginx Proxy Manager):{}",
        none(&panel)
    ));
    for l in panel {
        let name = match l["via"].as_str().unwrap_or("") {
            "dock" => "Dock",
            "portainer" => "Portainer",
            "npm" => "Nginx Proxy Manager",
            other => other,
        };
        let how = text(&l["how"]);
        out.push(format!(
            "• {} {name} จาก {} ({}){}{}",
            when(ms(l)),
            text(&l["ip"]),
            text(&l["net"]),
            if how.is_empty() {
                String::new()
            } else {
                format!(" · {how}")
            },
            fresh(l)
        ));
    }
    let top = arr(&cats["ssh"]["topIps"])
        .iter()
        .filter(|t| matches(&[&t["ip"]]))
        .take(5)
        .map(|t| format!("{} {} ครั้ง", text(&t["ip"]), n(&t["count"])))
        .collect::<Vec<_>>();
    out.push(format!(
        "SSH ล็อกอินไม่ผ่านใน 24 ชั่วโมง: {} ครั้ง{}",
        n(&cats["ssh"]["failed24"]),
        if top.is_empty() {
            String::new()
        } else {
            format!(" (ลองมากสุด: {})", top.join(", "))
        }
    ));
    out.push(format!(
        "รหัสผ่านหน้าแอดมินผิดใน 24 ชั่วโมง: {} ครั้ง",
        n(&cats["panel"]["failed24"])
    ));
    let events = arr(&v["events"])
        .iter()
        .filter(|e| ms(e) >= since)
        .filter(|e| matches(&[&e["title"], &e["detail"]]))
        .take(scope.events)
        .collect::<Vec<_>>();
    out.push(format!("เหตุการณ์ {} วันล่าสุด:{}", scope.days, none(&events)));
    for e in events {
        let level = match e["level"].as_str() {
            Some("bad") => "ร้ายแรง",
            Some("warn") => "เตือน",
            _ => "ทั่วไป",
        };
        let detail = text(&e["detail"]);
        out.push(format!(
            "• {} [{level}] {}{}",
            when(ms(e)),
            text(&e["title"]),
            if detail.is_empty() {
                String::new()
            } else {
                format!(": {detail}")
            }
        ));
    }
    out.join("\n")
}

/// A skill: what the owner wrote for one kind of task (a Markdown file in CHAT_SKILLS with `name` and
/// `description` in a front matter between `---` lines).
#[derive(Clone, Debug, PartialEq)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub body: String,
}
/// Every skill in `dir` by name; none when it cannot be read.
pub fn skills(dir: &str) -> Vec<Skill> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut list = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "md"))
        .filter_map(|p| {
            let stem = p.file_stem()?.to_str()?.to_string();
            parse_skill(&std::fs::read_to_string(&p).ok()?, &stem)
        })
        .collect::<Vec<_>>();
    list.sort_by(|a, b| a.name.cmp(&b.name));
    list.dedup_by(|a, b| a.name == b.name);
    list.truncate(30);
    list
}
pub fn parse_skill(raw: &str, stem: &str) -> Option<Skill> {
    let raw = raw.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let (front, body) = match raw
        .strip_prefix("---\n")
        .and_then(|rest| rest.split_once("\n---\n"))
    {
        Some((front, body)) => (front, body),
        None => ("", raw.as_str()),
    };
    let field = |key: &str| {
        front.lines().find_map(|l| {
            l.strip_prefix(key)
                .and_then(|x| x.trim_start().strip_prefix(':'))
                .map(|x| x.trim().trim_matches('"').to_string())
        })
    };
    let name = field("name")
        .unwrap_or_else(|| stem.to_string())
        .to_lowercase();
    if name.is_empty()
        || name.len() > 40
        || !name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
    {
        return None;
    }
    let body = body.trim();
    let description = field("description").filter(|d| !d.is_empty()).or_else(|| {
        body.lines()
            .find(|l| !l.trim().is_empty())
            .map(|l| l.trim_start_matches('#').trim().to_string())
    })?;
    Some(Skill {
        name,
        description: description.chars().take(300).collect(),
        body: clip(body, 8000),
    })
}
/// How a tool call shows under the answer in Dock: the tool, and what it was asked for when that helps.
pub fn used(name: &str, a: &Value) -> Value {
    let detail = match name {
        "server_status" => a["range"].as_str().map(str::to_string),
        "web_traffic" | "security" if a["days"].is_number() => {
            Some(format!("{}d", int(&a["days"], 1, 90, 7)))
        }
        "attacks" if a["days"].is_number() => Some(format!("{}d", int(&a["days"], 1, 30, 7))),
        "month_report" => a["month"].as_str().map(str::to_string),
        "use_skill" => a["name"].as_str().map(str::to_string),
        _ => None,
    };
    json!({"name":name,"detail":detail})
}

#[cfg(test)]
mod tests {
    use super::*;
    fn at(s: &str) -> i64 {
        chrono::DateTime::parse_from_rfc3339(s)
            .unwrap()
            .timestamp_millis()
    }
    fn secs(s: &str) -> f64 {
        at(s) as f64 / 1000.
    }

    #[test]
    fn security_lists_sign_ins_and_recent_events_without_addresses() {
        let now = at("2026-11-19T22:00:00+07:00");
        assert_eq!(when(now), "19 พ.ย. 2569 22:00");
        let v = json!({
            "cats": {
                "ssh": {
                    "logins": [{"ts": secs("2026-11-17T21:02:00+07:00"), "via": "ssh", "user": "root", "ip": "192.0.2.7",
                        "net": "192.0.2.0/24", "how": "SHA256:abc", "new": true}],
                    "failed24": 12,
                    "topIps": [{"ip": "198.51.100.9", "count": 9}]
                },
                "panel": {
                    "logins": [{"ts": secs("2026-11-19T17:08:00+07:00"), "via": "npm", "user": "owner@example.com",
                        "ip": "2001:db8::1", "net": "2001:db8::/64", "how": "iPhone · Safari", "new": false}],
                    "failed24": 0
                }
            },
            "events": [
                {"ts": secs("2026-11-19T17:08:00+07:00"), "level": "warn", "title": "Dock: ล็อกอินจากเครือข่ายใหม่",
                    "detail": "2001:db8::1 (2001:db8::/64) · iPhone · Safari", "alert": true},
                {"ts": secs("2026-11-01T09:00:00+07:00"), "level": "bad", "title": "เก่ากว่า 14 วัน", "detail": "", "alert": true}
            ]
        });
        let text = security(&v, now, &CONTEXT);
        for line in [
            "• 17 พ.ย. 2569 21:02 root จาก 192.0.2.7 (192.0.2.0/24) ด้วย SHA256:abc (เครือข่ายใหม่)\n",
            "• 19 พ.ย. 2569 17:08 Nginx Proxy Manager จาก 2001:db8::1 (2001:db8::/64) · iPhone · Safari\n",
            "SSH ล็อกอินไม่ผ่านใน 24 ชั่วโมง: 12 ครั้ง (ลองมากสุด: 198.51.100.9 9 ครั้ง)\n",
            "รหัสผ่านหน้าแอดมินผิดใน 24 ชั่วโมง: 0 ครั้ง\n",
            "• 19 พ.ย. 2569 17:08 [เตือน] Dock: ล็อกอินจากเครือข่ายใหม่: 2001:db8::1 (2001:db8::/64) · iPhone · Safari",
        ] {
            assert!(text.contains(line), "missing {line:?} in\n{text}");
        }
        assert!(
            !text.contains("เก่ากว่า 14 วัน") && !text.contains('@'),
            "{text}"
        );
        assert_eq!(
            no_email("ล่าสุดจาก owner@example.com (x) a@b"),
            "ล่าสุดจาก (อีเมล) (x) a@b"
        );
        // the tool: one IP, further back
        let one = security(
            &v,
            now,
            &Scope {
                days: 30,
                ip: Some("192.0.2"),
                logins: 20,
                events: 60,
                logins_in_days: true,
            },
        );
        assert!(
            one.contains("root จาก 192.0.2.7") && !one.contains("Nginx Proxy Manager จาก"),
            "{one}"
        );
        assert!(one.contains("เหตุการณ์ 30 วันล่าสุด: ไม่มี"), "{one}");
        let empty = security(&json!({"cats": {}, "events": []}), now, &CONTEXT);
        assert!(
            empty.contains("ล็อกอิน SSH ล่าสุด: ไม่มี") && empty.ends_with("เหตุการณ์ 14 วันล่าสุด: ไม่มี"),
            "{empty}"
        );
        assert_eq!(
            security(&Value::Null, now, &CONTEXT),
            "ความปลอดภัย: อ่านหน้าความปลอดภัยของ Dock ไม่ได้ตอนนี้"
        );
    }

    #[test]
    fn server_and_containers_read_dock_metrics() {
        let t0 = secs("2026-11-19T21:00:00+07:00");
        let m = json!({
            "step": 600, "times": [t0, t0 + 600., t0 + 1200.],
            "host": {"cpu_user": [5, 25, null], "cpu_system": [1, 5, null], "cpu_iowait": [0, 1, null],
                "cpu_steal": [0, 0, null], "mem_used": [2e9, 3e9, null], "net_rx": [1000, 1000, null],
                "net_tx": [2000, 2000, null], "disk_rd": [0, 0, null], "disk_wr": [100, 100, null]},
            "nginx": {"all": {"s2": [3, 4, 0]}, "fixture.example": {"req": [3, 4, 0], "s4": [1, 0, 0], "s5": [0, 1, 0]}},
            "containers": {"0123456789ab": {"cpu": [1.5, 2.5, null], "mem": [3e8, 4e8, null]}},
            "snapshot": {"hostname": "fixture", "os": "Ubuntu", "cpus": 4, "mem_total": 6e9, "mem_available": 2.5e9,
                "swap_total": 0, "swap_free": 0, "disk_total": 6e10, "disk_used": 2e10, "disk_free": 4e10,
                "load": [0.5, 0.4, 0.3], "uptime_s": 90061},
            "top": {"paths": [{"host": "fixture.example", "path": "/api/:n", "method": "GET", "count": 5}], "unique_clients": 3}
        });
        let s = server(&m, "24h");
        for line in [
            "เครื่อง fixture (Ubuntu) 4 คอร์",
            "เปิดเครื่องมาแล้ว 1 วัน 1 ชั่วโมง",
            "ช่วง 24 ชั่วโมงล่าสุด: 19 พ.ย. 2569 21:00 ถึง 19 พ.ย. 2569 21:20",
            "• CPU เฉลี่ย 19% สูงสุด 31% เมื่อ 19 พ.ย. 2569 21:10",
            "• คำขอเว็บ 7 ครั้ง (4xx 1 5xx 1) แยกตามเว็บ:\n  - fixture.example 7 (4xx 1 5xx 1)",
            "  - GET fixture.example/api/:n 5 ครั้ง",
            "• ผู้เรียกไม่ซ้ำ 3 ราย",
        ] {
            assert!(s.contains(line), "missing {line:?} in\n{s}");
        }
        assert_eq!(server(&Value::Null, "1h"), "อ่านเมตริกของเครื่องไม่ได้ตอนนี้");
        let now = at("2026-11-19T21:21:00+07:00");
        let tsv = format!(
            "{}\napps-chat\trunning\tUp 2 hours (healthy)\t0123456789ab\napps-old\texited\tExited (1) 3 hours ago\tba9876543210\n",
            now / 1000
        );
        let c = containers(&tsv, &m, now);
        assert!(
            c.starts_with("คอนเทนเนอร์ 2 ตัว: ทำงาน 1 ไม่ได้ทำงาน 1 unhealthy 0"),
            "{c}"
        );
        // trouble first, then the running one with its CPU and memory
        assert!(
            c.contains("• apps-old: exited · Exited (1) 3 hours ago\n• apps-chat: running · Up 2 hours (healthy) · CPU เฉลี่ย 2.0% · แรม 381 MB"),
            "{c}"
        );
        assert_eq!(containers("", &m, now), "อ่านรายการคอนเทนเนอร์ไม่ได้ตอนนี้");
    }

    #[test]
    fn services_traffic_attacks_and_backups() {
        let s = services(&json!({
            "services": [{"name": "Fixture Up", "group": "web", "status": "up", "uptime90": 99.95, "ms": 120},
                {"name": "Fixture Down", "group": "web", "status": "down", "uptime90": 98, "since": at("2026-11-19T20:00:00+07:00"), "reason": "HTTP 502"}],
            "incidents": [{"name": "Fixture Down", "start": at("2026-11-19T20:00:00+07:00"), "end": null}],
            "lastRun": at("2026-11-19T21:00:00+07:00")
        }));
        assert!(
            s.starts_with("หน้าสถานะ: 2 บริการ ปกติ 1 มีปัญหา 1 (ตรวจล่าสุด 19 พ.ย. 2569 21:00)"),
            "{s}"
        );
        assert!(s.contains("• Fixture Down (web): ล่ม · uptime 90 วัน 98.00% · เป็นแบบนี้ตั้งแต่ 19 พ.ย. 2569 20:00 · สาเหตุ: HTTP 502"), "{s}");
        assert!(
            s.ends_with("• Fixture Down: 19 พ.ย. 2569 20:00 ถึง ตอนนี้ (ยังไม่หาย)"),
            "{s}"
        );
        let t = traffic(
            &json!({"totals": {"views": 1200, "visitors": 70}, "series": [{"day": "2026-11-18", "views": 500, "visitors": 30},
                {"day": "2026-11-19", "views": 700, "visitors": 40}], "pages": [{"key": "/", "views": 600, "visitors": 50}]}),
            7,
        );
        assert!(
            t.starts_with(
                "ผู้เข้าชม 7 วันล่าสุด: เปิดดู 1,200 ครั้ง ผู้เข้าชม 70 คน\nรายวัน (ใหม่ไปเก่า):\n• 2026-11-19"
            ),
            "{t}"
        );
        assert!(t.ends_with("หน้ายอดนิยม: / 600 ครั้ง 50 คน"), "{t}");
        let a = attacks(
            &json!({"days": 7, "since": secs("2026-11-12T21:00:00+07:00"), "totals": {"ssh": 10, "scan": 5, "web": 1, "total": 16},
            "countries": [{"cc": "ZZ", "name": "Fixture", "ssh": 10, "scan": 5, "web": 1, "total": 16}],
            "topPorts": [{"port": "tcp/22", "count": 10}], "topIps": [{"ip": "198.51.100.9", "cc": "ZZ", "ssh": 10, "scan": 0, "web": 0, "total": 10}],
            "unlocated": {"webCloudflare": 0, "unknown": 1}}),
        );
        assert!(
            a.starts_with("การโจมตี 7 วันล่าสุด (ตั้งแต่ 12 พ.ย. 2569 21:00): รวม 16 ครั้ง"),
            "{a}"
        );
        assert!(
            a.contains("พอร์ตที่โดนมากสุด: tcp/22 10\nIP ที่มามากสุด:\n• 198.51.100.9 (ZZ) 10 ครั้ง"),
            "{a}"
        );
        assert_eq!(
            attacks(&json!({"enabled": false})),
            "ยังไม่ได้เปิดการเก็บข้อมูลการโจมตี"
        );
        let b = backups(
            &json!({"bundles": [{"name": "a.zip", "size": 1048576, "created": "2026-11-18T20:00:00.000Z"},
            {"name": "b.zip", "size": 2097152, "created": "2026-11-19T20:00:00.000Z"}], "job": null}),
        );
        assert_eq!(
            b,
            "แบ็กอัป 2 ชุด รวม 3.0 MB\n• 20 พ.ย. 2569 03:00 b.zip 2.0 MB\n• 19 พ.ย. 2569 03:00 a.zip 1.0 MB"
        );
    }

    #[test]
    fn the_repo_skills_parse() {
        let list = skills(concat!(env!("CARGO_MANIFEST_DIR"), "/../../chat-skills"));
        assert_eq!(
            list.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            [
                "monthly-summary",
                "resource-check",
                "security-review",
                "site-down"
            ]
        );
        assert!(
            list.iter()
                .all(|s| !s.description.is_empty() && s.body.starts_with("# ")),
            "{list:?}"
        );
    }

    #[test]
    fn skills_and_arguments() {
        let s = parse_skill(
            "---\nname: site-down\ndescription: \"เว็บล่มหรือช้า\"\n---\n# เว็บล่ม\n1. เรียก services\n",
            "x",
        )
        .unwrap();
        assert_eq!(
            s,
            Skill {
                name: "site-down".into(),
                description: "เว็บล่มหรือช้า".into(),
                body: "# เว็บล่ม\n1. เรียก services".into()
            }
        );
        // no front matter: the file's name, and the first line as its description
        let plain = parse_skill("# ตรวจดิสก์\nดูว่าอะไรกินที่", "disk-check").unwrap();
        assert_eq!(
            (plain.name.as_str(), plain.description.as_str()),
            ("disk-check", "ตรวจดิสก์")
        );
        assert_eq!(parse_skill("---\nname: Bad Name\n---\nx", "x"), None);
        assert_eq!(
            args(&json!("{\"range\": \"24h\"}")),
            json!({"range": "24h"})
        );
        assert_eq!(args(&json!("not json")), json!({}));
        assert_eq!(
            (
                int(&json!("12"), 1, 90, 7),
                int(&json!(500), 1, 90, 7),
                int(&Value::Null, 1, 90, 7)
            ),
            (12, 90, 7)
        );
        assert_eq!(clip("กขค", 2), "กข\n(ตัดเหลือ 2 ตัวอักษร)");
        assert_eq!(
            used("month_report", &json!({"month": "2026-10"})),
            json!({"name": "month_report", "detail": "2026-10"})
        );
    }
}
