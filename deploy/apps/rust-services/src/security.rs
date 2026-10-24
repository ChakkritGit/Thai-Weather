//! Security watch for Dock's ความปลอดภัย page and for alerts in Dock's chat.
//!
//! Everything is read through read-only mounts (deploy/docker-compose.yml): the host's auth.log, NPM's
//! access logs, a fixed list of files an intruder would change, the host's listening sockets, Docker's
//! container configs, update-notifier's summary and the nightly image scan (deploy/hardening/
//! dock-image-scan.py). State lives in DATA_DIR/security.json: log offsets,
//! the networks and SSH keys seen before, file hashes and recent events. Nothing here talks to the
//! outside: apps-chat polls `/security/outbox` for new alert events and posts them.
//!
//! The first run (no state file) learns silently: what is already in the logs, files and ports is the
//! baseline. Only what changes after that becomes an event.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

const DAY: i64 = 86_400;
const BANGKOK: i64 = 7 * 3600;
const KEEP_DAYS: i64 = 14;
/** an event colours its category for this long unless the owner acknowledges it first */
const EVENT_WINDOW: f64 = 3. * 86_400.;
const MAX_EVENTS: usize = 200;
const MAX_LOGINS: usize = 60;
const SLOW_EVERY: f64 = 60.;
const UPDATES_EVERY: f64 = 600.;
const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_SCAN_BYTES: u64 = 4 * 1024 * 1024;
/** an image scan older than this colours the category: the nightly timer has missed a night */
const SCAN_STALE: f64 = 2. * 86_400.;

