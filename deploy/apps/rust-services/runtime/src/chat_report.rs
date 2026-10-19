//! Daily digests and the existing Dock report card contract.
use chrono::{Datelike, NaiveDate};
use serde_json::{Value, json};
use std::collections::BTreeMap;
pub const DAY: i64 = 86_400_000;
pub fn n(v: &Value) -> f64 {
    v.as_f64().unwrap_or(0.)
}
pub fn day(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms + 25_200_000)
        .unwrap()
        .format("%Y-%m-%d")
        .to_string()
}
pub fn start(d: &str) -> Option<i64> {
    NaiveDate::parse_from_str(d, "%Y-%m-%d")
        .ok()?
        .and_hms_opt(0, 0, 0)
        .map(|x| x.and_utc().timestamp_millis() - 25_200_000)
}
pub fn days(m: &str) -> u32 {
    let d = NaiveDate::parse_from_str(&format!("{m}-01"), "%Y-%m-%d").unwrap();
    let (y, m) = if d.month() == 12 {
        (d.year() + 1, 1)
    } else {
        (d.year(), d.month() + 1)
    };
    (NaiveDate::from_ymd_opt(y, m, 1).unwrap() - chrono::Duration::days(1)).day()
}
pub fn previous(m: &str) -> String {
    let d = NaiveDate::parse_from_str(&format!("{m}-01"), "%Y-%m-%d").unwrap()
        - chrono::Duration::days(1);
    d.format("%Y-%m").to_string()
}
pub fn month(m: &str) -> String {
    let d = NaiveDate::parse_from_str(&format!("{m}-01"), "%Y-%m-%d").unwrap();
    format!(
        "{} {}",
        [
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
            "ธันวาคม"
        ][d.month0() as usize],
        d.year() + 543
    )
}
pub fn arr(v: &Value) -> &[Value] {
    v.as_array().map_or(&[], Vec::as_slice)
}
fn avg(v: impl Iterator<Item = f64>) -> Value {
    let v = v.collect::<Vec<_>>();
    if v.is_empty() {
        Value::Null
    } else {
        json!(v.iter().sum::<f64>() / v.len() as f64)
    }
}
fn bytes(v: &Value) -> String {
    let Some(mut b) = v.as_f64().filter(|x| x.is_finite()) else {
        return "–".into();
    };
    let u = ["B", "KB", "MB", "GB", "TB"];
    let mut i = 0;
    while b >= 1024. && i < 4 {
        b /= 1024.;
        i += 1;
    }
    if b >= 100. || i == 0 {
        format!("{:.0} {}", b.round(), u[i])
    } else {
        format!("{b:.1} {}", u[i])
    }
}
fn pct(v: &Value) -> String {
    v.as_f64().map_or("–".into(), |p| {
        if p < 10. {
            format!("{p:.1}%")
        } else {
            format!("{:.0}%", p.round())
        }
    })
}
fn num(n: f64) -> String {
    let s = format!("{:.0}", n.round());
    let len = s.len();
    s.chars()
        .enumerate()
        .flat_map(|(i, c)| {
            if i > 0 && (len - i).is_multiple_of(3) {
                vec![',', c]
            } else {
                vec![c]
            }
        })
        .collect()
}
fn site(h: &str) -> String {
    if ["chakkritton.com", "www.chakkritton.com"].contains(&h) {
        "portfolio".into()
    } else {
        h.strip_suffix(".chakkritton.com").unwrap_or(h).into()
    }
}
fn hosts(ds: &[Value], only_sites: bool) -> Vec<(String, [f64; 4])> {
    let mut h = BTreeMap::<String, [f64; 4]>::new();
    for d in ds {
        if let Some(rs) = d["requests"].as_object() {
            for (k, r) in rs {
                if only_sites && !k.contains('.') {
                    continue;
                }
                let t = h.entry(k.clone()).or_default();
                for (i, f) in ["req", "s4", "s5", "bytes"].iter().enumerate() {
                    t[i] += n(&r[f]);
                }
            }
        }
    }
    let mut h = h.into_iter().collect::<Vec<_>>();
    h.sort_by(|a, b| b.1[0].total_cmp(&a.1[0]));
    h
}
fn created(b: &Value) -> i64 {
    b["created"]
        .as_i64()
        .or_else(|| {
            b["created"]
                .as_str()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|d| d.timestamp_millis())
        })
        .unwrap_or(0)
}
fn latest(extra: &Value) -> Option<&Value> {
    arr(&extra["backups"]["bundles"])
        .iter()
        .max_by_key(|b| created(b))
}
pub fn digest(day: &str, m: &Value, a: &Value) -> Option<Value> {
    let from = start(day)? as f64 / 1000.;
    let idx = arr(&m["times"])
        .iter()
        .enumerate()
        .filter(|(_, t)| n(t) >= from && n(t) < from + 86400.)
        .map(|(i, _)| i)
        .collect::<Vec<_>>();
    if idx.is_empty() {
        return None;
    }
    let h = &m["host"];
    let cpu = idx
        .iter()
        .filter_map(|&i| {
            h["cpu_user"][i]
                .as_f64()
                .map(|u| u + n(&h["cpu_system"][i]) + n(&h["cpu_iowait"][i]))
        })
        .collect::<Vec<_>>();
    let sum = |col: &Value, scale: f64| idx.iter().map(|&i| n(&col[i]) * scale).sum::<f64>();
    let mut requests = json!({});
    if let Some(hosts) = m["nginx"].as_object() {
        for (host, cols) in hosts {
            if host == "all" {
                continue;
            }
            let r = json!({"req":sum(&cols["req"],1.),"s4":sum(&cols["s4"],1.),"s5":sum(&cols["s5"],1.),"bytes":sum(&cols["bytes"],1.)});
            if n(&r["req"]) != 0. {
                requests[host] = r;
            }
        }
    }
    let an = arr(&a["series"]).iter().find(|s| s["day"] == day);
    Some(
        json!({"day":day,"coverage":(cpu.len() as f64/(86400./n(&m["step"]))).min(1.),"cpuAvg":avg(cpu.iter().copied()),"cpuMax":cpu.iter().copied().reduce(f64::max),"memAvg":avg(idx.iter().filter_map(|&i|h["mem_used"][i].as_f64())),"memTotal":m["snapshot"]["mem_total"],"diskUsed":m["snapshot"]["disk_used"],"diskTotal":m["snapshot"]["disk_total"],"netRx":sum(&h["net_rx"],n(&m["step"])) ,"netTx":sum(&h["net_tx"],n(&m["step"])) ,"requests":requests,"views":an.map_or(0.,|s|n(&s["views"])) ,"visitors":an.map_or(0.,|s|n(&s["visitors"]))}),
    )
}
pub fn report(m: &str, ds: &[Value], e: &Value, now: i64) -> (String, Value) {
    let until = e["untilDay"].as_u64();
    let total = until.unwrap_or(days(m) as u64);
    let title = format!(
        "สรุปเดือน{}{}",
        month(m),
        until.map_or(String::new(), |d| format!(" (ถึงวันที่ {d})"))
    );
    let cpu = avg(ds.iter().filter_map(|d| d["cpuAvg"].as_f64()));
    let mem = avg(ds.iter().filter_map(|d| d["memAvg"].as_f64()));
    let peak = ds
        .iter()
        .filter(|d| d["cpuMax"].is_number())
        .max_by(|a, b| n(&a["cpuMax"]).total_cmp(&n(&b["cpuMax"])));
    let last = ds.last().unwrap_or(&Value::Null);
    let first = ds.first().unwrap_or(&Value::Null);
    let mempct = if mem.is_null() || last.is_null() {
        Value::Null
    } else {
        json!(n(&mem) / n(&last["memTotal"]) * 100.)
    };
    let diskpct = if last.is_null() {
        Value::Null
    } else {
        json!(n(&last["diskUsed"]) / n(&last["diskTotal"]) * 100.)
    };
    let covered = ds.iter().filter(|d| n(&d["coverage"]) >= 0.5).count();
    let mut lines = vec![title.clone()];
    if ds.is_empty() {
        lines.extend([
            "".into(),
            "ยังไม่มีข้อมูลรายวันของเดือนนี้ (เก็บทุกคืนเวลา 23:50)".into(),
        ]);
    } else {
        let delta = n(&last["diskUsed"]) - n(&first["diskUsed"]);
        lines.extend([
            "".into(),
            "เซิร์ฟเวอร์".into(),
            format!(
                "• CPU เฉลี่ย {}{}",
                pct(&cpu),
                peak.map_or(String::new(), |p| format!(
                    " · สูงสุด {} (วันที่ {})",
                    pct(&p["cpuMax"]),
                    p["day"].as_str().unwrap()[8..].parse::<u32>().unwrap()
                ))
            ),
            format!(
                "• หน่วยความจำเฉลี่ย {} จาก {}",
                bytes(&mem),
                bytes(&last["memTotal"])
            ),
            format!(
                "• ดิสก์ใช้ {} จาก {} (ว่าง {}{})",
                bytes(&last["diskUsed"]),
                bytes(&last["diskTotal"]),
                bytes(&json!(n(&last["diskTotal"]) - n(&last["diskUsed"]))),
                if delta.abs() >= 100. * 1024. * 1024. {
                    format!(
                        ", {} {} ในเดือนนี้",
                        if delta > 0. {
                            "เพิ่มขึ้น"
                        } else {
                            "ลดลง"
                        },
                        bytes(&json!(delta.abs()))
                    )
                } else {
                    String::new()
                }
            ),
            format!(
                "• เครือข่าย รับ {} · ส่ง {}",
                bytes(&json!(ds.iter().map(|d| n(&d["netRx"])).sum::<f64>())),
                bytes(&json!(ds.iter().map(|d| n(&d["netTx"])).sum::<f64>()))
            ),
        ]);
        let h = hosts(ds, false);
        let all = h.iter().fold([0.; 4], |mut a, (_, r)| {
            for i in 0..4 {
                a[i] += r[i];
            }
            a
        });
        if all[0] > 0. {
            lines.extend([
                "".into(),
                "ทราฟฟิกผ่าน proxy".into(),
                format!(
                    "• คำขอ {} · 4xx {:.1}% · 5xx {:.2}% · ส่งออก {}",
                    num(all[0]),
                    all[1] / all[0] * 100.,
                    all[2] / all[0] * 100.,
                    bytes(&json!(all[3]))
                ),
                format!(
                    "• มากสุด: {}",
                    h.iter()
                        .take(5)
                        .map(|(h, r)| format!("{} {}", site(h), num(r[0])))
                        .collect::<Vec<_>>()
                        .join(" · ")
                ),
            ]);
            let bad = h
                .iter()
                .filter(|(_, r)| r[0] >= 50. && r[2] / r[0] >= 0.01)
                .map(|(h, r)| format!("{} {:.1}%", site(h), r[2] / r[0] * 100.))
                .collect::<Vec<_>>();
            if !bad.is_empty() {
                lines.push(format!("• 5xx เกิน 1%: {}", bad.join(" · ")));
            }
        }
        if covered < total as usize {
            lines.extend([
                "".into(),
                format!("(มีข้อมูลเซิร์ฟเวอร์ครบ {covered} จาก {total} วัน)"),
            ]);
        }
    }
    let an = &e["analytics"];
    if !an.is_null() {
        lines.extend([
            "".into(),
            "ผู้เข้าชมเว็บ".into(),
            format!(
                "• ผู้เข้าชม {} · เพจวิว {}",
                num(n(&an["totals"]["visitors"])),
                num(n(&an["totals"]["views"]))
            ),
        ]);
        if !arr(&an["perHost"]).is_empty() {
            lines.push(format!(
                "• {}",
                arr(&an["perHost"])
                    .iter()
                    .take(5)
                    .map(|r| format!(
                        "{} {} คน",
                        site(r["key"].as_str().unwrap_or("")),
                        num(n(&r["visitors"]))
                    ))
                    .collect::<Vec<_>>()
                    .join(" · ")
            ));
        }
    }
    let status = arr(&e["status"]["services"]);
    if !status.is_empty() {
        let down = status
            .iter()
            .filter(|s| s["status"] != "up")
            .map(|s| s["name"].as_str().unwrap_or(""))
            .collect::<Vec<_>>();
        let weak = status
            .iter()
            .filter(|s| s["uptime90"].is_number() && n(&s["uptime90"]) < 99.5)
            .map(|s| format!("{} {}%", s["name"].as_str().unwrap_or(""), s["uptime90"]))
            .collect::<Vec<_>>();
        lines.extend([
            "".into(),
            "สถานะบริการ".into(),
            if down.is_empty() {
                format!("• ทั้ง {} บริการทำงานปกติ", status.len())
            } else {
                format!("• ตอนนี้มีปัญหา: {}", down.join(", "))
            },
        ]);
        if !weak.is_empty() {
            lines.push(format!("• uptime 90 วันต่ำกว่า 99.5%: {}", weak.join(", ")));
        }
    }
    if !e["backups"].is_null() {
        lines.extend(["".into(), "สำรองข้อมูล".into()]);
        lines.push(latest(e).map_or(
            "• ยังไม่มีไฟล์สำรองทั้งเซิร์ฟเวอร์ ควรสร้างใน เพิ่มเติม → สำรองข้อมูล".into(),
            |b| {
                let age = (now - created(b)).div_euclid(DAY);
                format!(
                    "• ล่าสุด {} ({age} วันก่อน, {}){}",
                    day(created(b)),
                    bytes(&b["size"]),
                    if age > 31 {
                        " — เก่ากว่าหนึ่งเดือน ควรสร้างใหม่"
                    } else {
                        ""
                    }
                )
            },
        ));
    }
    let sites = hosts(ds, true);
    let all = sites.iter().map(|(_, r)| r[0]).sum::<f64>();
    let s4 = hosts(ds, false).iter().map(|(_, r)| r[1]).sum::<f64>();
    let mut tips = Vec::<Value>::new();
    let mut tip = |level: &str, text: String| tips.push(json!({"level":level,"text":text}));
    if n(&diskpct) >= 80. {
        tip(
            "bad",
            format!(
                "ดิสก์ใช้ไป {:.0}% แล้ว ลบอิมเมจที่ไม่ได้ใช้ในหน้า \"อิมเมจ\" หรือขยายดิสก์",
                n(&diskpct).round()
            ),
        );
    } else if !first.is_null() && n(&last["diskUsed"]) - n(&first["diskUsed"]) > 1024f64.powi(3) {
        tip(
            "info",
            format!(
                "ดิสก์โตขึ้น {} ในเดือนนี้ ถ้าโตแบบนี้ต่อ ควรดูว่าอะไรเพิ่ม (อิมเมจ log หรือข้อมูลพยากรณ์)",
                bytes(&json!(n(&last["diskUsed"]) - n(&first["diskUsed"])))
            ),
        );
    }
    if n(&mempct) >= 80. {
        tip(
            "warn",
            format!(
                "หน่วยความจำใช้เฉลี่ย {:.0}% ถ้าสูงต่อเนื่องอาจทำให้แอปช้าหรือถูกปิด ลองดูคอนเทนเนอร์ที่ใช้ RAM มากที่สุด",
                n(&mempct).round()
            ),
        );
    }
    if let Some(p) = peak.filter(|p| n(&p["cpuMax"]) >= 90.) {
        tip(
            "info",
            format!(
                "CPU แตะ {:.0}% วันที่ {} ถ้าเกิดบ่อย ดูกราฟ CPU ต่อคอนเทนเนอร์ในหน้าภาพรวม",
                n(&p["cpuMax"]).round(),
                p["day"].as_str().unwrap()[8..].parse::<u32>().unwrap()
            ),
        );
    }
    for (h, r) in &sites {
        if r[0] >= 50. && r[2] / r[0] >= 0.01 {
            tip(
                "warn",
                format!(
                    "{} ตอบ error 5xx {:.1}% ของคำขอ ดู log ของคอนเทนเนอร์นั้น",
                    site(h),
                    r[2] / r[0] * 100.
                ),
            );
        }
    }
    if all >= 200. && s4 / all >= 0.15 {
        tip(
            "info",
            format!(
                "คำขอผิด (4xx) {:.0}% ส่วนใหญ่มักเป็นบอทสแกนหาไฟล์ที่ไม่มี ไม่ต้องทำอะไรถ้าเว็บใช้งานได้ปกติ",
                (s4 / all * 100.).round()
            ),
        );
    }
    for s in status {
        let name = s["name"].as_str().unwrap_or("");
        if s["status"] != "up" {
            tip(
                "bad",
                format!("{name} มีปัญหาอยู่ตอนนี้ ดูที่ status.chakkritton.com"),
            );
        } else if s["uptime90"].is_number() && n(&s["uptime90"]) < 99.5 {
            tip(
                "warn",
                format!(
                    "{name} uptime 90 วัน {}% ต่ำกว่าเป้า 99.5% ดูช่วงที่ล่มในหน้าสถานะ",
                    s["uptime90"]
                ),
            );
        }
    }
    if !e["backups"].is_null() {
        if let Some(b) = latest(e) {
            if now - created(b) > 31 * DAY {
                tip(
                    "warn",
                    format!("ไฟล์สำรองล่าสุดเก่ากว่าหนึ่งเดือน ({}) ควรสร้างใหม่", day(created(b))),
                );
            }
        } else {
            tip(
                "warn",
                "ยังไม่มีไฟล์สำรองทั้งเซิร์ฟเวอร์ สร้างได้ที่ เพิ่มเติม → สำรองข้อมูล แล้วเก็บไว้นอกเซิร์ฟเวอร์".into(),
            );
        }
    }
    if !ds.is_empty() && covered < total as usize {
        tip(
            "info",
            format!("ข้อมูลเซิร์ฟเวอร์มี {covered} จาก {total} วัน (เก็บทุกคืน 23:50) ตัวเลขเดือนนี้จึงยังไม่ครบ"),
        );
    }
    if !tips
        .iter()
        .any(|t| t["level"] == "bad" || t["level"] == "warn")
    {
        tips.insert(0, json!({"level":"ok","text":"ทุกอย่างปกติดี ไม่มีอะไรต้องทำ"}));
    }
    let tone = |p: &Value, w: f64, b: f64| {
        if p.is_null() {
            Value::Null
        } else if n(p) >= b {
            json!("bad")
        } else if n(p) >= w {
            json!("warn")
        } else {
            Value::Null
        }
    };
    let mut tiles = vec![
        json!({"label":"CPU เฉลี่ย","value":pct(&cpu),"sub":peak.map(|p|format!("สูงสุด {} วันที่ {}",pct(&p["cpuMax"]),p["day"].as_str().unwrap()[8..].parse::<u32>().unwrap())),"tone":tone(&cpu,60.,85.)}),
        json!({"label":"RAM เฉลี่ย","value":bytes(&mem),"sub":if last.is_null(){None}else{Some(format!("จาก {}",bytes(&last["memTotal"])))},"tone":tone(&mempct,75.,90.)}),
        json!({"label":"ดิสก์","value":if diskpct.is_null(){"–".into()}else{format!("{:.0}%",n(&diskpct).round())},"sub":if last.is_null(){None}else{Some(format!("ว่าง {}",bytes(&json!(n(&last["diskTotal"])-n(&last["diskUsed"])))))},"tone":tone(&diskpct,75.,90.)}),
        json!({"label":"ผู้เข้าชม","value":if an["totals"].is_null(){"–".into()}else{num(n(&an["totals"]["visitors"]))},"sub":if an["totals"].is_null(){None}else{Some(format!("เพจวิว {}",num(n(&an["totals"]["views"]))))}}),
    ];
    for t in &mut tiles {
        t.as_object_mut().unwrap().retain(|_, v| !v.is_null());
    }
    let data = json!({"month":m,"title":title,"tiles":tiles,"cpu":ds.iter().map(|d|json!({"day":d["day"],"avg":d["cpuAvg"],"max":d["cpuMax"]})).collect::<Vec<_>>(),"visitors":arr(&e["visitorsDaily"]),"sites":sites.iter().take(6).map(|(h,r)|json!({"site":site(h),"requests":r[0],"errorsPct":if r[0]!=0.{r[2]/r[0]*100.}else{0.}})).collect::<Vec<_>>(),"tips":tips});
    (lines.join("\n"), data)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn digest_counts_only_the_bangkok_day_and_integrates_rates() {
        let from = start("2026-10-14").unwrap() / 1000;
        let col = |n: f64| json!(vec![n; 145]);
        let m = json!({"step":600,"times":(0..145).map(|i|from+i*600).collect::<Vec<_>>(),"host":{"cpu_user":col(10.),"cpu_system":col(4.),"cpu_iowait":col(1.),"mem_used":col(1e9),"net_rx":col(1000.),"net_tx":col(2000.)},"nginx":{"all":{"req":col(999.)},"fixture.example":{"req":col(6.),"s4":col(1.),"s5":col(0.),"bytes":col(5000.)}},"snapshot":{"mem_total":3e9,"disk_used":14e9,"disk_total":29e9}});
        let d = digest("2026-10-14", &m, &Value::Null).unwrap();
        assert_eq!(d["coverage"], 1.);
        assert_eq!(d["cpuAvg"], 15.);
        assert_eq!(d["netRx"], 86_400_000.);
        assert_eq!(d["requests"]["fixture.example"]["req"], 864.);
        assert!(d["requests"].get("all").is_none());
        assert!(digest("2026-10-20", &m, &Value::Null).is_none());
    }
}
