//! Native backup orchestration; pg_dump/tar/OpenSSL/zip retain the restore bundle format.
use crate::util::Locked;
use crate::{checks::millis, util};
use axum::{
    Router,
    body::Body,
    extract::{Request, State},
    http::{Method, Response},
    response::Response as HttpResponse,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
struct Backups {
    out: PathBuf,
    volumes: PathBuf,
    env: PathBuf,
    tw_env: PathBuf,
    origin: PathBuf,
    repos: PathBuf,
    tw_repo: PathBuf,
    restore: PathBuf,
    readme: PathBuf,
    db_host: String,
    keep: usize,
    job: Mutex<Option<Value>>,
    links: Mutex<HashMap<String, (String, i64)>>,
    disabled: bool,
}
type BundleResult<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
fn valid_name(name: &str) -> bool {
    let Some(x) = name
        .strip_prefix("chakkritton-server-backup-")
        .or_else(|| name.strip_prefix("thai-weather-backup-"))
        .and_then(|x| x.strip_suffix(".zip"))
    else {
        return false;
    };
    let b = x.as_bytes();
    b.len() == 13 && b[8] == b'-' && b[..8].iter().chain(b[9..].iter()).all(u8::is_ascii_digit)
}
fn include_volume(name: &str) -> bool {
    if name.ends_with("-cache")
        || ["apps_db-data", "apps_backup-bundles", "metadata.db"].contains(&name)
    {
        return false;
    }
    !(name.len() == 64
        && name
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()))
}