#[derive(Clone)]
pub struct Roots {
    /// host views: log/ (/var/log), etc/ (/etc), root/ (/root), cron/ (/var/spool/cron),
    /// boot/ (/boot), apt/ (/var/lib/update-notifier), containers/ (/var/lib/docker/containers),
    /// scan/ (/var/lib/dock-scan)
    pub host: PathBuf,
    pub proc: PathBuf,
    pub npm: PathBuf,
    pub data: PathBuf,
}
impl Roots {
    pub fn from_env(paths: &crate::host::Paths) -> Self {
        Self {
            host: std::env::var_os("SECURITY_HOST")
                .map(PathBuf::from)
                .unwrap_or_else(|| "/host".into()),
            proc: paths.proc.clone(),
            npm: paths.logs.clone(),
            data: paths.data.clone(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Info,
    Warn,
    Bad,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Event {
    pub id: u64,
    pub ts: f64,
    pub cat: String,
    pub level: Level,
    pub title: String,
    pub detail: String,
    pub alert: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Login {
    ts: f64,
    /// "ssh" or a panel: "dock", "portainer", "npm"
    via: String,
    user: String,
    ip: String,
    net: String,
    /// SSH: key fingerprint or method; panels: a short browser/OS description
    how: String,
    new: bool,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct WebDay {
    probes: u32,
    kinds: BTreeMap<String, u32>,
    guard: u32,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct FileSig {
    hash: String,
    size: u64,
    /// user names (passwd/group) or key fingerprints (authorized_keys), to say what changed
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    items: Vec<String>,
    #[serde(default)]
    changed: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Seen {
    image: String,
    risky: Vec<String>,
    first: f64,
    last: f64,
}
#[derive(Default, Serialize, Deserialize)]
struct State {
    #[serde(default)]
    started: f64,
    #[serde(default)]
    next_id: u64,
    #[serde(default)]
    acked: f64,
    #[serde(default)]
    auth_pos: Option<[u64; 2]>,
    #[serde(default)]
    npm_pos: BTreeMap<String, [u64; 2]>,
    #[serde(default)]
    ssh_nets: BTreeMap<String, f64>,
    #[serde(default)]
    ssh_keys: BTreeMap<String, f64>,
    #[serde(default)]
    panel_nets: BTreeMap<String, BTreeMap<String, f64>>,
    #[serde(default)]
    logins: VecDeque<Login>,
    /// hour start → failed SSH attempts
    #[serde(default)]
    failed: BTreeMap<i64, u32>,
    /// hour start → ip → failed SSH attempts (top list)
    #[serde(default)]
    failed_ips: BTreeMap<i64, BTreeMap<String, u32>>,
    /// hour start → panel → wrong passwords
    #[serde(default)]
    panel_failed: BTreeMap<i64, BTreeMap<String, u32>>,
    /// Bangkok day start → bot probes
    #[serde(default)]
    web: BTreeMap<i64, WebDay>,
    /// "host path" → (count, last seen), the last 7 days
    #[serde(default)]
    probe_paths: BTreeMap<String, (u32, f64)>,
    #[serde(default)]
    files: BTreeMap<String, FileSig>,
    #[serde(default)]
    files_checked: f64,
    #[serde(default)]
    ports: BTreeSet<String>,
    #[serde(default)]
    containers: BTreeMap<String, Seen>,
    #[serde(default)]
    events: VecDeque<Event>,
    /// WATCH entries already learned: one added in a later version is learned silently, like a first run
    #[serde(default)]
    watched: BTreeSet<String>,
    /// "image|SEVERITY|id|package" of every fixable CRITICAL/HIGH finding in the last image scan
    #[serde(default)]
    image_vulns: BTreeSet<String>,
    /// `scanned` of the last image scan turned into events
    #[serde(default)]
    scan_seen: f64,
}

#[derive(Default, Clone, Serialize)]
struct Ctr {
    name: String,
    ident: String,
    image: String,
    compose: bool,
    running: bool,
    risky: Vec<String>,
}
#[derive(Default, Clone, Serialize)]
struct Updates {
    pending: Option<u32>,
    security: Option<u32>,
    kernel: String,
    newest: String,
    reboot: bool,
    checked: f64,
}
/// Facts read on each slow pass; not persisted.
#[derive(Default)]
struct Live {
    ports: Vec<String>,
    containers: Vec<Ctr>,
    updates: Updates,
    checked: f64,
    /// the scanner's images.json, and the (size, mtime) it was read at
    scan: Value,
    scan_stamp: Option<(u64, i64, i64)>,
}

pub struct Security {
    roots: Roots,
    st: State,
    live: Live,
    seeding: bool,
    dirty: bool,
    last_slow: f64,
    last_save: f64,
}

// ------------------------------------------------------------------ time and networks
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}
/// syslog's RFC 3339 stamp, e.g. `2026-10-24T23:16:34.498650+07:00`
pub fn iso_time(s: &str) -> Option<f64> {
    let b = s.as_bytes();
    if b.len() < 20
        || b[4] != b'-'
        || b[7] != b'-'
        || b[10] != b'T'
        || b[13] != b':'
        || b[16] != b':'
    {
        return None;
    }
    let n = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, se) = (
        n(0..4)?,
        n(5..7)?,
        n(8..10)?,
        n(11..13)?,
        n(14..16)?,
        n(17..19)?,
    );
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 60 {
        return None;
    }
    let mut rest = &s[19..];
    let mut frac = 0.;
    if let Some(r) = rest.strip_prefix('.') {
        let digits = r.bytes().take_while(u8::is_ascii_digit).count();
        frac = format!("0.{}", &r[..digits]).parse().ok()?;
        rest = &r[digits..];
    }
    let offset = if rest == "Z" {
        0
    } else {
        let sign = match rest.as_bytes().first()? {
            b'+' => 1,
            b'-' => -1,
            _ => return None,
        };
        let oh = rest.get(1..3)?.parse::<i64>().ok()?;
        let om = rest.get(4..6)?.parse::<i64>().ok()?;
        if rest.len() != 6 || &rest[3..4] != ":" {
            return None;
        }
        sign * (oh * 3600 + om * 60)
    };
    let secs = days_from_civil(y, mo, d) * DAY + h * 3600 + mi * 60 + se - offset;
    Some(secs as f64 + frac)
}
fn bkk_day(ts: f64) -> i64 {
    (ts as i64 + BANGKOK).div_euclid(DAY) * DAY - BANGKOK
}
fn hour(ts: f64) -> i64 {
    (ts as i64).div_euclid(3600) * 3600
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Origin {
    Public,
    /// a Cloudflare edge: the visitor's own address was not restored
    Cloudflare,
    Private,
}
const CF4: [(u32, u8); 15] = [
    (0xADF5_3000, 20), // 173.245.48.0/20
    (0x6715_F400, 22), // 103.21.244.0/22
    (0x6716_C800, 22), // 103.22.200.0/22
    (0x671F_0400, 22), // 103.31.4.0/22
    (0x8D65_4000, 18), // 141.101.64.0/18
    (0x6CA2_C000, 18), // 108.162.192.0/18
    (0xBE5D_F000, 20), // 190.93.240.0/20
    (0xBC72_6000, 20), // 188.114.96.0/20
    (0xC5EA_F000, 22), // 197.234.240.0/22
    (0xC629_8000, 17), // 198.41.128.0/17
    (0xA29E_0000, 15), // 162.158.0.0/15
    (0x6810_0000, 13), // 104.16.0.0/13
    (0x6818_0000, 14), // 104.24.0.0/14
    (0xAC40_0000, 13), // 172.64.0.0/13
    (0x8300_4800, 22), // 131.0.72.0/22
];
const CF6: [(u128, u8); 7] = [
    (0x2400_cb00 << 96, 32),
    (0x2606_4700 << 96, 32),
    (0x2803_f800 << 96, 32),
    (0x2405_b500 << 96, 32),
    (0x2405_8100 << 96, 32),
    (0x2a06_98c0 << 96, 29),
    (0x2c0f_f248 << 96, 32),
];
fn in4(ip: u32, (net, bits): (u32, u8)) -> bool {
    ip >> (32 - bits) == net >> (32 - bits)
}
fn in6(ip: u128, (net, bits): (u128, u8)) -> bool {
    ip >> (128 - bits) == net >> (128 - bits)
}
/// The network a login is remembered by (/24 or /64: a phone's next address is still "seen before")
pub fn net_of(ip: &str) -> Option<(String, Origin)> {
    let ip: IpAddr = ip.trim().parse().ok()?;
    let ip = match ip {
        IpAddr::V6(v6) => v6
            .to_ipv4_mapped()
            .map(IpAddr::V4)
            .unwrap_or(IpAddr::V6(v6)),
        v4 => v4,
    };
    Some(match ip {
        IpAddr::V4(v4) => {
            let n = u32::from(v4);
            let origin = if v4.is_private() || v4.is_loopback() || v4.is_link_local() {
                Origin::Private
            } else if CF4.iter().any(|r| in4(n, *r)) {
                Origin::Cloudflare
            } else {
                Origin::Public
            };
            (format!("{}/24", Ipv4Addr::from(n & 0xFFFF_FF00)), origin)
        }
        IpAddr::V6(v6) => {
            let n = u128::from(v6);
            let origin = if v6.is_loopback() || (n >> 121) == 0x7E || (n >> 118) == 0x3FA {
                Origin::Private
            } else if CF6.iter().any(|r| in6(n, *r)) {
                Origin::Cloudflare
            } else {
                Origin::Public
            };
            (
                format!("{}/64", Ipv6Addr::from(n & !((1u128 << 64) - 1))),
                origin,
            )
        }
    })
}

// ------------------------------------------------------------------ log lines
#[derive(Debug, PartialEq)]
pub enum Auth {
    Accepted {
        user: String,
        ip: String,
        method: String,
        key: Option<String>,
    },
    Failed {
        ip: String,
    },
    Account {
        text: String,
    },
}
fn after<'a>(s: &'a str, marker: &str) -> Option<&'a str> {
    s.split_once(marker)
        .map(|(_, r)| r.split_whitespace().next().unwrap_or(""))
}
fn clip(s: &str, n: usize) -> String {
    let mut out: String = s.chars().take(n).collect();
    if s.chars().count() > n {
        out.push('…');
    }
    out
}
/// One auth.log line: `<RFC 3339 time> <host> <program>[pid]: <message>`
pub fn auth_line(line: &str) -> Option<(f64, Auth)> {
    let mut it = line.splitn(4, ' ');
    let ts = iso_time(it.next()?)?;
    let _host = it.next()?;
    let prog = it.next()?.trim_end_matches(':');
    let msg = it.next()?.trim_end();
    let name = prog.split('[').next().unwrap_or(prog);
    if name == "sshd" || name == "sshd-session" {
        if let Some(rest) = msg.strip_prefix("Accepted ") {
            let method = rest.split_whitespace().next()?.to_string();
            let user = after(rest, " for ")?.to_string();
            let ip = after(rest, " from ")?.to_string();
            let key = rest
                .split_once(": ")
                .and_then(|(_, k)| k.split_whitespace().nth(1))
                .filter(|k| k.starts_with("SHA256:"))
                .map(str::to_string);
            return Some((
                ts,
                Auth::Accepted {
                    user,
                    ip,
                    method,
                    key,
                },
            ));
        }
        let failed_from = |m: &str| after(m, " from ").map(|ip| Auth::Failed { ip: ip.into() });
        if msg.starts_with("Invalid user ")
            || msg.starts_with("Failed password for")
            || msg.starts_with("Failed publickey for")
            || msg.starts_with("Failed keyboard-interactive")
        {
            return failed_from(msg).map(|a| (ts, a));
        }
        for prefix in [
            "Connection closed by authenticating user ",
            "Disconnected from authenticating user ",
            "Connection reset by authenticating user ",
        ] {
            if let Some(rest) = msg.strip_prefix(prefix) {
                let words: Vec<_> = rest.split_whitespace().collect();
                let at = words.iter().position(|w| *w == "port")?;
                return Some((
                    ts,
                    Auth::Failed {
                        ip: words.get(at.checked_sub(1)?)?.to_string(),
                    },
                ));
            }
        }
        return None;
    }
    if matches!(
        name,
        "useradd"
            | "userdel"
            | "usermod"
            | "groupadd"
            | "groupdel"
            | "groupmod"
            | "gpasswd"
            | "chpasswd"
            | "chage"
    ) || (name == "passwd" && msg.contains("password changed"))
    {
        return Some((
            ts,
            Auth::Account {
                text: clip(&format!("{name}: {msg}"), 160),
            },
        ));
    }
    None
}

#[derive(Debug, PartialEq)]
pub struct Access {
    pub ts: f64,
    pub code: u16,
    pub method: String,
    pub host: String,
    pub path: String,
    pub client: String,
    pub ua: String,
}
/// One NPM proxy-host access line (the format logs.rs reads for the traffic charts)
pub fn npm_line(line: &str) -> Option<Access> {
    let (stamp, rest) = line.strip_prefix('[')?.split_once("] ")?;
    let ts = crate::logs::log_time(stamp)? as f64;
    let (prefix, rest) = rest.split_once(" \"")?;
    let (path, rest) = rest.split_once("\" [Client ")?;
    let (client, rest) = rest.split_once(']')?;
    let p: Vec<_> = prefix.split_whitespace().collect();
    if p.len() != 7 || p[3] != "-" {
        return None;
    }
    let code = p[1].parse::<u16>().unwrap_or(0);
    let ua = rest
        .rsplit_once("\" \"")
        .and_then(|(left, _)| left.rsplit_once(" \""))
        .map(|(_, ua)| ua)
        .unwrap_or("");
    Some(Access {
        ts,
        code,
        method: p[4].into(),
        host: p[6].into(),
        path: path.into(),
        client: client.into(),
        ua: clip(ua, 300),
    })
}
/// A short, recognisable description of a browser: "iPhone · Safari"
pub fn device(ua: &str) -> String {
    if ua.is_empty() || ua == "-" {
        return "ไม่ทราบ".into();
    }
    if ua.contains("owner-admin-script") {
        return "สคริปต์ผู้ดูแล".into();
    }
    for tool in ["curl", "Wget", "python", "Go-http-client", "okhttp", "node"] {
        if ua.starts_with(tool) || ua.contains(&format!("{tool}/")) {
            return tool.to_lowercase();
        }
    }
    let os = [
        ("iPhone", "iPhone"),
        ("iPad", "iPad"),
        ("Android", "Android"),
        ("Macintosh", "Mac"),
        ("Windows", "Windows"),
        ("Linux", "Linux"),
    ]
    .iter()
    .find(|(k, _)| ua.contains(k))
    .map(|(_, v)| *v)
    .unwrap_or("อื่น ๆ");
    let browser = [
        ("Edg/", "Edge"),
        ("Firefox/", "Firefox"),
        ("FxiOS", "Firefox"),
        ("CriOS", "Chrome"),
        ("Chrome/", "Chrome"),
        ("Safari/", "Safari"),
    ]
    .iter()
    .find(|(k, _)| ua.contains(k))
    .map(|(_, v)| *v);
    browser.map_or(os.into(), |b| format!("{os} · {b}"))
}
/// Paths only scanners ask for (never a page of these sites)
pub fn probe_kind(path: &str) -> Option<&'static str> {
    let p = path.split('?').next().unwrap_or("").to_ascii_lowercase();
    let has = |xs: &[&str]| xs.iter().any(|x| p.contains(x));
    if has(&["../", "..%2f", "%2e%2e", "/etc/passwd", "/proc/self"]) {
        Some("traversal")
    } else if has(&[
        "/.env",
        "/.git",
        "/.aws",
        "/.ssh",
        "/.svn",
        "/.hg",
        "/.ds_store",
        "/.htpasswd",
        "/.htaccess",
        "id_rsa",
        "/.vscode",
        "/.idea",
        "/config.json.bak",
        "/docker-compose.yml",
        "/.docker",
    ]) {
        Some("secrets")
    } else if has(&["/wp-", "/wordpress", "xmlrpc.php", "/wlwmanifest"]) {
        Some("wordpress")
    } else if p.ends_with(".php")
        || has(&[
            ".php/",
            "/phpmyadmin",
            "/pma/",
            "/cgi-bin",
            "/vendor/phpunit",
            "/phpinfo",
        ])
    {
        Some("php")
    } else if has(&[
        "/manager/html",
        "/actuator",
        "/solr/",
        "/boaform",
        "/hnap1",
        "/geoserver",
        "/owa/",
        "/ecp/",
        "/remote/login",
        "/sdk",
        "/console/",
        "/jenkins",
        "/telescope",
        "/_ignition",
        "/autodiscover",
    ]) {
        Some("admin")
    } else {
        None
    }
}
/// Which admin panel a host serves, by its first label
fn panel_of(host: &str) -> Option<&'static str> {
    match host.split('.').next()? {
        "docker" => Some("dock"),
        "portainer" => Some("portainer"),
        "nginx" => Some("npm"),
        _ => None,
    }
}
pub fn panel_name(panel: &str) -> &'static str {
    match panel {
        "dock" => "Dock",
        "portainer" => "Portainer",
        "npm" => "Nginx Proxy Manager",
        _ => "SSH",
    }
}
fn is_login(panel: &str, a: &Access) -> bool {
    a.method == "POST"
        && match panel {
            "npm" => a.path == "/api/tokens",
            _ => a.path == "/api/auth",
        }
}
fn is_npm_change(a: &Access) -> bool {
    matches!(a.method.as_str(), "POST" | "PUT" | "DELETE")
        && (200..300).contains(&a.code)
        && a.path.starts_with("/api/")
        && !a.path.starts_with("/api/tokens")
        && !a.path.starts_with("/api/schema")
}

// ------------------------------------------------------------------ files
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
fn b64_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0);
    for c in s.trim_end_matches('=').bytes() {
        let v = B64.iter().position(|x| *x == c)? as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}
fn b64_encode(bytes: &[u8]) -> String {
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |a, (i, b)| a | ((*b as u32) << (16 - 8 * i)));
        for i in 0..=chunk.len() {
            out.push(B64[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    out
}
/// OpenSSH's fingerprint of an authorized_keys line: `SHA256:<base64>` plus its comment
pub fn key_fingerprint(line: &str) -> Option<String> {
    let words: Vec<_> = line.split_whitespace().collect();
    let at = words
        .iter()
        .position(|w| w.starts_with("ssh-") || w.starts_with("ecdsa-") || w.starts_with("sk-"))?;
    let blob = b64_decode(words.get(at + 1)?)?;
    let fp = format!("SHA256:{}", b64_encode(&Sha256::digest(&blob)));
    let comment = words.get(at + 2..).map(|c| c.join(" ")).unwrap_or_default();
    Some(if comment.is_empty() {
        fp
    } else {
        format!("{fp} {}", clip(&comment, 60))
    })
}

struct Watch {
    /// path under the host root
    at: &'static str,
    /// the path the owner knows it by
    shown: &'static str,
    level: Level,
    dir: bool,
}
const WATCH: &[Watch] = &[
    Watch {
        at: "etc/passwd",
        shown: "/etc/passwd",
        level: Level::Bad,
        dir: false,
    },
    Watch {
        at: "etc/shadow",
        shown: "/etc/shadow",
        level: Level::Bad,
        dir: false,
    },
    Watch {
        at: "etc/group",
        shown: "/etc/group",
        level: Level::Bad,
        dir: false,
    },
    Watch {
        at: "etc/gshadow",
        shown: "/etc/gshadow",
        level: Level::Bad,
        dir: false,
    },
    Watch {
        at: "etc/sudoers",
        shown: "/etc/sudoers",
        level: Level::Bad,
        dir: false,
    },
    Watch {
        at: "etc/sudoers.d",
        shown: "/etc/sudoers.d",
        level: Level::Bad,
        dir: true,
    },
    Watch {
        at: "root/.ssh/authorized_keys",
        shown: "/root/.ssh/authorized_keys",
        level: Level::Bad,
        dir: false,
    },
    Watch {
        at: "root/.ssh/authorized_keys2",
        shown: "/root/.ssh/authorized_keys2",
        level: Level::Bad,
        dir: false,
    },
    Watch {
        at: "root/.ssh/rc",
        shown: "/root/.ssh/rc",
        level: Level::Bad,
        dir: false,
    },
    Watch {
        at: "etc/ssh/sshrc",
        shown: "/etc/ssh/sshrc",
        level: Level::Bad,
        dir: false,
    },
    Watch {
        at: "etc/ssh/sshd_config",
        shown: "/etc/ssh/sshd_config",
        level: Level::Bad,
        dir: false,
    },
    Watch {
        at: "etc/ssh/sshd_config.d",
        shown: "/etc/ssh/sshd_config.d",
        level: Level::Bad,
        dir: true,
    },
    Watch {
        at: "etc/ld.so.preload",
        shown: "/etc/ld.so.preload",
        level: Level::Bad,
        dir: false,
    },
    Watch {
        at: "etc/pam.d/sshd",
        shown: "/etc/pam.d/sshd",
        level: Level::Bad,
        dir: false,
    },
    Watch {
        at: "etc/pam.d/common-auth",
        shown: "/etc/pam.d/common-auth",
        level: Level::Bad,
        dir: false,
    },
    Watch {
        at: "etc/crontab",
        shown: "/etc/crontab",
        level: Level::Warn,
        dir: false,
    },
    Watch {
        at: "etc/cron.d",
        shown: "/etc/cron.d",
        level: Level::Warn,
        dir: true,
    },
    Watch {
        at: "cron/crontabs",
        shown: "/var/spool/cron/crontabs",
        level: Level::Warn,
        dir: true,
    },
    Watch {
        at: "etc/systemd/system",
        shown: "/etc/systemd/system",
        level: Level::Warn,
        dir: true,
    },
    Watch {
        at: "etc/profile",
        shown: "/etc/profile",
        level: Level::Warn,
        dir: false,
    },
    Watch {
        at: "etc/profile.d",
        shown: "/etc/profile.d",
        level: Level::Warn,
        dir: true,
    },
    Watch {
        at: "etc/bash.bashrc",
        shown: "/etc/bash.bashrc",
        level: Level::Warn,
        dir: false,
    },
    Watch {
        at: "root/.bashrc",
        shown: "/root/.bashrc",
        level: Level::Warn,
        dir: false,
    },
    Watch {
        at: "root/.profile",
        shown: "/root/.profile",
        level: Level::Warn,
        dir: false,
    },
    Watch {
        at: "root/.bash_profile",
        shown: "/root/.bash_profile",
        level: Level::Warn,
        dir: false,
    },
    Watch {
        at: "root/.bash_login",
        shown: "/root/.bash_login",
        level: Level::Warn,
        dir: false,
    },
    Watch {
        at: "root/.bash_aliases",
        shown: "/root/.bash_aliases",
        level: Level::Warn,
        dir: false,
    },
    Watch {
        at: "etc/update-motd.d",
        shown: "/etc/update-motd.d",
        level: Level::Warn,
        dir: true,
    },
    Watch {
        at: "etc/environment",
        shown: "/etc/environment",
        level: Level::Warn,
        dir: false,
    },
    Watch {
        at: "etc/hosts",
        shown: "/etc/hosts",
        level: Level::Warn,
        dir: false,
    },
    Watch {
        at: "etc/docker/daemon.json",
        shown: "/etc/docker/daemon.json",
        level: Level::Warn,
        dir: false,
    },
    Watch {
        at: "etc/ufw/user.rules",
        shown: "/etc/ufw/user.rules",
        level: Level::Warn,
        dir: false,
    },
    Watch {
        at: "etc/ufw/user6.rules",
        shown: "/etc/ufw/user6.rules",
        level: Level::Warn,
        dir: false,
    },
    Watch {
        at: "etc/apt/sources.list.d",
        shown: "/etc/apt/sources.list.d",
        level: Level::Warn,
        dir: true,
    },
];
fn covers(w: &Watch, shown: &str) -> bool {
    shown == w.shown || (w.dir && shown.starts_with(&format!("{}/", w.shown)))
}
fn level_of(shown: &str) -> Level {
    WATCH
        .iter()
        .filter(|w| covers(w, shown))
        .map(|w| w.level)
        .max()
        .unwrap_or(Level::Warn)
}
/// the WATCH entry a watched path belongs to
fn watch_of(shown: &str) -> Option<&'static str> {
    WATCH.iter().find(|w| covers(w, shown)).map(|w| w.shown)
}
fn sign(path: &Path, shown: &str) -> Option<FileSig> {
    let meta = fs::symlink_metadata(path).ok()?;
    if meta.file_type().is_symlink() {
        let target = fs::read_link(path).ok()?;
        let text = format!("link:{}", target.display());
        return Some(FileSig {
            hash: hex(&Sha256::digest(text.as_bytes())),
            size: 0,
            items: vec![],
            changed: 0.,
        });
    }
    if !meta.is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    File::open(path)
        .ok()?
        .take(MAX_FILE_BYTES)
        .read_to_end(&mut bytes)
        .ok()?;
    let mut hash = Sha256::new();
    hash.update(&bytes);
    hash.update(meta.len().to_le_bytes());
    let text = String::from_utf8_lossy(&bytes);
    let items: Vec<String> = if shown.ends_with("/passwd") || shown.ends_with("/group") {
        text.lines()
            .filter_map(|l| l.split(':').next())
            .filter(|n| !n.is_empty() && !n.starts_with('#'))
            .map(str::to_string)
            .collect()
    } else if shown.contains("authorized_keys") {
        text.lines()
            .filter(|l| !l.trim_start().starts_with('#'))
            .filter_map(key_fingerprint)
            .collect()
    } else {
        vec![]
    };
    Some(FileSig {
        hash: hex(&hash.finalize()),
        size: meta.len(),
        items,
        changed: 0.,
    })
}
fn scan_files(host: &Path) -> BTreeMap<String, FileSig> {
    let mut out = BTreeMap::new();
    for w in WATCH {
        let path = host.join(w.at);
        if w.dir {
            let Ok(entries) = fs::read_dir(&path) else {
                continue;
            };
            let mut names: Vec<_> = entries
                .flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect();
            names.sort();
            for name in names.into_iter().take(300) {
                let shown = format!("{}/{name}", w.shown);
                if let Some(sig) = sign(&path.join(&name), &shown) {
                    out.insert(shown, sig);
                }
            }
        } else if let Some(sig) = sign(&path, w.shown) {
            out.insert(w.shown.to_string(), sig);
        }
    }
    out
}

// ------------------------------------------------------------------ host facts
/// Public TCP listeners of the host network namespace (pid 1), e.g. "tcp/22"
pub fn listening(proc: &Path) -> Vec<String> {
    let mut out = BTreeSet::new();
    for (file, v6) in [("1/net/tcp", false), ("1/net/tcp6", true)] {
        for line in crate::host::read(proc.join(file)).lines().skip(1) {
            let f: Vec<_> = line.split_whitespace().collect();
            if f.len() < 4 || f[3] != "0A" {
                continue;
            }
            let Some((addr, port)) = f[1].split_once(':') else {
                continue;
            };
            let Ok(port) = u16::from_str_radix(port, 16) else {
                continue;
            };
            let loopback = if v6 {
                // four little-endian 32-bit words
                let words: Vec<u32> = (0..4)
                    .filter_map(|i| {
                        addr.get(i * 8..i * 8 + 8)
                            .and_then(|w| u32::from_str_radix(w, 16).ok())
                    })
                    .map(u32::from_be)
                    .collect();
                if words.len() != 4 {
                    continue;
                }
                let ip = Ipv6Addr::from(
                    ((words[0] as u128) << 96)
                        | ((words[1] as u128) << 64)
                        | ((words[2] as u128) << 32)
                        | words[3] as u128,
                );
                ip.is_loopback() || ip.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback())
            } else {
                let Ok(n) = u32::from_str_radix(addr, 16) else {
                    continue;
                };
                Ipv4Addr::from(u32::from_be(n)).is_loopback()
            };
            if !loopback {
                out.insert(format!("tcp/{port}"));
            }
        }
    }
    out.into_iter().collect()
}
fn risky_flags(config: &Value, hostconfig: &Value) -> Vec<String> {
    let mut out = Vec::new();
    if hostconfig["Privileged"] == true {
        out.push("privileged".into());
    }
    for (key, flag) in [
        ("PidMode", "host-pid"),
        ("NetworkMode", "host-network"),
        ("IpcMode", "host-ipc"),
    ] {
        if hostconfig[key] == "host" {
            out.push(flag.into());
        }
    }
    if let Some(points) = config["MountPoints"].as_object() {
        for p in points.values() {
            let source = p["Source"].as_str().unwrap_or("");
            if source.ends_with("docker.sock") {
                out.push("docker-socket".into());
            } else if source == "/" {
                out.push("host-root".into());
            }
        }
    }
    for cap in hostconfig["CapAdd"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        out.push(format!("cap-add:{cap}"));
    }
    if hostconfig["SecurityOpt"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .any(|s| s.contains("unconfined"))
    {
        out.push("unconfined".into());
    }
    out.sort();
    out.dedup();
    out
}
fn read_json(path: &Path) -> Value {
    let mut bytes = Vec::new();
    match File::open(path).and_then(|f| f.take(MAX_FILE_BYTES).read_to_end(&mut bytes)) {
        Ok(_) => serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        Err(_) => Value::Null,
    }
}
fn containers(dir: &Path) -> Vec<Ctr> {
    let Ok(entries) = fs::read_dir(dir) else {
        return vec![];
    };
    let mut out: Vec<Ctr> = entries
        .flatten()
        .take(500)
        .filter_map(|e| {
            let config = read_json(&e.path().join("config.v2.json"));
            let name = config["Name"].as_str()?.trim_start_matches('/').to_string();
            let hostconfig = read_json(&e.path().join("hostconfig.json"));
            let labels = &config["Config"]["Labels"];
            let project = labels["com.docker.compose.project"].as_str();
            let service = labels["com.docker.compose.service"].as_str();
            let ident = match (project, service) {
                (Some(p), Some(s)) => format!("{p}/{s}"),
                _ => name
                    .trim_end_matches(|c: char| c.is_ascii_digit())
                    .trim_end_matches('-')
                    .to_string(),
            };
            let image = config["Config"]["Image"].as_str().unwrap_or("").to_string();
            let risky = risky_flags(&config, &hostconfig);
            // the nightly scanner's throwaway Trivy runs (deploy/hardening/dock-image-scan.py); only
            // unprivileged ones with its label and image are skipped, so the label alone hides nothing
            if labels["dock.image-scan"] == "true"
                && image.starts_with("aquasec/trivy:")
                && risky.is_empty()
            {
                return None;
            }
            Some(Ctr {
                ident: if ident.is_empty() {
                    name.clone()
                } else {
                    ident
                },
                image,
                compose: project.is_some(),
                running: config["State"]["Running"] == true,
                risky,
                name,
            })
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}
fn version_key(v: &str) -> Vec<u64> {
    v.split(|c: char| !c.is_ascii_digit())
        .filter(|s| !s.is_empty())
        .filter_map(|s| s.parse().ok())
        .collect()
}
fn updates(host: &Path, proc: &Path, now: f64) -> Updates {
    let text = crate::host::read(host.join("apt/updates-available"));
    let count = |needle: &str| {
        text.lines()
            .find(|l| l.contains(needle))
            .and_then(|l| l.split_whitespace().next())
            .and_then(|n| n.parse::<u32>().ok())
    };
    let pending = count("can be applied immediately")
        .or_else(|| count("updates can be installed immediately"));
    let pending = pending.or(if text.trim().is_empty() {
        None
    } else {
        Some(0)
    });
    let kernel = crate::host::read(proc.join("sys/kernel/osrelease"))
        .trim()
        .to_string();
    let newest = fs::read_dir(host.join("boot"))
        .map(|e| {
            e.flatten()
                .filter_map(|e| {
                    e.file_name()
                        .to_string_lossy()
                        .strip_prefix("vmlinuz-")
                        .map(str::to_string)
                })
                .max_by_key(|v| version_key(v))
                .unwrap_or_default()
        })
        .unwrap_or_default();
    Updates {
        pending,
        security: count("security update").or(pending.map(|_| 0)),
        reboot: !newest.is_empty() && !kernel.is_empty() && newest != kernel,
        kernel,
        newest,
        checked: now,
    }
}

// ------------------------------------------------------------------ tailing
/// Calls `f` with each complete new line of `path` after `pos`, then advances `pos`.
fn tail(
    path: &Path,
    pos: &mut Option<[u64; 2]>,
    from_start: bool,
    mut f: impl FnMut(&str),
) -> std::io::Result<()> {
    let Ok(mut file) = File::open(path) else {
        return Ok(());
    };
    let st = file.metadata()?;
    let [inode, mut offset] = pos.unwrap_or([st.ino(), if from_start { 0 } else { st.len() }]);
    if inode != st.ino() || st.len() < offset {
        offset = 0;
    }
    file.seek(SeekFrom::Start(offset))?;
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
                f(&String::from_utf8_lossy(raw));
            }
            consumed += (last + 1) as u64;
            pending.drain(..=last);
        }
        if pending.len() > 1024 * 1024 {
            return Err(std::io::Error::other("oversized log line"));
        }
    }
    *pos = Some([st.ino(), offset + consumed]);
    Ok(())
}

// ------------------------------------------------------------------ the watch
impl Security {
    pub fn load(roots: Roots, now: f64) -> Self {
        let saved = fs::read(roots.data.join("security.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<State>(&b).ok());
        let seeding = saved.is_none();
        let mut st = saved.unwrap_or_default();
        if seeding {
            st.started = now;
        }
        Self {
            roots,
            st,
            live: Live::default(),
            seeding,
            dirty: seeding,
            last_slow: 0.,
            last_save: now,
        }
    }
    fn event(
        &mut self,
        ts: f64,
        cat: &str,
        level: Level,
        title: String,
        detail: String,
        alert: bool,
    ) {
        self.st.next_id += 1;
        self.st.events.push_back(Event {
            id: self.st.next_id,
            ts,
            cat: cat.into(),
            level,
            title: clip(&title, 120),
            detail: clip(&detail, 400),
            alert,
        });
        while self.st.events.len() > MAX_EVENTS {
            self.st.events.pop_front();
        }
        self.dirty = true;
    }
    fn login(&mut self, l: Login) {
        self.st.logins.push_back(l);
        while self.st.logins.len() > MAX_LOGINS {
            self.st.logins.pop_front();
        }
    }
    fn on_auth(&mut self, ts: f64, a: Auth, now: f64) {
        let fresh = ts >= now - KEEP_DAYS as f64 * DAY as f64;
        match a {
            Auth::Accepted {
                user,
                ip,
                method,
                key,
            } => {
                let (net, origin) = net_of(&ip).unwrap_or_else(|| (ip.clone(), Origin::Public));
                let new_net = origin == Origin::Public && !self.st.ssh_nets.contains_key(&net);
                let new_key = key
                    .as_ref()
                    .is_some_and(|k| !self.st.ssh_keys.contains_key(k));
                if origin == Origin::Public {
                    self.st.ssh_nets.entry(net.clone()).or_insert(ts);
                }
                if let Some(k) = &key {
                    self.st.ssh_keys.entry(k.clone()).or_insert(ts);
                }
                let how = key.clone().unwrap_or_else(|| method.clone());
                if !self.seeding {
                    let shown_key = key
                        .as_deref()
                        .map(|k| format!(" ด้วยคีย์ {}", clip(k, 20)))
                        .unwrap_or_default();
                    let detail = format!("{user} จาก {ip} ({net}){shown_key}");
                    if method != "publickey" {
                        self.event(
                            ts,
                            "ssh",
                            Level::Bad,
                            format!("SSH: ล็อกอินด้วย {method}"),
                            format!("{detail} ทั้งที่ควรเข้าได้ด้วยคีย์เท่านั้น"),
                            true,
                        );
                    } else if new_key {
                        self.event(
                            ts,
                            "ssh",
                            Level::Bad,
                            "SSH: ล็อกอินด้วยคีย์ที่ไม่เคยเห็น".into(),
                            detail,
                            true,
                        );
                    } else if new_net {
                        self.event(
                            ts,
                            "ssh",
                            Level::Warn,
                            "SSH: ล็อกอินจากเครือข่ายใหม่".into(),
                            detail,
                            true,
                        );
                    }
                }
                if fresh {
                    self.login(Login {
                        ts,
                        via: "ssh".into(),
                        user,
                        ip,
                        net,
                        how,
                        new: !self.seeding && (new_net || new_key),
                    });
                }
            }
            Auth::Failed { ip } => {
                if fresh {
                    let h = hour(ts);
                    *self.st.failed.entry(h).or_default() += 1;
                    let ips = self.st.failed_ips.entry(h).or_default();
                    if ips.len() < 400 || ips.contains_key(&ip) {
                        *ips.entry(ip).or_default() += 1;
                    }
                }
            }
            Auth::Account { text } => {
                if !self.seeding {
                    self.event(
                        ts,
                        "ssh",
                        Level::Bad,
                        "บัญชีผู้ใช้ในเครื่องถูกแก้".into(),
                        text,
                        true,
                    );
                }
            }
        }
    }
    fn on_access(&mut self, a: Access, now: f64) {
        if a.ts < now - KEEP_DAYS as f64 * DAY as f64 {
            return;
        }
        if let Some(kind) = probe_kind(&a.path) {
            let day = self.st.web.entry(bkk_day(a.ts)).or_default();
            day.probes += 1;
            *day.kinds.entry(kind.into()).or_default() += 1;
            if a.ts >= now - 7. * DAY as f64 {
                let key = format!(
                    "{} {}",
                    a.host,
                    clip(a.path.split('?').next().unwrap_or(""), 80)
                );
                if self.st.probe_paths.len() < 2000 || self.st.probe_paths.contains_key(&key) {
                    let e = self.st.probe_paths.entry(key).or_insert((0, a.ts));
                    e.0 += 1;
                    e.1 = e.1.max(a.ts);
                }
            }
        }
        if a.code == 415 {
            self.st.web.entry(bkk_day(a.ts)).or_default().guard += 1;
        }
        let Some(panel) = panel_of(&a.host) else {
            return;
        };
        if is_login(panel, &a) {
            if (200..300).contains(&a.code) {
                let (net, origin) =
                    net_of(&a.client).unwrap_or_else(|| (a.client.clone(), Origin::Public));
                let nets = self.st.panel_nets.entry(panel.into()).or_default();
                let new = origin == Origin::Public && !nets.contains_key(&net);
                if origin == Origin::Public {
                    nets.entry(net.clone()).or_insert(a.ts);
                }
                let how = device(&a.ua);
                if new && !self.seeding {
                    self.event(
                        a.ts,
                        "panel",
                        Level::Warn,
                        format!("{}: ล็อกอินจากเครือข่ายใหม่", panel_name(panel)),
                        format!("{} ({net}) · {how}", a.client),
                        true,
                    );
                }
                self.login(Login {
                    ts: a.ts,
                    via: panel.into(),
                    user: String::new(),
                    ip: a.client,
                    net,
                    how,
                    new: new && !self.seeding,
                });
            } else if matches!(a.code, 400 | 401 | 403) {
                let h = hour(a.ts);
                let n = {
                    let c = self
                        .st
                        .panel_failed
                        .entry(h)
                        .or_default()
                        .entry(panel.into())
                        .or_default();
                    *c += 1;
                    *c
                };
                if n == 10 && !self.seeding {
                    self.event(
                        a.ts,
                        "panel",
                        Level::Warn,
                        format!("{}: รหัสผ่านผิด 10 ครั้งในชั่วโมงเดียว", panel_name(panel)),
                        format!("ล่าสุดจาก {}", a.client),
                        true,
                    );
                }
            }
        } else if panel == "npm" && is_npm_change(&a) && !self.seeding {
            self.event(
                a.ts,
                "panel",
                Level::Warn,
                "Nginx Proxy Manager: มีการแก้ค่า".into(),
                format!(
                    "{} {} · จาก {} · {}",
                    a.method,
                    clip(&a.path, 80),
                    a.client,
                    device(&a.ua)
                ),
                true,
            );
        }
    }
    fn read_logs(&mut self, now: f64) {
        // auth.log, finishing the rotated file first when logrotate moved it since the last pass
        let log = self.roots.host.join("log");
        let mut pos = self.st.auth_pos;
        let mut lines = Vec::new();
        let current = fs::metadata(log.join("auth.log")).map(|m| m.ino()).ok();
        if self.seeding {
            let mut old = None;
            let _ = tail(&log.join("auth.log.1"), &mut old, true, |l| {
                lines.extend(auth_line(l))
            });
        } else if let (Some([ino, _]), Some(cur)) = (pos, current)
            && ino != cur
            && fs::metadata(log.join("auth.log.1")).map(|m| m.ino()).ok() == Some(ino)
        {
            let mut old = pos;
            let _ = tail(&log.join("auth.log.1"), &mut old, false, |l| {
                lines.extend(auth_line(l))
            });
            pos = None;
        }
        let from_start = self.seeding || pos.is_none();
        if let Err(e) = tail(&log.join("auth.log"), &mut pos, from_start, |l| {
            lines.extend(auth_line(l))
        }) {
            eprintln!("security: auth.log: {e}");
        }
        if pos != self.st.auth_pos {
            self.st.auth_pos = pos;
            self.dirty = true;
        }
        for (ts, a) in lines {
            self.on_auth(ts, a, now);
        }

        // NPM access logs (not the fallback: it has no host field)
        let Ok(entries) = fs::read_dir(&self.roots.npm) else {
            return;
        };
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
            let mut accesses = Vec::new();
            if let Err(e) = tail(&self.roots.npm.join(&name), &mut pos, self.seeding, |l| {
                accesses.extend(npm_line(l))
            }) {
                eprintln!("security: {name}: {e}");
            }
            if let Some(p) = pos
                && self.st.npm_pos.insert(name, p) != Some(p)
            {
                self.dirty = true;
            }
            for a in accesses {
                self.on_access(a, now);
            }
        }
    }
    fn check_files(&mut self, now: f64) {
        let current = scan_files(&self.roots.host);
        let old = std::mem::take(&mut self.st.files);
        // entries watched before (state from older versions has no `watched` yet: any file of theirs counts)
        let learned: BTreeSet<&str> = WATCH
            .iter()
            .map(|w| w.shown)
            .filter(|r| self.st.watched.contains(*r) || old.keys().any(|p| watch_of(p) == Some(*r)))
            .collect();
        let mut next = BTreeMap::new();
        let mut events = Vec::new();
        for (path, mut sig) in current {
            match old.get(&path) {
                Some(prev) if prev.hash == sig.hash => sig.changed = prev.changed,
                Some(prev) => {
                    sig.changed = now;
                    let added: Vec<_> = sig
                        .items
                        .iter()
                        .filter(|x| !prev.items.contains(x))
                        .cloned()
                        .collect();
                    let removed: Vec<_> = prev
                        .items
                        .iter()
                        .filter(|x| !sig.items.contains(x))
                        .cloned()
                        .collect();
                    let mut detail = Vec::new();
                    if !added.is_empty() {
                        detail.push(format!("เพิ่ม {}", added.join(", ")));
                    }
                    if !removed.is_empty() {
                        detail.push(format!("ลบ {}", removed.join(", ")));
                    }
                    if detail.is_empty() {
                        detail.push(format!("ขนาด {} → {} ไบต์", prev.size, sig.size));
                    }
                    events.push((
                        level_of(&path),
                        format!("ไฟล์สำคัญถูกแก้: {path}"),
                        detail.join(" · "),
                    ));
                }
                None if !self.seeding && watch_of(&path).is_some_and(|r| learned.contains(r)) => {
                    sig.changed = now;
                    events.push((
                        level_of(&path),
                        format!("มีไฟล์ใหม่: {path}"),
                        format!("{} ไบต์", sig.size),
                    ));
                }
                None => {}
            }
            next.insert(path, sig);
        }
        if !self.seeding && !old.is_empty() {
            for path in old.keys().filter(|p| !next.contains_key(*p)) {
                events.push((level_of(path), format!("ไฟล์ถูกลบ: {path}"), String::new()));
            }
        }
        let watched: BTreeSet<String> = WATCH.iter().map(|w| w.shown.to_string()).collect();
        if next != old || watched != self.st.watched {
            self.dirty = true;
        }
        self.st.watched = watched;
        self.st.files = next;
        self.st.files_checked = now;
        for (level, title, detail) in events {
            self.event(now, "files", level, title, detail, true);
        }
    }
    fn check_host(&mut self, now: f64) {
        let ports = listening(&self.roots.proc);
        if !ports.is_empty() {
            if !self.seeding && !self.st.ports.is_empty() {
                for p in ports
                    .iter()
                    .filter(|p| !self.st.ports.contains(*p))
                    .cloned()
                    .collect::<Vec<_>>()
                {
                    self.event(
                        now,
                        "host",
                        Level::Bad,
                        format!("พอร์ตใหม่เปิดรับจากภายนอก: {}", p.replace("tcp/", "TCP ")),
                        "ถ้าไม่ได้ตั้งใจเปิด ให้ตรวจว่าโปรแกรมไหนฟังพอร์ตนี้".into(),
                        true,
                    );
                }
                for p in self
                    .st
                    .ports
                    .iter()
                    .filter(|p| !ports.contains(*p))
                    .cloned()
                    .collect::<Vec<_>>()
                {
                    self.event(
                        now,
                        "host",
                        Level::Info,
                        format!("ปิดพอร์ต {}", p.replace("tcp/", "TCP ")),
                        String::new(),
                        false,
                    );
                }
            }
            let set: BTreeSet<_> = ports.iter().cloned().collect();
            if set != self.st.ports {
                self.st.ports = set;
                self.dirty = true;
            }
        }
        self.live.ports = ports;

        let list = containers(&self.roots.host.join("containers"));
        let baseline = self.seeding || self.st.containers.is_empty();
        for c in &list {
            let seen = self.st.containers.get(&c.ident).cloned();
            match &seen {
                None if !baseline => {
                    let level = if c.risky.is_empty() {
                        Level::Warn
                    } else {
                        Level::Bad
                    };
                    let flags = if c.risky.is_empty() {
                        String::new()
                    } else {
                        format!(" · สิทธิ์พิเศษ: {}", c.risky.join(", "))
                    };
                    let from = if c.compose {
                        "จาก compose"
                    } else {
                        "ไม่ได้มาจาก compose"
                    };
                    self.event(
                        now,
                        "host",
                        level,
                        format!("คอนเทนเนอร์ใหม่: {}", c.name),
                        format!("{} · {from}{flags}", c.image),
                        c.compose || !c.risky.is_empty(),
                    );
                }
                Some(s) if !baseline => {
                    let extra: Vec<_> = c
                        .risky
                        .iter()
                        .filter(|f| !s.risky.contains(f))
                        .cloned()
                        .collect();
                    if !extra.is_empty() {
                        self.event(
                            now,
                            "host",
                            Level::Bad,
                            format!("คอนเทนเนอร์ได้สิทธิ์เพิ่ม: {}", c.name),
                            format!("{} · {}", c.image, extra.join(", ")),
                            true,
                        );
                    }
                }
                _ => {}
            }
            if seen
                .as_ref()
                .is_none_or(|s| s.image != c.image || s.risky != c.risky)
            {
                self.dirty = true;
            }
            let first = seen.as_ref().map_or(now, |s| s.first);
            self.st.containers.insert(
                c.ident.clone(),
                Seen {
                    image: c.image.clone(),
                    risky: c.risky.clone(),
                    first,
                    last: now,
                },
            );
        }
        let before = self.st.containers.len();
        self.st
            .containers
            .retain(|_, s| s.last >= now - 30. * DAY as f64);
        self.dirty |= self.st.containers.len() != before;
        self.live.containers = list;
        self.live.checked = now;
    }
    /// The nightly scanner's summary: re-read when it changes; a new scan raises one event for new
    /// fixable CRITICAL/HIGH findings (keyed by image name, so rebuilding an image does not repeat them).
    fn check_scan(&mut self, now: f64) {
        let path = self.roots.host.join("scan/images.json");
        let Ok(meta) = fs::metadata(&path) else {
            self.live.scan = Value::Null;
            self.live.scan_stamp = None;
            return;
        };
        let stamp = (meta.len(), meta.mtime(), meta.mtime_nsec());
        if self.live.scan_stamp == Some(stamp) {
            return;
        }
        if meta.len() > MAX_SCAN_BYTES {
            eprintln!("security: images.json is {} bytes, ignored", meta.len());
            return;
        }
        let Some(doc) = fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .filter(|d| d["images"].is_array())
        else {
            return;
        };
        self.live.scan_stamp = Some(stamp);
        let scanned = doc["scanned"].as_f64().unwrap_or(0.);
        if scanned > self.st.scan_seen {
            self.on_scan(&doc, now);
            self.st.scan_seen = scanned;
            self.dirty = true;
        }
        self.live.scan = doc;
    }
    fn on_scan(&mut self, doc: &Value, now: f64) {
        let mut keys = BTreeSet::new();
        for i in doc["images"].as_array().into_iter().flatten() {
            let name = i["image"].as_str().unwrap_or("");
            if i["error"].is_string() {
                // a failed scan keeps what was known, so the next good one does not report it again
                let prefix = format!("{name}|");
                keys.extend(
                    self.st
                        .image_vulns
                        .iter()
                        .filter(|k| k.starts_with(&prefix))
                        .cloned(),
                );
                continue;
            }
            for k in i["fixableKeys"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                keys.insert(format!("{name}|{k}"));
            }
        }
        let first = self.st.scan_seen == 0.;
        let new: Vec<_> = keys
            .iter()
            .filter(|k| !self.st.image_vulns.contains(*k))
            .filter_map(|k| {
                let mut f = k.splitn(4, '|');
                Some((f.next()?, f.next()?, f.next()?, f.next()?))
            })
            .collect();
        let critical = new.iter().filter(|v| v.1 == "CRITICAL").count();
        let level = if critical > 0 {
            Level::Bad
        } else if new.is_empty() {
            Level::Info
        } else {
            Level::Warn
        };
        let mut by_image: BTreeMap<&str, Vec<String>> = BTreeMap::new();
        for (image, _, id, pkg) in &new {
            by_image
                .entry(image)
                .or_default()
                .push(format!("{id} ({pkg})"));
        }
        let detail = by_image
            .iter()
            .map(|(image, v)| {
                let more = if v.len() > 3 {
                    format!(" และอีก {}", v.len() - 3)
                } else {
                    String::new()
                };
                format!("{image}: {}{more}", v[..v.len().min(3)].join(", "))
            })
            .collect::<Vec<_>>()
            .join(" · ");
        if self.seeding {
            // a re-learn: the current findings are the baseline
        } else if first {
            let title = if new.is_empty() {
                "สแกนช่องโหว่ใน image ครั้งแรก: ไม่พบรายการที่แก้ได้".to_string()
            } else {
                format!(
                    "สแกนช่องโหว่ใน image ครั้งแรก: แก้ได้ {} รายการ (วิกฤต {critical}) ใน {} image",
                    new.len(),
                    by_image.len()
                )
            };
            self.event(now, "images", level, title, detail, true);
        } else if !new.is_empty() {
            self.event(
                now,
                "images",
                level,
                format!(
                    "ช่องโหว่ใหม่ที่มีแพตช์: {} รายการ (วิกฤต {critical}) ใน {} image",
                    new.len(),
                    by_image.len()
                ),
                detail,
                true,
            );
        }
        self.st.image_vulns = keys;
    }
    fn prune(&mut self, now: f64) {
        let keep = (now as i64) - KEEP_DAYS * DAY;
        self.st.failed.retain(|h, _| *h >= keep);
        self.st
            .failed_ips
            .retain(|h, _| (*h as f64) >= now - DAY as f64);
        self.st
            .panel_failed
            .retain(|h, _| (*h as f64) >= now - DAY as f64);
        self.st.web.retain(|d, _| *d >= keep);
        self.st
            .probe_paths
            .retain(|_, (_, last)| *last >= now - 7. * DAY as f64);
    }
    /// One pass: new log lines every call; files, ports and containers every minute; updates every ten.
    pub fn tick(&mut self, now: f64) {
        self.read_logs(now);
        if self.seeding || now - self.last_slow >= SLOW_EVERY {
            self.check_files(now);
            self.check_host(now);
            self.check_scan(now);
            if self.seeding || now - self.live.updates.checked >= UPDATES_EVERY {
                self.live.updates = updates(&self.roots.host, &self.roots.proc, now);
            }
            self.prune(now);
            self.last_slow = now;
        }
        if self.seeding {
            self.seeding = false;
            self.event(
                now,
                "host",
                Level::Info,
                "เริ่มเฝ้าระวังความปลอดภัย".into(),
                "สิ่งที่มีอยู่ตอนนี้ถือเป็นค่าปกติ จะแจ้งเมื่อมีอะไรเปลี่ยน".into(),
                false,
            );
        }
        if self.dirty && now - self.last_save >= 60. {
            if let Err(e) = self.save() {
                eprintln!("security save error: {e}");
            }
            self.last_save = now;
        }
    }
    pub fn save(&mut self) -> std::io::Result<()> {
        fs::create_dir_all(&self.roots.data)?;
        let tmp = self.roots.data.join("security.json.tmp");
        let mut file = File::create(&tmp)?;
        file.write_all(&serde_json::to_vec(&self.st)?)?;
        file.sync_all()?;
        fs::rename(tmp, self.roots.data.join("security.json"))?;
        self.dirty = false;
        Ok(())
    }
    pub fn ack(&mut self, now: f64) {
        self.st.acked = now;
        self.dirty = true;
        self.last_save = 0.;
    }
    /// Alert events after `after`, oldest first, for apps-chat to post
    pub fn outbox(&self, after: u64) -> Value {
        let events: Vec<_> = self
            .st
            .events
            .iter()
            .filter(|e| e.alert && e.id > after)
            .take(20)
            .collect();
        json!({ "last": self.st.next_id, "events": events })
    }
    fn status(&self, cat: &str, now: f64) -> Level {
        let since = self.st.acked.max(now - EVENT_WINDOW);
        let from_events = self
            .st
            .events
            .iter()
            .filter(|e| e.cat == cat && e.ts > since)
            .map(|e| e.level)
            .max()
            .unwrap_or(Level::Info);
        let live = match cat {
            "host" if self.live.updates.reboot || self.live.updates.security.unwrap_or(0) > 0 => {
                Level::Warn
            }
            "images"
                if self.live.scan["scanned"]
                    .as_f64()
                    .is_some_and(|t| now - t > SCAN_STALE) =>
            {
                Level::Warn
            }
            _ => Level::Info,
        };
        from_events.max(live)
    }
    pub fn payload(&self, now: f64) -> Value {
        let cats = ["ssh", "panel", "files", "web", "host", "images"];
        let status: BTreeMap<_, _> = cats.iter().map(|c| (*c, self.status(c, now))).collect();
        let overall = status.values().max().copied().unwrap_or(Level::Info);
        let day_ago = now - DAY as f64;
        let today = bkk_day(now);

        let mut top: BTreeMap<&str, u32> = BTreeMap::new();
        for ips in self
            .st
            .failed_ips
            .iter()
            .filter(|(h, _)| (**h as f64) > day_ago - 3600.)
            .map(|(_, v)| v)
        {
            for (ip, n) in ips {
                *top.entry(ip).or_default() += n;
            }
        }
        let mut top: Vec<_> = top.into_iter().collect();
        top.sort_by(|a, b| b.1.cmp(&a.1));
        let failed_days: Vec<_> = (0..KEEP_DAYS)
            .rev()
            .map(|i| {
                let d = today - i * DAY;
                let n: u32 = self.st.failed.range(d..d + DAY).map(|(_, n)| n).sum();
                json!({ "day": d, "count": n })
            })
            .collect();
        let failed24: u32 = self
            .st
            .failed
            .iter()
            .filter(|(h, _)| (**h as f64) > day_ago - 3600.)
            .map(|(_, n)| n)
            .sum();
        let logins = |via: &dyn Fn(&str) -> bool| -> Vec<&Login> {
            self.st
                .logins
                .iter()
                .rev()
                .filter(|l| via(&l.via))
                .take(20)
                .collect()
        };
        let panel_failed24: u32 = self.st.panel_failed.values().flat_map(|m| m.values()).sum();
        let mut probes: Vec<_> = self.st.probe_paths.iter().collect();
        probes.sort_by(|a, b| b.1.0.cmp(&a.1.0));
        let web_days: Vec<_> = (0..KEEP_DAYS)
            .rev()
            .map(|i| {
                let d = today - i * DAY;
                let w = self.st.web.get(&d).cloned().unwrap_or_default();
                json!({ "day": d, "probes": w.probes, "guard": w.guard, "kinds": w.kinds })
            })
            .collect();
        let files: Vec<_> = self
            .st
            .files
            .iter()
            .map(|(path, s)| json!({ "path": path, "level": level_of(path), "changed": if s.changed > 0. { json!(s.changed) } else { Value::Null } }))
            .collect();
        let changed_files = self
            .st
            .files
            .values()
            .filter(|s| s.changed > self.st.acked.max(now - EVENT_WINDOW))
            .count();
        let risky: Vec<_> = self
            .live
            .containers
            .iter()
            .filter(|c| !c.risky.is_empty())
            .collect();
        let unmanaged: Vec<_> = self
            .live
            .containers
            .iter()
            .filter(|c| !c.compose)
            .map(|c| json!({ "name": c.name, "image": c.image, "running": c.running }))
            .collect();
        json!({
            "enabled": true,
            "now": now,
            "since": self.st.started,
            "acked": self.st.acked,
            "status": overall,
            "cats": {
                "ssh": {
                    "status": status["ssh"],
                    "logins": logins(&|v| v == "ssh"),
                    "failed24": failed24,
                    "failedDays": failed_days,
                    "topIps": top.iter().take(8).map(|(ip, n)| json!({ "ip": ip, "count": n })).collect::<Vec<_>>(),
                    "keys": self.st.ssh_keys.iter().map(|(k, t)| json!({ "key": k, "first": t })).collect::<Vec<_>>(),
                    "networks": self.st.ssh_nets.len(),
                },
                "panel": {
                    "status": status["panel"],
                    "logins": logins(&|v| v != "ssh"),
                    "failed24": panel_failed24,
                    "networks": self.st.panel_nets.iter().map(|(p, n)| (p.clone(), n.len())).collect::<BTreeMap<_, _>>(),
                },
                "files": {
                    "status": status["files"],
                    "watched": self.st.files.len(),
                    "changed": changed_files,
                    "checked": self.st.files_checked,
                    "list": files,
                },
                "web": {
                    "status": status["web"],
                    "today": self.st.web.get(&today).map_or(0, |w| w.probes),
                    "days": web_days,
                    "topPaths": probes.iter().take(12).map(|(k, (n, last))| {
                        let (host, path) = k.split_once(' ').unwrap_or(("", k));
                        json!({ "host": host, "path": path, "count": n, "last": last })
                    }).collect::<Vec<_>>(),
                },
                "host": {
                    "status": status["host"],
                    "ports": self.live.ports,
                    "containers": self.live.containers.len(),
                    "running": self.live.containers.iter().filter(|c| c.running).count(),
                    "risky": risky.iter().map(|c| json!({ "name": c.name, "image": c.image, "flags": c.risky, "running": c.running })).collect::<Vec<_>>(),
                    "unmanaged": unmanaged,
                    "updates": self.live.updates,
                    "checked": self.live.checked,
                },
                "images": {
                    "status": status["images"],
                    "scanned": self.live.scan["scanned"],
                    "trivy": self.live.scan["trivy"],
                    "dbError": self.live.scan["dbError"],
                    "images": self.live.scan["images"].as_array().map(|a| a.iter().map(|i| {
                        let mut i = i.clone();
                        if let Some(o) = i.as_object_mut() {
                            o.remove("fixableKeys");
                        }
                        i
                    }).collect::<Vec<_>>()).unwrap_or_default(),
                },
            },
            "events": self.st.events.iter().rev().take(60).collect::<Vec<_>>(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Temp(PathBuf);
    impl Temp {
        fn new(name: &str) -> Self {
            let p = std::env::temp_dir().join(format!("sec-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&p);
            fs::create_dir_all(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn roots(t: &Temp) -> Roots {
        for d in [
            "host/log",
            "host/etc/ssh",
            "host/root/.ssh",
            "host/scan",
            "host/containers",
            "host/apt",
            "host/boot",
            "proc/1/net",
            "proc/sys/kernel",
            "npm",
            "data",
        ] {
            fs::create_dir_all(t.0.join(d)).unwrap();
        }
        Roots {
            host: t.0.join("host"),
            proc: t.0.join("proc"),
            npm: t.0.join("npm"),
            data: t.0.join("data"),
        }
    }
    /// a throwaway public key (its private half was deleted); `ssh-keygen -lf` printed the fingerprint below
    const KEY: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINeAvnOHjgFjE8zQu0QNyRMD/H+hiQ1ZuzWmthii1la+ owner@mac";
    fn ssh(ts: &str, ip: &str, fp: &str) -> String {
        format!(
            "{ts} ubuntu sshd[1]: Accepted publickey for root from {ip} port 5 ssh2: ED25519 {fp}\n"
        )
    }

    #[test]
    fn rfc3339_times() {
        assert_eq!(iso_time("2026-10-24T23:16:34+07:00"), Some(1_792_858_594.));
        assert_eq!(iso_time("2026-10-24T16:16:34.5Z"), Some(1_792_858_594.5));
        for s in [
            "2026-13-01T00:00:00Z",
            "garbage",
            "2026-10-24 23:16:34+07:00",
            "2026-10-24T23:16:34+0700",
        ] {
            assert_eq!(iso_time(s), None, "{s}");
        }
        assert_eq!(bkk_day(1_792_858_594.), 1_792_774_800);
    }

    #[test]
    fn networks_group_and_recognise_cloudflare() {
        assert_eq!(
            net_of("49.229.180.248"),
            Some(("49.229.180.0/24".into(), Origin::Public))
        );
        assert_eq!(
            net_of("2001:fb1:c7:6b8b:90b0:8f66:5a03:bd83"),
            Some(("2001:fb1:c7:6b8b::/64".into(), Origin::Public))
        );
        assert_eq!(net_of("172.68.241.2").unwrap().1, Origin::Cloudflare);
        assert_eq!(net_of("2606:4700::1").unwrap().1, Origin::Cloudflare);
        assert_eq!(net_of("172.18.0.4").unwrap().1, Origin::Private);
        assert_eq!(net_of("::ffff:10.0.0.1").unwrap().1, Origin::Private);
        assert_eq!(net_of("not an ip"), None);
    }

    #[test]
    fn auth_lines() {
        let l = "2026-10-24T23:16:34.498650+07:00 ubuntu sshd[2871345]: Accepted publickey for root from 58.8.180.204 port 58990 ssh2: ED25519 SHA256:ilV4vnG59Yb85QJf";
        assert_eq!(
            auth_line(l).unwrap().1,
            Auth::Accepted {
                user: "root".into(),
                ip: "58.8.180.204".into(),
                method: "publickey".into(),
                key: Some("SHA256:ilV4vnG59Yb85QJf".into())
            }
        );
        let fail = |m: &str| {
            auth_line(&format!("2026-10-24T23:16:34+07:00 ubuntu sshd[1]: {m}")).map(|x| x.1)
        };
        assert_eq!(
            fail("Invalid user admin from 192.0.2.7 port 4"),
            Some(Auth::Failed {
                ip: "192.0.2.7".into()
            })
        );
        assert_eq!(
            fail("Connection closed by authenticating user root 192.0.2.8 port 4 [preauth]"),
            Some(Auth::Failed {
                ip: "192.0.2.8".into()
            })
        );
        assert_eq!(
            fail("Disconnected from invalid user admin 192.0.2.7 port 4 [preauth]"),
            None
        );
        assert_eq!(
            fail("Received disconnect from 192.0.2.7 port 4:11: Bye Bye [preauth]"),
            None
        );
        let account =
            auth_line("2026-10-24T23:16:34+07:00 ubuntu useradd[9]: new user: name=evil, UID=1001")
                .unwrap()
                .1;
        assert!(matches!(account, Auth::Account { ref text } if text.contains("evil")));
        assert_eq!(
            auth_line(
                "2026-10-24T23:16:34+07:00 ubuntu CRON[9]: pam_unix(cron:session): session opened"
            ),
            None
        );
    }

    #[test]
    fn npm_lines_panels_and_probes() {
        let l = "[22/Oct/2026:12:05:19 +0000] - 200 200 - POST https docker.chakkritton.com \"/api/auth\" [Client 2001:db8::1] [Length 306] [Gzip -] [Sent-to dock] \"Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Mobile/15E148 Safari/604.1\" \"-\"";
        let a = npm_line(l).unwrap();
        assert_eq!(
            (
                a.code,
                a.method.as_str(),
                a.host.as_str(),
                a.path.as_str(),
                a.client.as_str()
            ),
            (
                200,
                "POST",
                "docker.chakkritton.com",
                "/api/auth",
                "2001:db8::1"
            )
        );
        assert_eq!(device(&a.ua), "iPhone · Safari");
        assert!(is_login(panel_of(&a.host).unwrap(), &a));
        assert_eq!(
            device("Mozilla/5.0 (Macintosh) owner-admin-script"),
            "สคริปต์ผู้ดูแล"
        );
        assert_eq!(probe_kind("/api/v1/.env"), Some("secrets"));
        assert_eq!(probe_kind("/wp-login.php"), Some("wordpress"));
        assert_eq!(probe_kind("/index.php?x=1"), Some("php"));
        assert_eq!(probe_kind("/cgi-bin/../../etc/passwd"), Some("traversal"));
        for ok in [
            "/",
            "/admin",
            "/api/v1/provinces/10",
            "/_next/static/chunk.js",
            "/en/projects/ssd-scope-for-mac",
        ] {
            assert_eq!(probe_kind(ok), None, "{ok}");
        }
    }

    #[test]
    fn ssh_key_fingerprint_matches_openssh() {
        assert_eq!(
            key_fingerprint(KEY).unwrap(),
            "SHA256:+9PIHDxWWREE4KLm9sZd4VoljuuE8a6t6men64a1vLQ owner@mac"
        );
        assert_eq!(
            b64_decode(&b64_encode(b"any bytes!")).unwrap(),
            b"any bytes!"
        );
        assert_eq!(key_fingerprint("not a key"), None);
    }

    #[test]
    fn listening_sockets_skip_loopback() {
        let t = Temp::new("ports");
        let r = roots(&t);
        fs::write(r.proc.join("1/net/tcp"), "  sl  local_address rem_address   st\n   0: 00000000:0016 00000000:0000 0A\n   1: 0100007F:0051 00000000:0000 0A\n   2: 00000000:01BB 00000000:0000 01\n").unwrap();
        fs::write(r.proc.join("1/net/tcp6"), "  sl  local_address\n   0: 00000000000000000000000000000000:0050 00000000000000000000000000000000:0000 0A\n   1: 00000000000000000000000001000000:1F90 00000000000000000000000000000000:0000 0A\n").unwrap();
        assert_eq!(listening(&r.proc), vec!["tcp/22", "tcp/80"]);
    }

    #[test]
    fn a_watch_entry_added_later_is_learned_silently() {
        let t = Temp::new("added");
        let r = roots(&t);
        let now = 1_000_000.;
        fs::write(r.host.join("etc/passwd"), "root:x:0:0::/root:/bin/bash\n").unwrap();
        fs::write(r.host.join("root/.bashrc"), "# ~/.bashrc\n").unwrap();
        let mut s = Security::load(r.clone(), now);
        s.tick(now);
        // as saved by a version that did not watch root's dotfiles yet
        s.st.watched.clear();
        s.st.files.retain(|p, _| p == "/etc/passwd");
        s.check_files(now + 60.);
        assert!(s.outbox(0)["events"].as_array().unwrap().is_empty());
        assert!(s.st.files.contains_key("/root/.bashrc"));
        assert!(s.st.watched.contains("/root/.profile"));
        // from now on these entries are watched like the rest
        fs::write(r.host.join("root/.profile"), "curl x | sh\n").unwrap();
        fs::write(r.host.join("root/.bashrc"), "# ~/.bashrc\nalias ls=x\n").unwrap();
        s.check_files(now + 120.);
        let titles: Vec<_> = s.st.events.iter().map(|e| e.title.as_str()).collect();
        assert!(titles.contains(&"มีไฟล์ใหม่: /root/.profile"), "{titles:?}");
        assert!(titles.contains(&"ไฟล์สำคัญถูกแก้: /root/.bashrc"), "{titles:?}");
    }

    #[test]
    fn image_scans_alert_on_new_fixable_findings_only() {
        let t = Temp::new("scan");
        let r = roots(&t);
        let now = 1_000_000.;
        let write = |scanned: f64, images: Value| {
            let doc =
                json!({ "scanned": scanned, "trivy": "0.75.0", "dbError": null, "images": images });
            fs::write(r.host.join("scan/images.json"), doc.to_string()).unwrap();
        };
        let img = |name: &str, keys: &[&str]| json!({ "image": name, "counts": {}, "vulns": [], "fixableKeys": keys });
        let mut s = Security::load(r.clone(), now);
        s.tick(now);
        // the first scan after the watch exists is reported once, as a summary
        write(
            now + 10.,
            json!([
                img("nginx:1", &["HIGH|CVE-1|openssl"]),
                img("web:local", &[])
            ]),
        );
        s.check_scan(now + 60.);
        let e = s.st.events.back().unwrap();
        assert!(
            e.title
                .starts_with("สแกนช่องโหว่ใน image ครั้งแรก: แก้ได้ 1 รายการ"),
            "{}",
            e.title
        );
        assert_eq!(
            (e.level, e.alert, e.cat.as_str()),
            (Level::Warn, true, "images")
        );
        assert!(
            s.payload(now + 60.)["cats"]["images"]["images"][0]
                .get("fixableKeys")
                .is_none()
        );
        let n = s.st.events.len();
        // the same file again, and a rebuild with the same findings: nothing new
        s.check_scan(now + 120.);
        write(
            now + 86_400.,
            json!([
                img("nginx:1", &["HIGH|CVE-1|openssl"]),
                img("web:local", &[])
            ]),
        );
        s.check_scan(now + 86_460.);
        assert_eq!(s.st.events.len(), n);
        // a new critical finding is Bad; a failed scan of another image keeps what it had
        write(
            now + 2. * 86_400.,
            json!([
                img("nginx:1", &["HIGH|CVE-1|openssl", "CRITICAL|CVE-2|zlib"]),
                { "image": "web:local", "error": "trivy: boom" },
            ]),
        );
        s.check_scan(now + 2. * 86_400. + 60.);
        let e = s.st.events.back().unwrap();
        assert_eq!(e.level, Level::Bad);
        assert!(e.detail.contains("nginx:1: CVE-2 (zlib)"), "{}", e.detail);
        // once the events have aged out, a scan that stopped running still colours the category
        assert_eq!(s.status("images", now + 6. * 86_400.), Level::Warn);
        assert_eq!(s.status("images", now + 2. * 86_400. + 120.), Level::Bad);
    }

    #[test]
    fn first_run_learns_silently_then_changes_alert() {
        let t = Temp::new("watch");
        let r = roots(&t);
        let now = iso_time("2026-10-24T12:00:00+07:00").unwrap();
        fs::write(r.host.join("log/auth.log"), ssh("2026-10-24T09:00:00+07:00", "58.8.180.204", "SHA256:known") + "2026-10-24T09:01:00+07:00 ubuntu sshd[2]: Invalid user admin from 192.0.2.9 port 1\n").unwrap();
        fs::write(r.host.join("etc/passwd"), "root:x:0:0::/root:/bin/bash\n").unwrap();
        fs::write(r.host.join("root/.ssh/authorized_keys"), format!("{KEY}\n")).unwrap();
        fs::write(
            r.proc.join("1/net/tcp"),
            "h\n   0: 00000000:0016 00000000:0000 0A\n",
        )
        .unwrap();
        fs::write(r.npm.join("proxy-host-4_access.log"), "[24/Oct/2026:02:00:00 +0000] - 200 200 - POST https docker.chakkritton.com \"/api/auth\" [Client 2001:db8:1:2::5] [Length 1] [Gzip -] [Sent-to dock] \"curl/8\" \"-\"\n").unwrap();
        let mut s = Security::load(r.clone(), now);
        s.tick(now);
        assert!(
            s.outbox(0)["events"].as_array().unwrap().is_empty(),
            "the baseline must not alert"
        );
        let p = s.payload(now);
        assert_eq!(p["status"], "info");
        assert_eq!(p["cats"]["ssh"]["failed24"], 1);
        assert_eq!(p["cats"]["panel"]["logins"][0]["how"], "curl");
        assert_eq!(p["cats"]["host"]["ports"][0], "tcp/22");
        s.save().unwrap();

        // restart: resumes offsets, then a hotspot login, a new key line, a new user and a new port
        let mut s = Security::load(r.clone(), now);
        let later = now + 120.;
        let mut log = fs::read_to_string(r.host.join("log/auth.log")).unwrap();
        log += &ssh("2026-10-24T12:01:00+07:00", "58.8.180.99", "SHA256:known");
        log += &ssh(
            "2026-10-24T12:01:30+07:00",
            "49.229.180.248",
            "SHA256:known",
        );
        fs::write(r.host.join("log/auth.log"), log).unwrap();
        fs::write(
            r.host.join("etc/passwd"),
            "root:x:0:0::/root:/bin/bash\nevil:x:1001:1001::/home/evil:/bin/bash\n",
        )
        .unwrap();
        fs::write(
            r.proc.join("1/net/tcp"),
            "h\n   0: 00000000:0016 00000000:0000 0A\n   1: 00000000:1F90 00000000:0000 0A\n",
        )
        .unwrap();
        s.tick(later);
        let out = s.outbox(0);
        let titles: Vec<_> = out["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["title"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(titles.len(), 3, "{titles:?}");
        assert!(
            titles[0].contains("เครือข่ายใหม่"),
            "same /24 is not new, the hotspot is: {titles:?}"
        );
        assert!(titles.iter().any(|t| t.contains("/etc/passwd")));
        assert!(titles.iter().any(|t| t.contains("TCP 8080")));
        let passwd = out["events"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["title"].as_str().unwrap().contains("passwd"))
            .unwrap();
        assert_eq!(passwd["detail"], "เพิ่ม evil");
        assert_eq!(s.payload(later)["status"], "bad");
        let last = out["last"].as_u64().unwrap();
        assert!(s.outbox(last)["events"].as_array().unwrap().is_empty());

        // acknowledging clears the colour; the history stays
        s.ack(later + 1.);
        assert_eq!(s.payload(later + 2.)["status"], "info");
        assert!(
            !s.payload(later + 2.)["events"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        // nothing persisted holds a file's contents
        s.save().unwrap();
        let saved = fs::read_to_string(r.data.join("security.json")).unwrap();
        assert!(!saved.contains("/bin/bash") && !saved.contains("AAAAC3Nza"));
    }

    #[test]
    fn rotated_auth_log_is_finished_before_the_new_one() {
        let t = Temp::new("rotate");
        let r = roots(&t);
        let now = iso_time("2026-10-24T12:00:00+07:00").unwrap();
        fs::write(
            r.host.join("log/auth.log"),
            ssh("2026-10-24T09:00:00+07:00", "58.8.180.204", "SHA256:a"),
        )
        .unwrap();
        let mut s = Security::load(r.clone(), now);
        s.tick(now);
        let mut log = fs::read_to_string(r.host.join("log/auth.log")).unwrap();
        log += &ssh("2026-10-24T12:00:30+07:00", "203.0.113.5", "SHA256:a");
        fs::write(r.host.join("log/auth.log"), log).unwrap();
        fs::rename(r.host.join("log/auth.log"), r.host.join("log/auth.log.1")).unwrap();
        fs::write(
            r.host.join("log/auth.log"),
            ssh("2026-10-24T12:01:00+07:00", "198.51.100.5", "SHA256:b"),
        )
        .unwrap();
        s.tick(now + 60.);
        let titles: Vec<_> = s.outbox(0)["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["title"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            titles,
            vec!["SSH: ล็อกอินจากเครือข่ายใหม่", "SSH: ล็อกอินด้วยคีย์ที่ไม่เคยเห็น"]
        );
    }

    #[test]
    fn container_configs() {
        let t = Temp::new("ctr");
        let r = roots(&t);
        let add = |id: &str, config: Value, host: Value| {
            let d = r.host.join("containers").join(id);
            fs::create_dir_all(&d).unwrap();
            fs::write(d.join("config.v2.json"), config.to_string()).unwrap();
            fs::write(d.join("hostconfig.json"), host.to_string()).unwrap();
        };
        add(
            "a",
            json!({"Name":"/portainer","Config":{"Image":"portainer/portainer-ce:lts","Labels":{"com.docker.compose.project":"server","com.docker.compose.service":"portainer"}},"State":{"Running":true},"MountPoints":{"/var/run/docker.sock":{"Source":"/var/run/docker.sock"}}}),
            json!({"Privileged":false}),
        );
        add(
            "b",
            json!({"Name":"/apps-portfolio-27","Config":{"Image":"apps-portfolio:local","Labels":{}},"State":{"Running":true}}),
            json!({"Privileged":true,"PidMode":"host","CapAdd":["SYS_ADMIN"]}),
        );
        let scan = json!({"Name":"/eloquent_carver","Config":{"Image":"aquasec/trivy:0.75.0@sha256:af6a","Labels":{"dock.image-scan":"true"}},"State":{"Running":true}});
        add("c", scan.clone(), json!({"Privileged":false}));
        let list = containers(&r.host.join("containers"));
        assert_eq!(
            list.len(),
            2,
            "the scanner's own runs are not containers to watch"
        );
        // with extra privileges (or another image) the label does not hide it
        add("d", scan, json!({"Privileged":true}));
        let list = containers(&r.host.join("containers"));
        assert_eq!(list.len(), 3);
        fs::remove_dir_all(r.host.join("containers/d")).unwrap();
        let list = containers(&r.host.join("containers"));
        assert_eq!(list[0].ident, "apps-portfolio");
        assert_eq!(
            list[0].risky,
            vec!["cap-add:SYS_ADMIN", "host-pid", "privileged"]
        );
        assert!(!list[0].compose);
        assert_eq!(list[1].ident, "server/portainer");
        assert_eq!(list[1].risky, vec!["docker-socket"]);
    }

    #[test]
    fn updates_and_reboot() {
        let t = Temp::new("apt");
        let r = roots(&t);
        fs::write(r.host.join("apt/updates-available"), "\n16 updates can be applied immediately.\n3 of these updates are standard security updates.\n").unwrap();
        fs::write(r.proc.join("sys/kernel/osrelease"), "6.8.0-85-generic\n").unwrap();
        for k in [
            "vmlinuz-6.8.0-85-generic",
            "vmlinuz-6.8.0-87-generic",
            "vmlinuz",
        ] {
            fs::write(r.host.join("boot").join(k), "").unwrap();
        }
        let u = updates(&r.host, &r.proc, 1.);
        assert_eq!((u.pending, u.security, u.reboot), (Some(16), Some(3), true));
        assert_eq!(u.newest, "6.8.0-87-generic");
    }
}
