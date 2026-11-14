//! Attack map data for Dock's Cyber page: where failed SSH logins, firewall blocks (port scans) and
//! web bot probes come from, by country, counted per Bangkok day (30 days) and per hour (last day).
//!
//! View-only on purpose: this module has its own state file (DATA_DIR/attacks.json) and shares nothing
//! with `security.rs`, so nothing here can become a security event, a chat message or a push. It reads
//! the same read-only host views: auth.log, ufw.log and NPM's access logs. A first run (no state file)
//! counts the readable history silently, rotated copies included.
//!
//! Countries come from DB-IP's offline table (geo.rs). Web probes are only counted when NPM logged the
//! visitor's own address; a Cloudflare edge address cannot be located and is counted apart.

use crate::{
    centroids,
    geo::Geo,
    security::{self, Auth, Origin, Roots, bkk_day, hour},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    net::IpAddr,
    os::unix::fs::MetadataExt,
    path::Path,
};

const DAY: i64 = 86_400;
const KEEP_DAYS: i64 = 30;
/// hourly buckets back the 24 h view, so it is a rolling day and not "since midnight"
const KEEP_HOURS: i64 = 26;
/// a log line longer than this is not a log line: it is dropped instead of buffered
const MAX_LINE: u64 = 128 * 1024;
/// (hard limit, kept after trimming): the top lists are cut back when they pass the hard limit
const DAY_IPS: (usize, usize) = (120, 60);
const HOUR_IPS: (usize, usize) = (50, 25);
const PORTS: (usize, usize) = (24, 12);
/// IPs and ports kept per closed day: the "small top list" the page shows
const CLOSED_IPS: usize = 30;
const CLOSED_PORTS: usize = 8;
const SAVE_EVERY: f64 = 60.;
const SERVER: (&str, &str, f64, f64) = ("Bangkok", "TH", 13.754, 100.5014);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Ssh,
    Scan,
    Web,
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}
/// Counts of one country in one bucket; `ports` only has scans, as "tcp/22"
#[derive(Default, Clone, Serialize, Deserialize)]
struct Hits {
    #[serde(default, skip_serializing_if = "is_zero")]
    ssh: u32,
    #[serde(default, skip_serializing_if = "is_zero")]
    scan: u32,
    #[serde(default, skip_serializing_if = "is_zero")]
    web: u32,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    ports: BTreeMap<String, u32>,
}
impl Hits {
    fn add(&mut self, kind: Kind) {
        match kind {
            Kind::Ssh => self.ssh += 1,
            Kind::Scan => self.scan += 1,
            Kind::Web => self.web += 1,
        }
    }
    fn total(&self) -> u32 {
        self.ssh + self.scan + self.web
    }
}
#[derive(Default, Clone, Serialize, Deserialize)]
struct IpHits {
    cc: String,
    #[serde(default, skip_serializing_if = "is_zero")]
    ssh: u32,
    #[serde(default, skip_serializing_if = "is_zero")]
    scan: u32,
    #[serde(default, skip_serializing_if = "is_zero")]
    web: u32,
}
impl IpHits {
    fn total(&self) -> u32 {
        self.ssh + self.scan + self.web
    }
}
#[derive(Default, Clone, Serialize, Deserialize)]
struct Bucket {
    /// country code -> counts
    #[serde(default)]
    c: BTreeMap<String, Hits>,
    /// the busiest addresses (a capped list, not every address seen)
    #[serde(default)]
    ips: BTreeMap<String, IpHits>,
    /// web probes whose client was a Cloudflare edge address: no location
    #[serde(default, skip_serializing_if = "is_zero")]
    cf: u32,
    /// attacks from an address the IP database has no country for
    #[serde(default, skip_serializing_if = "is_zero")]
    zz: u32,
}

#[derive(Default, Serialize, Deserialize)]
struct State {
    #[serde(default)]
    started: f64,
    #[serde(default)]
    ufw_pos: Option<[u64; 2]>,
    #[serde(default)]
    auth_pos: Option<[u64; 2]>,
    #[serde(default)]
    npm_pos: BTreeMap<String, [u64; 2]>,
    /// Bangkok day start -> counts
    #[serde(default)]
    days: BTreeMap<i64, Bucket>,
    /// hour start -> counts, the last KEEP_HOURS only
    #[serde(default)]
    hours: BTreeMap<i64, Bucket>,
}

pub struct Attacks {
    roots: Roots,
    geo: Geo,
    month: String,
    st: State,
    seeding: bool,
    dirty: bool,
    last_save: f64,
    last_prune: f64,
}

// ------------------------------------------------------------------ log lines
/// One firewall block
#[derive(Debug, PartialEq)]
pub struct Block {
    pub ts: f64,
    pub src: IpAddr,
    /// "tcp/22" for TCP and UDP, None for other protocols
    pub port: Option<String>,
}