fn entries(path: &Path) -> std::io::Result<Vec<String>> {
    let mut files = fs::read_dir(path)?
        .map(|r| r.map(|r| r.file_name().to_string_lossy().into_owned()))
        .collect::<std::io::Result<Vec<_>>>()?;
    files.sort();
    Ok(files)
}
fn git_head(repo: &Path) -> Option<Value> {
    let git = repo.join(".git");
    let head = fs::read_to_string(git.join("HEAD"))
        .ok()?
        .trim()
        .to_string();
    let (commit, branch) = if let Some(r) = head.strip_prefix("ref: ") {
        let c = fs::read_to_string(git.join(r))
            .ok()
            .map(|s| s.trim().to_string())
            .or_else(|| {
                fs::read_to_string(git.join("packed-refs"))
                    .ok()
                    .and_then(|s| {
                        s.lines()
                            .find(|l| l.ends_with(&format!(" {r}")))
                            .and_then(|l| l.split(' ').next())
                            .map(str::to_string)
                    })
            })?;
        (c, Some(r.trim_start_matches("refs/heads/").to_string()))
    } else {
        (head, None)
    };
    if commit.len() != 40
        || !commit
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return None;
    }
    let cfg = fs::read_to_string(git.join("config")).unwrap_or_default();
    let url = cfg
        .split("[remote \"origin\"]")
        .nth(1)
        .and_then(|s| s.split('[').next())
        .and_then(|s| {
            s.lines()
                .find_map(|l| l.trim().strip_prefix("url = ").map(str::to_string))
        });
    Some(json!({"commit":commit,"branch":branch,"url":url}))
}
fn cmd(args: &[String], cwd: Option<&Path>, env: &[(&str, &str)]) -> BundleResult<()> {
    let mut c = Command::new(&args[0]);
    c.args(&args[1..]);
    if let Some(p) = cwd {
        c.current_dir(p);
    }
    for (k, v) in env {
        c.env(k, v);
    }
    let out = c.output()?;
    if !out.status.success() {
        return Err(format!("{} failed ({})", args[0], out.status.code().unwrap_or(-1)).into());
    }
    Ok(())
}
fn args(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}
fn p(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
impl Backups {
    fn step(&self, s: &str) {
        if let Some(j) = self.job.locked().as_mut() {
            j["step"] = json!(s);
        }
    }
    fn bundle(&self, pass: &str, name: &str) {
        let work = self.out.join(format!(".work-{}", uuid::Uuid::new_v4()));
        let result: BundleResult<()> = (|| {
            use std::os::unix::fs::DirBuilderExt;
            fs::DirBuilder::new().mode(0o700).create(&work)?;
            let payload = work.join("payload");
            for d in ["db", "volumes", "env", "origin-ca"] {
                fs::create_dir_all(payload.join(d))?;
            }
            self.step("สำรองฐานข้อมูล");
            let db_env = fs::read_to_string(self.env.join("db.env"))?;
            let password = db_env
                .lines()
                .filter(|l| !l.starts_with('#'))
                .find_map(|l| l.strip_prefix("POSTGRES_PASSWORD="))
                .ok_or("missing database configuration")?;
            for name in ["expenses", "portfolio", "calorieflow"] {
                cmd(
                    &args(&[
                        "pg_dump",
                        "-h",
                        &self.db_host,
                        "-U",
                        "postgres",
                        "-Fc",
                        "-f",
                        &p(&payload.join("db").join(format!("{name}.dump"))),
                        name,
                    ]),
                    None,
                    &[("PGPASSWORD", password)],
                )?;
            }
            self.step("สำรอง volume");
            let mut sizes = serde_json::Map::new();
            for name in entries(&self.volumes)?
                .into_iter()
                .filter(|n| include_volume(n))
            {
                let data = self.volumes.join(&name).join("_data");
                if !data.exists() {
                    continue;
                }
                self.step(&format!("สำรอง volume {name}"));
                let dest = payload.join("volumes").join(format!("{name}.tar.gz"));
                cmd(
                    &args(&[
                        "tar",
                        "--numeric-owner",
                        "-czf",
                        &p(&dest),
                        "-C",
                        &p(&data),
                        ".",
                    ]),
                    None,
                    &[],
                )?;
                sizes.insert(name, json!(fs::metadata(dest)?.len()));
            }
            self.step("สำรองการตั้งค่า");
            for f in entries(&self.env)?
                .into_iter()
                .filter(|f| f.ends_with(".env"))
            {
                fs::copy(self.env.join(&f), payload.join("env").join(f))?;
            }
            if self.tw_env.exists() {
                fs::copy(&self.tw_env, payload.join("env/thai-weather.deploy.env"))?;
            }
            if self.origin.exists() {
                for f in entries(&self.origin)? {
                    fs::copy(self.origin.join(&f), payload.join("origin-ca").join(f))?;
                }
            }
            let mut repos = serde_json::Map::new();
            repos.insert(
                "thai-weather".into(),
                git_head(&self.tw_repo).unwrap_or(Value::Null),
            );
            if self.repos.exists() {
                for r in entries(&self.repos)? {
                    repos.insert(
                        r.clone(),
                        git_head(&self.repos.join(r)).unwrap_or(Value::Null),
                    );
                }
            }
            let created = chrono::DateTime::from_timestamp_millis(millis())
                .unwrap()
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            fs::write(
                payload.join("meta.json"),
                serde_json::to_vec_pretty(
                    &json!({"created":created,"format":1,"repos":repos,"volumes":sizes,"databases":["expenses","portfolio","calorieflow"]}),
                )?,
            )?;
            self.step("เข้ารหัส");
            let tar = work.join("payload.tar");
            cmd(
                &args(&["tar", "-cf", &p(&tar), "-C", &p(&payload), "."]),
                None,
                &[],
            )?;
            fs::remove_dir_all(payload)?;
            let enc = work.join("payload.enc");
            cmd(
                &args(&[
                    "openssl",
                    "enc",
                    "-aes-256-cbc",
                    "-pbkdf2",
                    "-iter",
                    "600000",
                    "-salt",
                    "-in",
                    &p(&tar),
                    "-out",
                    &p(&enc),
                    "-pass",
                    "env:BUNDLE_PASS",
                ]),
                None,
                &[("BUNDLE_PASS", pass)],
            )?;
            fs::remove_file(tar)?;
            let mut hash = Sha256::new();
            let mut file = fs::File::open(enc)?;
            let mut buf = [0u8; 65536];
            loop {
                let n = file.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                hash.update(&buf[..n]);
            }
            fs::write(
                work.join("payload.enc.sha256"),
                format!("{:x}  payload.enc\n", hash.finalize()),
            )?;
            fs::copy(&self.restore, work.join("restore.sh"))?;
            fs::copy(&self.readme, work.join("README.txt"))?;
            self.step("รวมเป็น zip");
            let partial = self.out.join(format!("{name}.part"));
            cmd(
                &args(&[
                    "zip",
                    "-q",
                    "-0",
                    "-X",
                    &p(&partial),
                    "restore.sh",
                    "README.txt",
                    "payload.enc",
                    "payload.enc.sha256",
                ]),
                Some(&work),
                &[],
            )?;
            fs::rename(partial, self.out.join(name))?;
            self.step("เสร็จ");
            self.job.locked().as_mut().unwrap()["done"] = json!(true);
            let all = entries(&self.out)?
                .into_iter()
                .filter(|n| valid_name(n))
                .collect::<Vec<_>>();
            for f in all.iter().take(all.len().saturating_sub(self.keep)) {
                fs::remove_file(self.out.join(f))?;
            }
            Ok(())
        })();
        if let Err(e) = result {
            self.job.locked().as_mut().unwrap()["error"] = json!(e.to_string());
            let _ = fs::remove_file(self.out.join(format!("{name}.part")));
            eprintln!("bundle failed");
        }
        let _ = fs::remove_dir_all(work);
    }
    fn list(&self) -> std::io::Result<Vec<Value>> {
        fs::create_dir_all(&self.out)?;
        let mut files = entries(&self.out)?
            .into_iter()
            .filter(|n| valid_name(n))
            .collect::<Vec<_>>();
        files.reverse();
        files
            .into_iter()
            .map(|name| {
                let m = fs::metadata(self.out.join(&name))?;
                let ms = m
                    .modified()?
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as i64;
                let created = chrono::DateTime::from_timestamp_millis(ms)
                    .unwrap()
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                Ok(json!({"name":name,"size":m.len(),"created":created}))
            })
            .collect()
    }
}
async fn handle(State(b): State<Arc<Backups>>, req: Request) -> HttpResponse {
    let method = req.method().clone();
    let path = req.uri().path().trim_end_matches('/');
    if path == "/health" && matches!(method, Method::GET | Method::HEAD) {
        return util::json(200, json!({"ok":true}));
    }
    if path == "/backups" && method == Method::GET {
        return match b.list() {
            Ok(v) => util::json(200, json!({"bundles":v,"job":*b.job.locked()})),
            Err(_) => util::json(500, json!({"error":"storage unavailable"})),
        };
    }
    if b.disabled && !matches!(method, Method::GET | Method::HEAD) {
        return util::json(503, json!({"error":"jobs disabled"}));
    }
    if path == "/backups" && method == Method::POST {
        let bytes = axum::body::to_bytes(req.into_body(), 2 * 1024 * 1024)
            .await
            .unwrap_or_default();
        let body = serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null);
        let Some(pass) = body["passphrase"]
            .as_str()
            .filter(|s| (12..=200).contains(&s.encode_utf16().count()))
        else {
            return util::json(400, json!({"error":"passphrase must be 12–200 characters"}));
        };
        let now = millis();
        let name = format!(
            "chakkritton-server-backup-{}.zip",
            chrono::DateTime::from_timestamp_millis(now + 7 * 3_600_000)
                .unwrap()
                .format("%Y%m%d-%H%M")
        );
        {
            let mut job = b.job.locked();
            if job
                .as_ref()
                .is_some_and(|j| j.get("done").is_none() && j.get("error").is_none())
            {
                return util::json(409, json!({"error":"a backup is already running"}));
            }
            *job = Some(json!({"name":name,"started":now,"step":"เริ่ม"}));
        }
        let result = util::json(200, json!({"started":name}));
        let pass = pass.to_string();
        tokio::task::spawn_blocking(move || b.bundle(&pass, &name));
        return result;
    }
    if let Some(token) = path
        .strip_prefix("/backups/dl/")
        .filter(|_| matches!(method, Method::GET | Method::HEAD))
    {
        let link = b.links.locked().get(token).cloned();
        let Some((name, until)) = link.filter(|(_, until)| *until >= millis()) else {
            return util::text(410, "link expired");
        };
        let _ = until;
        let Ok(mut file) = tokio::fs::File::open(b.out.join(&name)).await else {
            return util::text(404, "not found");
        };
        let size = file.metadata().await.map(|m| m.len()).unwrap_or(0);
        let mut start = 0;
        let mut end = size.saturating_sub(1);
        let mut partial = false;
        if let Some(range) = req
            .headers()
            .get("range")
            .and_then(|h| h.to_str().ok())
            .and_then(|h| h.strip_prefix("bytes="))
            && let Some((a, b)) = range.split_once('-')
        {
            let parsed = if a.is_empty() {
                b.parse::<u64>()
                    .ok()
                    .filter(|&n| n > 0)
                    .map(|n| (size.saturating_sub(n), end))
            } else {
                a.parse::<u64>().ok().and_then(|a| {
                    if b.is_empty() {
                        Some((a, end))
                    } else {
                        b.parse::<u64>().ok().map(|b| (a, b.min(end)))
                    }
                })
            };
            let Some((a, b)) = parsed.filter(|&(a, b)| a <= b && a < size) else {
                return Response::builder()
                    .status(416)
                    .header("content-range", format!("bytes */{size}"))
                    .body(Body::empty())
                    .unwrap();
            };
            start = a;
            end = b;
            partial = true;
        }
        let length = if partial { end - start + 1 } else { size };
        if start > 0 && file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
            return util::text(500, "read failed");
        }
        let mut response = Response::builder()
            .status(if partial { 206 } else { 200 })
            .header("content-type", "application/zip")
            .header(
                "content-disposition",
                format!("attachment; filename=\"{name}\""),
            )
            .header("cache-control", "no-store")
            .header("accept-ranges", "bytes")
            .header("content-length", length);
        if partial {
            response = response.header("content-range", format!("bytes {start}-{end}/{size}"));
        }
        return response
            .body(if method == Method::HEAD {
                Body::empty()
            } else {
                Body::from_stream(tokio_util::io::ReaderStream::new(file.take(length)))
            })
            .unwrap();
    }
    if let Some(name) = path.strip_prefix("/backups/") {
        if let Some(name) = name
            .strip_suffix("/link")
            .filter(|_| method == Method::POST)
        {
            if !valid_name(name) || !b.out.join(name).is_file() {
                return util::json(404, json!({"error":"not found"}));
            }
            let token = format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            );
            let now = millis();
            let mut links = b.links.locked();
            links.retain(|_, (_, until)| *until >= now);
            links.insert(token.clone(), (name.into(), now + 600_000));
            return util::json(200, json!({"url":format!("/api/backups/dl/{token}")}));
        }
        if method == Method::DELETE {
            if !valid_name(name) {
                return util::json(404, json!({"error":"not found"}));
            }
            match fs::remove_file(b.out.join(name)) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return util::json(500, json!({"error":"delete failed"})),
            }
            return util::json(200, json!({"deleted":name}));
        }
    }
    util::text(404, "NOT_FOUND")
}
pub fn router() -> Result<Router, Box<dyn std::error::Error>> {
    let path = |key, default| PathBuf::from(util::env(key, default));
    let b = Backups {
        out: path("BUNDLE_DIR", "/bundles"),
        volumes: path("VOLUMES_DIR", "/volumes"),
        env: path("ENV_DIR", "/src/env"),
        tw_env: path("TW_ENV", "/src/thai-weather.env"),
        origin: path("ORIGIN_DIR", "/src/origin-ca"),
        repos: path("REPOS_DIR", "/src/repos"),
        tw_repo: path("TW_REPO", "/src/thai-weather"),
        restore: path("RESTORE_SCRIPT", "/app/backup/restore.sh"),
        readme: path("RESTORE_README", "/app/backup/README.txt"),
        db_host: util::env("DB_HOST", "apps-db"),
        keep: util::env("KEEP", "5").parse()?,
        job: Mutex::new(None),
        links: Mutex::new(HashMap::new()),
        disabled: util::env("BACKUP_JOBS_DISABLED", "") == "true",
    };
    fs::create_dir_all(&b.out)?;
    Ok(Router::new().fallback(handle).with_state(Arc::new(b)))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn volume_and_file_guards() {
        for n in ["thai-weather_npm-data", "apps_media-data", "apps_sync-data"] {
            assert!(include_volume(n));
        }
        for n in [
            "apps_portfolio-cache",
            "apps_db-data",
            "metadata.db",
            "apps_backup-bundles",
            "b6a7a2b8f1a7b736037da4a109f714dbd69f7bc10f85515ea266cf56c9bbcb4b",
        ] {
            assert!(!include_volume(n));
        }
        assert!(valid_name("chakkritton-server-backup-20261019-0800.zip"));
        for n in [
            "../x",
            "chakkritton-server-backup-20261019-0800.zip/",
            "backup-20261019-0800.zip",
        ] {
            assert!(!valid_name(n));
        }
    }
}
