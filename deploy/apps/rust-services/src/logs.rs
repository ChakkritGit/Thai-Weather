use crate::history::{Tiered, Values};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    os::unix::fs::MetadataExt,
    path::Path,
};

pub type Positions = BTreeMap<String, [u64; 2]>;
#[derive(Default)]
pub struct LogTail {
    pub pos: Positions,
    paths: BTreeMap<i64, Vec<(String, u64)>>,
    clients: BTreeMap<i64, HashSet<u32>>,
}
pub fn log_time(s: &str) -> Option<i64> {
    let (date, zone) = s.split_once(' ')?;
    let parts: Vec<_> = date.split(['/', ':']).collect();
    if parts.len() != 6 || zone.len() != 5 || !matches!(zone.as_bytes()[0], b'+' | b'-') {
        return None;
    }
    let month = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ]
    .iter()
    .position(|x| *x == parts[1])?;
    let year = parts[2].parse::<i64>().ok()?;
    let day = parts[0].parse::<i64>().ok()?;
    let hour = parts[3].parse::<i64>().ok()?;
    let minute = parts[4].parse::<i64>().ok()?;
    let second = parts[5].parse::<i64>().ok()?;
    let zh = zone.get(1..3)?.parse::<i64>().ok()?;
    let zm = zone.get(3..5)?.parse::<i64>().ok()?;
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let months = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if !(1970..=9999).contains(&year)
        || day < 1
        || day > months[month]
        || hour > 23
        || minute > 59
        || second > 59
        || zh > 23
        || zm > 59
    {
        return None;
    }
    let days_before = |y: i64| 365 * (y - 1) + (y - 1) / 4 - (y - 1) / 100 + (y - 1) / 400;
    let days =
        days_before(year) - days_before(1970) + months[..month].iter().sum::<i64>() + day - 1;
    let offset = (zh * 3600 + zm * 60) * if zone.starts_with('-') { -1 } else { 1 };
    Some(days * 86400 + hour * 3600 + minute * 60 + second - offset)
}
pub fn norm_path(path: &str) -> String {
    let path = path
        .split('?')
        .next()
        .filter(|x| !x.is_empty())
        .unwrap_or("/");
    if path.starts_with("/_next/") {
        return "/_next/*".into();
    }
    let result = path
        .split('/')
        .map(|s| {
            if (12..=64).contains(&s.len())
                && s.bytes()
                    .all(|x| x.is_ascii_digit() || (b'a'..=b'f').contains(&x))
            {
                ":id"
            } else if !s.is_empty() && s.bytes().all(|x| x.is_ascii_digit()) {
                ":n"
            } else {
                s
            }
        })
        .collect::<Vec<_>>()
        .join("/");
    String::from_utf16_lossy(&result.encode_utf16().take(80).collect::<Vec<_>>())
}
fn asset(path: &str) -> bool {
    let path = path.split('?').next().unwrap_or("");
    path.starts_with("/_next/")
        || [
            "js",
            "css",
            "png",
            "jpg",
            "svg",
            "ico",
            "woff",
            "woff2",
            "webmanifest",
            "map",
        ]
        .iter()
        .any(|e| path.ends_with(&format!(".{e}")))
}
fn status(s: &str) -> Option<u16> {
    if s == "-" {
        Some(0)
    } else if s.len() == 3 && s.bytes().all(|x| x.is_ascii_digit()) {
        s.parse().ok()
    } else {
        None
    }
}
impl LogTail {
    pub fn ingest(
        &mut self,
        hist: &mut Tiered,
        line: &str,
        fallback: bool,
        since: Option<f64>,
        now: f64,
    ) {
        let Some((stamp, rest)) = line.strip_prefix('[').and_then(|l| l.split_once("] ")) else {
            return;
        };
        let Some(ts) = log_time(stamp) else { return };
        if since.is_some_and(|s| (ts as f64) < s) {
            return;
        }
        let Some((prefix, rest)) = rest.split_once(" \"") else {
            return;
        };
        let Some((path, rest)) = rest.split_once("\" [Client ") else {
            return;
        };
        let Some((client, rest)) = rest.split_once("] [Length ") else {
            return;
        };
        let Some((len, _)) = rest.split_once(']') else {
            return;
        };
        let Ok(bytes) = len.parse::<u64>() else {
            return;
        };
        let p: Vec<_> = prefix.split_whitespace().collect();
        let (host, method, code) = if fallback {
            if p.len() != 5 || p[1] != "-" {
                return;
            }
            ("(ไม่ตรงโดเมน)", p[2], status(p[0]))
        } else {
            if p.len() != 7 || p[3] != "-" || status(p[2]).is_none() {
                return;
            }
            (p[6], p[4], status(p[1]))
        };
        let Some(code) = code else { return };
        let class = if (200..600).contains(&code) {
            format!("s{}", code / 100)
        } else {
            "s0".into()
        };
        hist.add_retained(
            ts as f64,
            &Values::from([
                (format!("ng:{host}:req"), 1.),
                (format!("ng:{host}:{class}"), 1.),
                (format!("ng:{host}:bytes"), bytes as f64),
                (format!("ng:all:{class}"), 1.),
            ]),
            now,
        );
        let hour = ts.div_euclid(3600) * 3600;
        if !asset(path) {
            let key = format!("{host}\0{}\0{method}", norm_path(path));
            let paths = self.paths.entry(hour).or_default();
            if let Some((_, n)) = paths.iter_mut().find(|(k, _)| *k == key) {
                *n += 1
            } else {
                paths.push((key, 1));
            }
        }
        self.clients
            .entry(hour)
            .or_default()
            .insert(crc32fast::hash(client.as_bytes()));
        self.paths.retain(|h, _| *h as f64 >= now - 7. * 86400.);
        self.clients.retain(|h, _| *h as f64 >= now - 7. * 86400.);
    }
    pub fn poll(
        &mut self,
        hist: &mut Tiered,
        dir: &Path,
        since: Option<f64>,
        now: f64,
    ) -> std::io::Result<()> {
        let mut files: Vec<_> = match fs::read_dir(dir) {
            Ok(e) => e
                .flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| {
                    n == "fallback_http_access.log"
                        || n.strip_prefix("proxy-host-")
                            .and_then(|s| s.strip_suffix("_access.log"))
                            .is_some_and(|s| !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit()))
                })
                .collect(),
            Err(_) => return Ok(()),
        };
        files.sort();
        for name in files {
            let path = dir.join(&name);
            let Ok(mut file) = File::open(&path) else {
                continue;
            };
            let st = file.metadata()?;
            let [inode, mut offset] = self
                .pos
                .get(&name)
                .copied()
                .unwrap_or([st.ino(), if since.is_some() { 0 } else { st.len() }]);
            if inode != st.ino() || st.len() < offset {
                offset = 0;
            }
            file.seek(SeekFrom::Start(offset))?;
            // Read complete lines in bounded chunks; never allocate the whole access log at startup.
            let mut pending = Vec::new();
            let mut buffer = [0u8; 65536];
            let mut consumed = 0;
            loop {
                let read = file.read(&mut buffer)?;
                if read == 0 {
                    break;
                }
                pending.extend_from_slice(&buffer[..read]);
                if let Some(last) = pending.iter().rposition(|x| *x == b'\n') {
                    for raw in pending[..last].split(|x| *x == b'\n') {
                        self.ingest(
                            hist,
                            &String::from_utf8_lossy(raw),
                            name.starts_with("fallback"),
                            since,
                            now,
                        );
                    }
                    consumed += (last + 1) as u64;
                    pending.drain(..=last);
                }
                // NPM caps request lines; reject pathological unterminated data without unbounded memory.
                if pending.len() > 1024 * 1024 {
                    return Err(std::io::Error::other("oversized NPM log line"));
                }
            }
            self.pos.insert(name, [st.ino(), offset + consumed]);
        }
        Ok(())
    }
    pub fn top(&self, since: f64) -> Value {
        let mut paths: Vec<(String, u64)> = Vec::new();
        let mut clients: HashSet<u32> = HashSet::new();
        for (_, bucket) in self
            .paths
            .iter()
            .filter(|(h, _)| (**h + 3600) as f64 > since)
        {
            for (key, count) in bucket {
                if let Some((_, n)) = paths.iter_mut().find(|(k, _)| k == key) {
                    *n += count
                } else {
                    paths.push((key.clone(), *count));
                }
            }
        }
        for (_, s) in self
            .clients
            .iter()
            .filter(|(h, _)| (**h + 3600) as f64 > since)
        {
            clients.extend(s);
        }
        paths.sort_by(|a, b| b.1.cmp(&a.1));
        json!({"paths":paths.into_iter().take(12).map(|(key,count)|{let mut parts=key.split('\0');json!({"host":parts.next().unwrap_or(""),"path":parts.next().unwrap_or(""),"method":parts.next().unwrap_or(""),"count":count})}).collect::<Vec<_>>(),"unique_clients":clients.len()})
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn timestamps_and_paths_preserve_existing_contract() {
        assert_eq!(log_time("14/Oct/2026:20:07:33 +0000"), Some(1792008453));
        assert_eq!(log_time("14/Oct/2026:20:07:33 +0700"), Some(1791983253));
        for s in [
            "garbage",
            "31/Feb/2026:20:07:33 +0000",
            "14/Oct/2026:20:07:33 +9999",
        ] {
            assert_eq!(log_time(s), None);
        }
        assert_eq!(
            norm_path("/api/v1/provinces/123?x=1"),
            "/api/v1/provinces/:n"
        );
        assert_eq!(norm_path("/c/0123456789abcdef0123/logs"), "/c/:id/logs");
        assert_eq!(norm_path("/_next/static/chunk.js"), "/_next/*");
    }
    #[test]
    fn access_log_contract_and_fallback_and_client_privacy() {
        let mut h = Tiered::default();
        let mut logs = LogTail::default();
        let now = 1792008500.;
        let normal = "[14/Oct/2026:20:07:33 +0000] - 200 200 - GET https example.test \"/api/123?token=fixture\" [Client 192.0.2.1] [Length 512] [Gzip -]";
        logs.ingest(&mut h, normal, false, None, now);
        logs.ingest(&mut h, normal, false, None, now);
        logs.ingest(&mut h,"[14/Oct/2026:20:07:40 +0000] 444 - GET http example.test \"/\" [Client 192.0.2.2] [Length 0]",true,None,now);
        assert_eq!(logs.top(now - 3600.)["unique_clients"], 2);
        assert_eq!(logs.top(now - 3600.)["paths"][0]["path"], "/api/:n");
        assert_eq!(logs.top(now - 3600.)["paths"][0]["count"], 2);
        let saved = serde_json::to_string(&h).unwrap();
        assert!(!saved.contains("192.0.2"));
        assert!(!saved.contains("token"));
    }
}