/// One ufw.log line: `<RFC 3339 time> <host> kernel: [..] [UFW BLOCK] IN=eth0 ... SRC=<ip> ... PROTO=TCP ... DPT=22 ...`.
/// `[UFW LIMIT BLOCK]` (ufw's SSH rate limit) counts as a block too.
pub fn ufw_line(line: &str) -> Option<Block> {
    if !line.contains("[UFW BLOCK]") && !line.contains("[UFW LIMIT BLOCK]") {
        return None;
    }
    let ts = security::iso_time(line.split(' ').next()?)?;
    let (mut src, mut proto, mut dpt) = (None, None, None);
    // the first of each key: an ICMP error repeats the offending packet's fields after the real ones
    for word in line.split_ascii_whitespace() {
        if let Some(v) = word.strip_prefix("SRC=") {
            src = src.or(Some(v));
        } else if let Some(v) = word.strip_prefix("PROTO=") {
            proto = proto.or(Some(v));
        } else if let Some(v) = word.strip_prefix("DPT=") {
            dpt = dpt.or(Some(v));
        }
    }
    let src = unmap(src?.parse::<IpAddr>().ok()?);
    let proto = proto?.to_ascii_lowercase();
    let port = match (proto.as_str(), dpt.and_then(|d| d.parse::<u16>().ok())) {
        ("tcp" | "udp", Some(p)) => Some(format!("{proto}/{p}")),
        _ => None,
    };
    Some(Block { ts, src, port })
}

fn unmap(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6
            .to_ipv4_mapped()
            .map(IpAddr::V4)
            .unwrap_or(IpAddr::V6(v6)),
        v4 => v4,
    }
}

/// A routable unicast address: what a remote attacker can have. Private, loopback, link-local, multicast,
/// shared (CGNAT), documentation and reserved space are the host's own network, not the internet.
pub fn is_global(ip: IpAddr) -> bool {
    match unmap(ip) {
        IpAddr::V4(v4) => {
            let [a, b, c, _] = v4.octets();
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_multicast()
                || v4.is_broadcast()
                || v4.is_unspecified()
                || a == 0
                || a >= 240
                || (a == 100 && (64..128).contains(&b))
                || (a == 192 && b == 0 && c == 0)
                || (a == 192 && b == 0 && c == 2)
                || (a == 198 && (b == 18 || b == 19))
                || (a == 198 && b == 51 && c == 100)
                || (a == 203 && b == 0 && c == 113))
        }
        IpAddr::V6(v6) => {
            let n = u128::from(v6);
            // 2000::/3 is global unicast; 2001:db8::/32 is documentation
            (n >> 125) == 0b001 && (n >> 96) != 0x2001_0db8
        }
    }
}

// ------------------------------------------------------------------ reading
/// Calls `f` with each complete line of `r`; returns the bytes consumed up to the last complete line.
/// An unfinished last line is left for the next read, an over-long one is dropped.
fn each_line(mut r: impl BufRead, mut f: impl FnMut(&str)) -> std::io::Result<u64> {
    let mut buf = Vec::new();
    let mut consumed = 0u64;
    let mut skipping = false;
    loop {
        buf.clear();
        let n = (&mut r).take(MAX_LINE).read_until(b'\n', &mut buf)?;
        if n == 0 {
            return Ok(consumed);
        }
        let whole = buf.last() == Some(&b'\n');
        if !whole && (n as u64) < MAX_LINE {
            return Ok(consumed);
        }
        consumed += n as u64;
        if skipping || !whole {
            skipping = !whole;
            continue;
        }
        f(String::from_utf8_lossy(&buf[..n - 1]).trim_end_matches('\r'));
    }
}

/// Reads a whole file, gzip when it ends in .gz (a rotated log)
fn read_all(path: &Path, f: impl FnMut(&str)) {
    let Ok(file) = File::open(path) else {
        return;
    };
    let result = if path.extension().is_some_and(|e| e == "gz") {
        each_line(
            BufReader::new(flate2::bufread::MultiGzDecoder::new(BufReader::new(file))),
            f,
        )
    } else {
        each_line(BufReader::new(file), f)
    };
    if let Err(e) = result {
        eprintln!("attacks: {}: {e}", path.display());
    }
}

/// New complete lines of `path` after `pos` (inode, offset); a replaced or truncated file restarts at 0
fn tail(path: &Path, pos: &mut Option<[u64; 2]>, f: impl FnMut(&str)) -> std::io::Result<()> {
    let Ok(mut file) = File::open(path) else {
        return Ok(());
    };
    let meta = file.metadata()?;
    let [inode, mut offset] = pos.unwrap_or([meta.ino(), 0]);
    if inode != meta.ino() || meta.len() < offset {
        offset = 0;
    }
    file.seek(SeekFrom::Start(offset))?;
    let consumed = each_line(BufReader::new(file), f)?;
    *pos = Some([meta.ino(), offset + consumed]);
    Ok(())
}

/// Rotated copies of `name` (`name.1`, `name.2.gz`, ...), oldest first
fn rotated(dir: &Path, name: &str) -> Vec<std::path::PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found: Vec<(u32, std::path::PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let file = e.file_name().to_string_lossy().into_owned();
            let n = file
                .strip_prefix(name)?
                .strip_prefix('.')?
                .trim_end_matches(".gz")
                .parse::<u32>()
                .ok()?;
            Some((n, e.path()))
        })
        .collect();
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().map(|(_, p)| p).collect()
}

/// One live log and its history. First run: every rotated copy, oldest first, then the live file. Later:
/// what was added since `pos`, finishing the plain `.1` copy first when logrotate moved the file since the
/// last pass (the same rule security.rs uses for auth.log; a compressed copy is not followed).
fn follow(
    dir: &Path,
    name: &str,
    pos: &mut Option<[u64; 2]>,
    seeding: bool,
    mut f: impl FnMut(&str),
) {
    let live = dir.join(name);
    if seeding {
        for old in rotated(dir, name) {
            read_all(&old, &mut f);
        }
    } else if let (Some([ino, _]), Ok(cur)) = (*pos, fs::metadata(&live))
        && ino != cur.ino()
    {
        let previous = dir.join(format!("{name}.1"));
        if fs::metadata(&previous).map(|m| m.ino()).ok() == Some(ino) {
            let mut old = *pos;
            if let Err(e) = tail(&previous, &mut old, &mut f) {
                eprintln!("attacks: {}: {e}", previous.display());
            }
            *pos = None;
        }
    }
    if let Err(e) = tail(&live, pos, f) {
        eprintln!("attacks: {name}: {e}");
    }
}

/// One thing to count
struct Hit {
    ts: f64,
    kind: Kind,
    ip: IpAddr,
    port: Option<String>,
    /// the log had a Cloudflare edge address, not the visitor
    edge: bool,
}

/// Cuts `map` back to its `keep` heaviest entries once it passes `hard`
fn trim<V>(
    map: &mut BTreeMap<String, V>,
    (hard, keep): (usize, usize),
    weight: impl Fn(&V) -> u32,
) {
    if map.len() <= hard {
        return;
    }
    let mut ranked: Vec<(u32, String)> = map.iter().map(|(k, v)| (weight(v), k.clone())).collect();
    ranked.sort_unstable_by(|a, b| b.cmp(a));
    for (_, key) in ranked.into_iter().skip(keep) {
        map.remove(&key);
    }
}

fn bump(b: &mut Bucket, h: &Hit, cc: Option<&str>, ip: &str, ip_cap: (usize, usize)) {
    if h.edge {
        b.cf += 1;
        return;
    }
    let Some(cc) = cc else {
        b.zz += 1;
        return;
    };
    let hits = b.c.entry(cc.into()).or_default();
    hits.add(h.kind);
    if let Some(port) = &h.port {
        *hits.ports.entry(port.clone()).or_default() += 1;
        trim(&mut hits.ports, PORTS, |n| *n);
    }
    let by_ip = b.ips.entry(ip.into()).or_insert_with(|| IpHits {
        cc: cc.into(),
        ..IpHits::default()
    });
    match h.kind {
        Kind::Ssh => by_ip.ssh += 1,
        Kind::Scan => by_ip.scan += 1,
        Kind::Web => by_ip.web += 1,
    }
    trim(&mut b.ips, ip_cap, IpHits::total);
}

/// (English name, latitude, longitude) of a country's label point, rounded to what a map can show
fn place(cc: &str) -> Option<(&'static str, f64, f64)> {
    let i = centroids::COUNTRIES
        .binary_search_by_key(&cc, |c| c.0)
        .ok()?;
    let (_, name, lat, lon) = centroids::COUNTRIES[i];
    let round = |x: f32| (f64::from(x) * 100.).round() / 100.;
    Some((name, round(lat), round(lon)))
}

fn cc_text(cc: [u8; 2]) -> String {
    cc.iter().map(|b| char::from(*b)).collect()
}

impl Attacks {
    /// None when there is no IP database to read: the page then says so instead of counting unlocated hits
    pub fn load(roots: Roots, geo_path: &Path, month: String, now: f64) -> Option<Self> {
        let geo = match Geo::load(geo_path) {
            Ok(g) => g,
            Err(e) => {
                eprintln!("attacks: no IP database at {}: {e}", geo_path.display());
                return None;
            }
        };
        let (v4, v6) = geo.size();
        eprintln!("attacks: IP database {month}: {v4} IPv4 and {v6} IPv6 ranges");
        let saved = fs::read(roots.data.join("attacks.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<State>(&b).ok());
        let seeding = saved.is_none();
        let mut st = saved.unwrap_or_default();
        if seeding {
            st.started = now;
        }
        Some(Self {
            roots,
            geo,
            month,
            st,
            seeding,
            dirty: seeding,
            last_save: now,
            last_prune: 0.,
        })
    }

    fn record(&mut self, h: Hit, now: f64) {
        let day = bkk_day(h.ts);
        if h.ts > now + 3600. || day < bkk_day(now) - (KEEP_DAYS - 1) * DAY {
            return;
        }
        let cc = if h.edge {
            None
        } else {
            self.geo.country(h.ip).map(cc_text)
        };
        let ip = h.ip.to_string();
        bump(
            self.st.days.entry(day).or_default(),
            &h,
            cc.as_deref(),
            &ip,
            DAY_IPS,
        );
        let hour_start = hour(h.ts);
        if hour_start >= hour(now) - (KEEP_HOURS - 1) * 3600 {
            bump(
                self.st.hours.entry(hour_start).or_default(),
                &h,
                cc.as_deref(),
                &ip,
                HOUR_IPS,
            );
        }
        self.dirty = true;
    }

    fn read_logs(&mut self, now: f64) {
        let log = self.roots.host.join("log");
        let seeding = self.seeding;
        let mut hits = Vec::new();

        let mut pos = self.st.ufw_pos;
        follow(&log, "ufw.log", &mut pos, seeding, |l| {
            if let Some(b) = ufw_line(l)
                && is_global(b.src)
            {
                hits.push(Hit {
                    ts: b.ts,
                    kind: Kind::Scan,
                    ip: b.src,
                    port: b.port,
                    edge: false,
                });
            }
        });
        if pos != self.st.ufw_pos {
            self.st.ufw_pos = pos;
            self.dirty = true;
        }

        let mut pos = self.st.auth_pos;
        follow(&log, "auth.log", &mut pos, seeding, |l| {
            if let Some((ts, Auth::Failed { ip })) = security::auth_line(l)
                && let Ok(ip) = ip.parse::<IpAddr>()
                && is_global(ip)
            {
                hits.push(Hit {
                    ts,
                    kind: Kind::Ssh,
                    ip: unmap(ip),
                    port: None,
                    edge: false,
                });
            }
        });
        if pos != self.st.auth_pos {
            self.st.auth_pos = pos;
            self.dirty = true;
        }

        // NPM keeps one access log per proxy host; the fallback log has no host field
        if let Ok(entries) = fs::read_dir(&self.roots.npm) {
            let mut names: Vec<_> = entries
                .flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| {
                    n.strip_prefix("proxy-host-")
                        .and_then(|s| s.strip_suffix("_access.log"))
                        .is_some_and(|s| !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit()))
                })
                .collect();
            names.sort();
            for name in names {
                let mut pos = self.st.npm_pos.get(&name).copied();
                follow(&self.roots.npm, &name, &mut pos, seeding, |l| {
                    let Some(a) = security::npm_line(l) else {
                        return;
                    };
                    if security::probe_kind(&a.path).is_none() {
                        return;
                    }
                    let Some((_, origin)) = security::net_of(&a.client) else {
                        return;
                    };
                    let Ok(ip) = a.client.trim().parse::<IpAddr>() else {
                        return;
                    };
                    if origin == Origin::Private {
                        return;
                    }
                    let edge = origin == Origin::Cloudflare;
                    if edge || is_global(ip) {
                        hits.push(Hit {
                            ts: a.ts,
                            kind: Kind::Web,
                            ip: unmap(ip),
                            port: None,
                            edge,
                        });
                    }
                });
                if let Some(p) = pos
                    && self.st.npm_pos.insert(name, p) != Some(p)
                {
                    self.dirty = true;
                }
            }
        }

        for h in hits {
            self.record(h, now);
        }
        if self.seeding {
            self.seeding = false;
            self.last_save = 0.;
        }
    }

    fn prune(&mut self, now: f64) {
        let today = bkk_day(now);
        let (days, hours) = (self.st.days.len(), self.st.hours.len());
        self.st
            .days
            .retain(|d, _| *d >= today - (KEEP_DAYS - 1) * DAY);
        self.st
            .hours
            .retain(|h, _| *h >= hour(now) - (KEEP_HOURS - 1) * 3600);
        if (days, hours) != (self.st.days.len(), self.st.hours.len()) {
            self.dirty = true;
        }
        // a closed day only needs its short lists
        for b in self.st.days.range_mut(..today).map(|(_, b)| b) {
            trim(&mut b.ips, (CLOSED_IPS, CLOSED_IPS), IpHits::total);
            for hits in b.c.values_mut() {
                trim(&mut hits.ports, (CLOSED_PORTS, CLOSED_PORTS), |n| *n);
            }
        }
    }

    /// One pass: new log lines, then housekeeping and a save when something changed
    pub fn tick(&mut self, now: f64) {
        self.read_logs(now);
        if now - self.last_prune >= 60. {
            self.prune(now);
            self.last_prune = now;
        }
        if self.dirty && now - self.last_save >= SAVE_EVERY {
            if let Err(e) = self.save() {
                eprintln!("attacks save error: {e}");
            }
            self.last_save = now;
        }
    }

    pub fn save(&mut self) -> std::io::Result<()> {
        fs::create_dir_all(&self.roots.data)?;
        let tmp = self.roots.data.join("attacks.json.tmp");
        let mut file = File::create(&tmp)?;
        file.write_all(&serde_json::to_vec(&self.st)?)?;
        file.sync_all()?;
        fs::rename(tmp, self.roots.data.join("attacks.json"))?;
        self.dirty = false;
        Ok(())
    }

    /// The map's data for the last `days` (1 = the last 24 hours, 7 or 30 = Bangkok days up to today)
    pub fn payload(&self, days: u32, now: f64) -> Value {
        let (from, buckets): (i64, Vec<&Bucket>) = if days == 1 {
            let from = hour(now) - 23 * 3600;
            (from, self.st.hours.range(from..).map(|(_, b)| b).collect())
        } else {
            let from = bkk_day(now) - (i64::from(days) - 1) * DAY;
            (from, self.st.days.range(from..).map(|(_, b)| b).collect())
        };
        let mut by_cc: BTreeMap<&str, Hits> = BTreeMap::new();
        let mut by_ip: BTreeMap<&str, IpHits> = BTreeMap::new();
        let mut ports: BTreeMap<&str, u32> = BTreeMap::new();
        let (mut cf, mut zz) = (0, 0);
        for b in &buckets {
            cf += b.cf;
            zz += b.zz;
            for (cc, h) in &b.c {
                let sum = by_cc.entry(cc.as_str()).or_default();
                sum.ssh += h.ssh;
                sum.scan += h.scan;
                sum.web += h.web;
                for (p, n) in &h.ports {
                    *sum.ports.entry(p.clone()).or_default() += n;
                    *ports.entry(p.as_str()).or_default() += n;
                }
            }
            for (ip, h) in &b.ips {
                let sum = by_ip.entry(ip.as_str()).or_insert_with(|| IpHits {
                    cc: h.cc.clone(),
                    ..IpHits::default()
                });
                sum.ssh += h.ssh;
                sum.scan += h.scan;
                sum.web += h.web;
            }
        }
        let top = |m: &BTreeMap<String, u32>, n: usize| -> Vec<Value> {
            let mut v: Vec<_> = m.iter().collect();
            v.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
            v.into_iter()
                .take(n)
                .map(|(p, c)| json!({ "port": p, "count": c }))
                .collect()
        };
        let (mut ssh, mut scan, mut web) = (0u64, 0u64, 0u64);
        let mut rows: Vec<(&str, &Hits)> = by_cc.iter().map(|(cc, h)| (*cc, h)).collect();
        rows.sort_by(|a, b| b.1.total().cmp(&a.1.total()).then(a.0.cmp(b.0)));
        let countries: Vec<Value> = rows
            .iter()
            .map(|(cc, h)| {
                ssh += u64::from(h.ssh);
                scan += u64::from(h.scan);
                web += u64::from(h.web);
                let at = place(cc);
                json!({
                    "cc": cc,
                    "name": at.map_or(*cc, |p| p.0),
                    "lat": at.map(|p| p.1),
                    "lon": at.map(|p| p.2),
                    "ssh": h.ssh,
                    "scan": h.scan,
                    "web": h.web,
                    "total": h.total(),
                    "ports": top(&h.ports, 5),
                })
            })
            .collect();
        let mut ips: Vec<_> = by_ip.iter().collect();
        ips.sort_by(|a, b| b.1.total().cmp(&a.1.total()).then(a.0.cmp(b.0)));
        let top_ips: Vec<Value> = ips
            .into_iter()
            .take(15)
            .map(|(ip, h)| {
                json!({ "ip": ip, "cc": h.cc, "ssh": h.ssh, "scan": h.scan, "web": h.web, "total": h.total() })
            })
            .collect();
        let port_totals: BTreeMap<String, u32> =
            ports.into_iter().map(|(p, n)| (p.to_string(), n)).collect();
        json!({
            "enabled": true,
            "now": now,
            "days": days,
            "since": from,
            "firstDay": self.st.days.keys().next(),
            "server": { "name": SERVER.0, "cc": SERVER.1, "lat": SERVER.2, "lon": SERVER.3 },
            "totals": { "ssh": ssh, "scan": scan, "web": web, "total": ssh + scan + web },
            "unlocated": { "webCloudflare": cf, "unknown": zz },
            "countries": countries,
            "topPorts": top(&port_totals, 10),
            "topIps": top_ips,
            "geo": {
                "source": "DB-IP IP to Country Lite",
                "license": "CC BY 4.0",
                "url": "https://db-ip.com",
                "month": self.month,
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Temp(PathBuf);
    impl Temp {
        fn new(name: &str) -> Self {
            let p = std::env::temp_dir().join(format!("atk-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&p);
            for d in ["host/log", "npm", "data"] {
                fs::create_dir_all(p.join(d)).unwrap();
            }
            fs::write(p.join("geo.csv"), GEO).unwrap();
            Self(p)
        }
        fn roots(&self) -> Roots {
            Roots {
                host: self.0.join("host"),
                proc: self.0.join("proc"),
                npm: self.0.join("npm"),
                data: self.0.join("data"),
            }
        }
        fn log(&self, rel: &str) -> PathBuf {
            self.0.join(rel)
        }
        fn load(&self, now: f64) -> Attacks {
            Attacks::load(self.roots(), &self.0.join("geo.csv"), "2026-10".into(), now).unwrap()
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn append(path: &Path, text: &str) {
        let mut f = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        f.write_all(text.as_bytes()).unwrap();
    }

    const GEO: &str = "\
45.0.0.0,45.255.255.255,DE
60.0.0.0,60.255.255.255,CN
80.0.0.0,80.255.255.255,NL
2001:4860::,2001:4860:ffff:ffff:ffff:ffff:ffff:ffff,US
";
    const NOW: &str = "2026-11-14T12:00:00+07:00";
    fn now() -> f64 {
        security::iso_time(NOW).unwrap()
    }
    fn ufw(ts: &str, src: &str, proto: &str, dpt: u16) -> String {
        format!(
            "{ts} ubuntu kernel: [123.4] [UFW BLOCK] IN=eth0 OUT= MAC=aa:bb SRC={src} DST=203.0.113.9 LEN=44 TOS=0x00 PROTO={proto} SPT=5 DPT={dpt} WINDOW=1 RES=0x00 SYN URGP=0\n"
        )
    }
    fn failed(ts: &str, ip: &str) -> String {
        format!("{ts} ubuntu sshd[7]: Invalid user admin from {ip} port 4\n")
    }
    fn probe(utc: &str, client: &str, path: &str) -> String {
        format!(
            "[{utc} +0000] - 404 404 - GET https example.chakkritton.com \"{path}\" [Client {client}] [Length 9] [Gzip -] [Sent-to app] \"curl/8\" \"-\"\n"
        )
    }
    fn count(v: &Value, key: &str) -> u64 {
        v["totals"][key].as_u64().unwrap()
    }
    fn country<'a>(v: &'a Value, cc: &str) -> Option<&'a Value> {
        v["countries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["cc"] == cc)
    }

    #[test]
    fn ufw_lines() {
        let b = ufw_line(&ufw(
            "2026-11-14T10:00:00.123456+07:00",
            "45.1.2.3",
            "TCP",
            22,
        ))
        .unwrap();
        assert_eq!(b.src, "45.1.2.3".parse::<IpAddr>().unwrap());
        assert_eq!(b.port.as_deref(), Some("tcp/22"));
        assert_eq!(
            b.ts,
            security::iso_time("2026-11-14T10:00:00.123456+07:00").unwrap()
        );
        let udp = ufw_line(&ufw("2026-11-14T10:00:00+07:00", "45.1.2.3", "UDP", 5060)).unwrap();
        assert_eq!(udp.port.as_deref(), Some("udp/5060"));
        let v6 = "2026-11-14T10:00:00+07:00 ubuntu kernel: [1.0] [UFW BLOCK] IN=eth0 OUT= SRC=2001:4860:0000:0000:0000:0000:0000:0001 DST=2001:0db8:0000:0000:0000:0000:0000:0002 LEN=40 TC=0 HOPLIMIT=50 PROTO=TCP SPT=1 DPT=443 WINDOW=0";
        let b = ufw_line(v6).unwrap();
        assert_eq!(b.src, "2001:4860::1".parse::<IpAddr>().unwrap());
        assert_eq!(b.port.as_deref(), Some("tcp/443"));
        // a protocol without ports counts as a block with no port
        let icmp = "2026-11-14T10:00:00+07:00 ubuntu kernel: [1.0] [UFW BLOCK] IN=eth0 OUT= SRC=45.1.2.3 DST=203.0.113.9 LEN=84 PROTO=ICMP TYPE=8 CODE=0";
        assert_eq!(ufw_line(icmp).unwrap().port, None);
        // ufw's SSH rate limit
        let limit = ufw("2026-11-14T10:00:00+07:00", "45.1.2.3", "TCP", 22)
            .replace("[UFW BLOCK]", "[UFW LIMIT BLOCK]");
        assert!(ufw_line(&limit).is_some());
        // the packet quoted inside an ICMP error must not replace the real source
        let quoted = format!(
            "{} [SRC=8.8.8.8 DST=1.1.1.1 PROTO=TCP DPT=1]",
            ufw("2026-11-14T10:00:00+07:00", "45.1.2.3", "TCP", 22).trim_end()
        );
        assert_eq!(
            ufw_line(&quoted).unwrap().src,
            "45.1.2.3".parse::<IpAddr>().unwrap()
        );
        for no in [
            "2026-11-14T10:00:00+07:00 ubuntu kernel: [1.0] [UFW ALLOW] IN=eth0 SRC=45.1.2.3 PROTO=TCP DPT=22",
            "2026-11-14T10:00:00+07:00 ubuntu sshd[7]: Invalid user a from 45.1.2.3 port 4",
            "garbage [UFW BLOCK] SRC=45.1.2.3 PROTO=TCP DPT=22",
            "2026-11-14T10:00:00+07:00 ubuntu kernel: [UFW BLOCK] PROTO=TCP DPT=22",
        ] {
            assert_eq!(ufw_line(no), None, "{no}");
        }
    }

    #[test]
    fn only_routable_addresses_count() {
        for ok in [
            "45.1.2.3",
            "8.8.8.8",
            "2001:4860::1",
            "::ffff:45.1.2.3",
            "2a00:1::5",
        ] {
            assert!(is_global(ok.parse().unwrap()), "{ok}");
        }
        for no in [
            "10.1.2.3",
            "172.17.0.2",
            "192.168.1.1",
            "127.0.0.1",
            "169.254.1.1",
            "100.64.0.1",
            "0.0.0.0",
            "224.0.0.1",
            "255.255.255.255",
            "240.0.0.1",
            "192.0.2.5",
            "198.18.0.1",
            "198.51.100.7",
            "203.0.113.9",
            "fe80::1",
            "fe80:0000:0000:0000:4e0b:b1ff:fee0:cca4",
            "ff02::1",
            "::1",
            "fd00::1",
            "2001:db8::1",
            "::ffff:10.0.0.1",
        ] {
            assert!(!is_global(no.parse().unwrap()), "{no}");
        }
    }

    #[test]
    fn complete_lines_only_and_long_lines_dropped() {
        let long = "x".repeat(MAX_LINE as usize * 2 + 10);
        let text = format!("one\r\n{long}\ntwo\npartial");
        let mut seen = Vec::new();
        let used = each_line(text.as_bytes(), |l| seen.push(l.to_string())).unwrap();
        assert_eq!(seen, ["one", "two"]);
        assert_eq!(used as usize, text.len() - "partial".len());
    }

    #[test]
    fn place_table_is_sorted() {
        assert!(centroids::COUNTRIES.windows(2).all(|w| w[0].0 < w[1].0));
        assert_eq!(place("TH").map(|p| p.0), Some("Thailand"));
        assert_eq!(place("XX"), None);
        let (_, lat, lon) = place("SG").unwrap();
        assert!((1.0..2.0).contains(&lat) && (103.0..104.5).contains(&lon));
    }

    fn seeded(t: &Temp) -> Attacks {
        append(
            &t.log("host/log/ufw.log"),
            &[
                ufw("2026-11-14T10:00:00.1+07:00", "45.1.1.1", "TCP", 22),
                ufw("2026-11-14T10:00:01+07:00", "45.1.1.1", "TCP", 22),
                ufw("2026-11-14T10:00:02+07:00", "45.1.1.1", "TCP", 22),
                ufw("2026-11-14T11:00:00+07:00", "45.1.1.2", "UDP", 5060),
                ufw("2026-11-14T11:00:01+07:00", "45.1.1.2", "UDP", 5060),
                ufw("2026-11-14T09:00:00+07:00", "60.2.2.2", "TCP", 3389),
                ufw(
                    "2026-11-14T09:00:01+07:00",
                    "2001:4860:0:0:0:0:0:9",
                    "TCP",
                    443,
                ),
                // the host's own network, an address with no country, an older day, and one past the 30 days
                ufw(
                    "2026-11-14T09:30:00+07:00",
                    "fe80:0000:0000:0000:4e0b:b1ff:fee0:cca4",
                    "UDP",
                    5353,
                ),
                ufw("2026-11-14T09:30:01+07:00", "192.168.1.5", "TCP", 80),
                ufw("2026-11-14T09:30:02+07:00", "90.1.1.1", "TCP", 23),
                ufw("2026-11-10T10:00:00+07:00", "80.3.3.3", "TCP", 22),
                ufw("2026-09-01T10:00:00+07:00", "80.3.3.3", "TCP", 22),
            ]
            .concat(),
        );
        append(
            &t.log("host/log/auth.log"),
            &[
                failed("2026-11-14T10:05:00+07:00", "45.1.1.1"),
                failed("2026-11-14T10:05:01+07:00", "45.1.1.1"),
                failed("2026-11-14T10:05:02+07:00", "45.1.1.1"),
                failed("2026-11-14T10:05:03+07:00", "45.1.1.1"),
                failed("2026-11-14T10:05:04+07:00", "10.0.0.9"),
                "2026-11-14T10:06:00+07:00 ubuntu sshd[7]: Accepted publickey for root from 45.1.1.1 port 4 ssh2: ED25519 SHA256:abc\n".into(),
            ]
            .concat(),
        );
        append(
            &t.log("npm/proxy-host-1_access.log"),
            &[
                probe("14/Nov/2026:03:00:00", "60.2.2.2", "/.env"),
                probe("14/Nov/2026:03:00:01", "172.68.241.2", "/wp-login.php"),
                probe("14/Nov/2026:03:00:02", "60.2.2.2", "/"),
                probe("14/Nov/2026:03:00:03", "192.168.1.1", "/.git/config"),
            ]
            .concat(),
        );
        append(
            &t.log("npm/fallback_http_access.log"),
            &probe("14/Nov/2026:03:00:00", "60.2.2.2", "/.env"),
        );
        let mut a = t.load(now());
        a.tick(now());
        a
    }

    #[test]
    fn counts_by_country_kind_and_port() {
        let t = Temp::new("counts");
        let a = seeded(&t);
        let day = a.payload(1, now());
        assert_eq!(
            (count(&day, "ssh"), count(&day, "scan"), count(&day, "web")),
            (4, 7, 1)
        );
        assert_eq!(count(&day, "total"), 12);
        let de = country(&day, "DE").unwrap();
        assert_eq!(
            (de["ssh"].as_u64(), de["scan"].as_u64(), de["web"].as_u64()),
            (Some(4), Some(5), Some(0))
        );
        assert_eq!(de["name"], "Germany");
        assert_eq!(de["ports"][0], json!({ "port": "tcp/22", "count": 3 }));
        assert_eq!(de["ports"][1], json!({ "port": "udp/5060", "count": 2 }));
        let cn = country(&day, "CN").unwrap();
        assert_eq!(
            (cn["scan"].as_u64(), cn["web"].as_u64()),
            (Some(1), Some(1))
        );
        assert!(country(&day, "US").is_some(), "an IPv6 source is located");
        // sorted by total, busiest first
        assert_eq!(day["countries"][0]["cc"], "DE");
        // nothing from the host's own network, and an unlocatable address and a Cloudflare edge are counted apart
        assert_eq!(
            day["unlocated"],
            json!({ "webCloudflare": 1, "unknown": 1 })
        );
        assert_eq!(day["topIps"][0]["ip"], "45.1.1.1");
        assert_eq!(day["topIps"][0]["total"], 7);
        assert_eq!(day["topPorts"][0], json!({ "port": "tcp/22", "count": 3 }));
        assert_eq!(day["server"]["cc"], "TH");
        assert_eq!(day["geo"]["month"], "2026-10");

        // the 7 day view adds the 10th; the line from September is past the 30 days and never counted
        let week = a.payload(7, now());
        assert_eq!(count(&week, "scan"), 8);
        assert!(country(&week, "NL").is_some());
        assert!(country(&day, "NL").is_none());
        assert_eq!(count(&a.payload(30, now()), "scan"), 8);
        assert_eq!(week["since"], bkk_day(now()) - 6 * DAY);
    }

    #[test]
    fn reads_only_new_lines_and_follows_rotation() {
        let t = Temp::new("rotate");
        let mut a = seeded(&t);
        a.tick(now());
        assert_eq!(
            count(&a.payload(1, now()), "scan"),
            7,
            "a second pass adds nothing"
        );

        append(
            &t.log("host/log/ufw.log"),
            &ufw("2026-11-14T11:30:00+07:00", "60.2.2.2", "TCP", 3389),
        );
        append(
            &t.log("host/log/ufw.log"),
            "2026-11-14T11:31:00+07:00 ubuntu kernel: [UFW BLOCK] SRC=60.2.",
        );
        a.tick(now());
        assert_eq!(
            count(&a.payload(1, now()), "scan"),
            8,
            "an unfinished line waits"
        );

        // logrotate moves the file; one line was written to it after the last pass
        append(&t.log("host/log/ufw.log"), "2.2 PROTO=TCP DPT=22\n");
        append(
            &t.log("host/log/ufw.log"),
            &ufw("2026-11-14T11:40:00+07:00", "45.1.1.1", "TCP", 22),
        );
        fs::rename(t.log("host/log/ufw.log"), t.log("host/log/ufw.log.1")).unwrap();
        append(
            &t.log("host/log/ufw.log"),
            &[
                ufw("2026-11-14T11:50:00+07:00", "45.1.1.1", "TCP", 22),
                ufw("2026-11-14T11:50:01+07:00", "45.1.1.1", "TCP", 22),
            ]
            .concat(),
        );
        a.tick(now());
        let day = a.payload(1, now());
        // the unfinished line once completed, the line written to the old file, and the two in the new one
        assert_eq!(count(&day, "scan"), 8 + 1 + 1 + 2);
        assert_eq!(
            country(&day, "DE").unwrap()["ports"][0],
            json!({ "port": "tcp/22", "count": 6 })
        );
    }

    #[test]
    fn first_run_reads_rotated_and_compressed_copies_then_survives_a_restart() {
        let t = Temp::new("seed");
        let log = t.log("host/log");
        let mut z = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        z.write_all(
            [
                ufw("2026-11-02T10:00:00+07:00", "45.1.1.1", "TCP", 22),
                ufw("2026-11-02T10:00:01+07:00", "45.1.1.1", "TCP", 22),
            ]
            .concat()
            .as_bytes(),
        )
        .unwrap();
        fs::write(log.join("ufw.log.2.gz"), z.finish().unwrap()).unwrap();
        append(
            &log.join("ufw.log.1"),
            &ufw("2026-11-09T10:00:00+07:00", "60.1.1.1", "UDP", 53),
        );
        append(
            &log.join("ufw.log"),
            &ufw("2026-11-14T10:00:00+07:00", "80.1.1.1", "TCP", 23),
        );
        // NPM compresses a rotated log at once
        let mut z = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        z.write_all(probe("05/Nov/2026:03:00:00", "60.2.2.2", "/phpmyadmin/").as_bytes())
            .unwrap();
        fs::write(
            t.log("npm/proxy-host-4_access.log.1.gz"),
            z.finish().unwrap(),
        )
        .unwrap();
        append(
            &t.log("npm/proxy-host-4_access.log"),
            &probe("14/Nov/2026:03:00:00", "60.2.2.2", "/.env"),
        );

        let mut a = t.load(now());
        a.tick(now());
        let all = a.payload(30, now());
        assert_eq!((count(&all, "scan"), count(&all, "web")), (4, 2));
        assert_eq!(
            count(&a.payload(1, now()), "scan"),
            1,
            "the 24 h view only has the last day"
        );
        a.save().unwrap();

        // a restart reads the state, not the logs again; only what is added later counts
        let mut b = t.load(now());
        b.tick(now());
        assert_eq!(count(&b.payload(30, now()), "scan"), 4);
        append(
            &log.join("ufw.log"),
            &ufw("2026-11-14T11:00:00+07:00", "80.1.1.1", "TCP", 23),
        );
        b.tick(now());
        assert_eq!(count(&b.payload(30, now()), "scan"), 5);

        // the module owns one state file and creates nothing else: no events, no outbox
        let mut names: Vec<_> = fs::read_dir(t.log("data"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, ["attacks.json"]);
    }

    #[test]
    fn busy_lists_are_capped_and_keep_the_heaviest() {
        let t = Temp::new("cap");
        let mut text = String::new();
        for _ in 0..40 {
            text += &ufw("2026-11-14T10:00:00+07:00", "45.9.9.9", "TCP", 22);
        }
        for n in 0..300 {
            text += &ufw(
                "2026-11-14T10:00:01+07:00",
                &format!("45.1.{}.{}", n / 250, n % 250 + 1),
                "TCP",
                1000 + n,
            );
        }
        append(&t.log("host/log/ufw.log"), &text);
        let mut a = t.load(now());
        a.tick(now());
        let day = a.st.days.values().next().unwrap();
        assert!(day.ips.len() <= DAY_IPS.0, "{}", day.ips.len());
        assert!(day.c["DE"].ports.len() <= PORTS.0);
        let p = a.payload(7, now());
        assert_eq!(p["topIps"][0]["ip"], "45.9.9.9");
        assert_eq!(p["topIps"][0]["scan"], 40);
        assert_eq!(p["topPorts"][0]["port"], "tcp/22");
        // closed days are cut to the short list on the next housekeeping pass
        a.prune(now() + 3. * DAY as f64);
        assert!(a.st.days.values().next().unwrap().ips.len() <= CLOSED_IPS);
    }

    #[test]
    fn old_buckets_are_pruned() {
        let t = Temp::new("prune");
        append(
            &t.log("host/log/ufw.log"),
            &ufw("2026-11-14T10:00:00+07:00", "45.1.1.1", "TCP", 22),
        );
        let mut a = t.load(now());
        a.tick(now());
        assert_eq!((a.st.days.len(), a.st.hours.len()), (1, 1));
        a.prune(now() + 2. * DAY as f64);
        assert_eq!(a.st.hours.len(), 0, "hourly buckets last about a day");
        assert_eq!(a.st.days.len(), 1);
        a.prune(now() + 31. * DAY as f64);
        assert_eq!(a.st.days.len(), 0);
    }

    #[test]
    fn without_a_database_the_map_is_off() {
        let t = Temp::new("nodb");
        assert!(
            Attacks::load(t.roots(), &t.0.join("absent.csv.gz"), String::new(), now()).is_none()
        );
    }
}
