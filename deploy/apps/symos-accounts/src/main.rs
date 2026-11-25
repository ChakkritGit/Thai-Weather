//! SymOS accounts (accounts.chakkritton.com): a SymOS device's online account, so a forgotten passcode can be
//! reset (the owner, 2026-11-25).
//!
//! An account is an e-mail address, a name and a password (Argon2id). Signing in gives a session token: 32 random
//! bytes, of which only the SHA-256 is stored, good for 180 days. Each device of an account keeps an escrow here:
//! its home's recovery key, wrapped on the device with a key derived from the account password, so neither this
//! service nor its database ever holds the recovery key itself. Changing the password sends every escrow wrapped
//! again. Nothing here sends e-mail, so addresses are not verified.
//!
//! Postgres (symos-accounts-db: its own container, volume and network) holds accounts, sessions and escrows.
//! Sign-up and sign-in are limited per address and per visitor (Cloudflare's CF-Connecting-IP) in memory.

use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

use argon2::{
    Argon2, PasswordHasher, PasswordVerifier,
    password_hash::{PasswordHash, SaltString, rand_core::OsRng},
};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::RngCore;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::{RwLock, Semaphore};
use tokio_postgres::{Client, NoTls};

const PORT: u16 = 8080;
const SESSION_DAYS: i32 = 180;
/// An escrow is a small wrapped key (base64): anything larger is not one
const ESCROW_MAX: usize = 4096;
/// Argon2 takes ~19 MiB and tens of milliseconds per hash: at most this many at once
const HASHING: usize = 2;

const SCHEMA: &str = "
create table if not exists accounts (
  id bigserial primary key,
  email text not null unique,
  name text not null,
  password text not null,
  created timestamptz not null default now()
);
create table if not exists sessions (
  token bytea primary key,
  account bigint not null references accounts on delete cascade,
  label text not null default '',
  created timestamptz not null default now(),
  expires timestamptz not null
);
create index if not exists sessions_account on sessions (account);
create table if not exists devices (
  account bigint not null references accounts on delete cascade,
  device text not null,
  name text not null,
  escrow text not null,
  updated timestamptz not null default now(),
  primary key (account, device)
);
";

struct Db {
    config: String,
    client: RwLock<Option<Arc<Client>>>,
}

impl Db {
    /// The connection, made again when it has closed (the database restarted)
    async fn get(&self) -> Result<Arc<Client>, Error> {
        if let Some(c) = self.client.read().await.as_ref().filter(|c| !c.is_closed()) {
            return Ok(c.clone());
        }
        let mut slot = self.client.write().await;
        if let Some(c) = slot.as_ref().filter(|c| !c.is_closed()) {
            return Ok(c.clone());
        }
        let (client, connection) = tokio_postgres::connect(&self.config, NoTls).await.map_err(|e| {
            eprintln!("database: {e}");
            Error::Unavailable
        })?;
        tokio::spawn(async move {
            if let Err(e) = connection.await {
                eprintln!("database connection: {e}");
            }
        });
        let client = Arc::new(client);
        *slot = Some(client.clone());
        Ok(client)
    }
}

/// Attempts per key in a window, kept in memory
#[derive(Default)]
struct Limits(Mutex<HashMap<String, (u32, Instant)>>);

impl Limits {
    /// Counts an attempt; false once `key` has had `most` in the last `window`
    fn allow(&self, key: &str, most: u32, window: Duration) -> bool {
        let now = Instant::now();
        let mut map = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if map.len() > 20_000 {
            map.retain(|_, (_, since)| now.duration_since(*since) < Duration::from_secs(3600));
        }
        let entry = map.entry(key.to_string()).or_insert((0, now));
        if now.duration_since(entry.1) >= window {
            *entry = (0, now);
        }
        entry.0 += 1;
        entry.0 <= most
    }
}

struct App {
    db: Db,
    limits: Limits,
    hashing: Semaphore,
}

type Shared = Arc<App>;

#[derive(Debug, PartialEq)]
enum Error {
    Bad(&'static str),
    Unauthorized,
    WrongPassword,
    Taken,
    NotFound,
    TooMany,
    Unavailable,
}

impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let (status, code) = match self {
            Error::Bad(why) => (StatusCode::BAD_REQUEST, why),
            Error::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized"),
            Error::WrongPassword => (StatusCode::UNAUTHORIZED, "wrong-email-or-password"),
            Error::Taken => (StatusCode::CONFLICT, "email-taken"),
            Error::NotFound => (StatusCode::NOT_FOUND, "not-found"),
            Error::TooMany => (StatusCode::TOO_MANY_REQUESTS, "too-many-attempts"),
            Error::Unavailable => (StatusCode::SERVICE_UNAVAILABLE, "unavailable"),
        };
        (status, Json(json!({ "error": code }))).into_response()
    }
}

impl From<tokio_postgres::Error> for Error {
    fn from(e: tokio_postgres::Error) -> Self {
        eprintln!("database: {e}");
        Error::Unavailable
    }
}

/// An address as stored: trimmed and lower case; None when it cannot be one
fn email(raw: &str) -> Option<String> {
    let e = raw.trim().to_lowercase();
    let (local, domain) = e.split_once('@')?;
    let ok = !local.is_empty()
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && e.len() <= 254
        && !e.chars().any(|c| c.is_whitespace() || c.is_control());
    ok.then_some(e)
}

fn check_password(p: &str) -> Result<(), Error> {
    match p.chars().count() {
        0..8 => Err(Error::Bad("password-too-short")),
        8..=256 => Ok(()),
        _ => Err(Error::Bad("password-too-long")),
    }
}

/// A device's id as SymOS makes it (its machine id): letters, digits and dashes
fn device_id(id: &str) -> Result<&str, Error> {
    let ok = (1..=64).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    ok.then_some(id).ok_or(Error::Bad("bad-device"))
}

fn check_escrow(e: &str) -> Result<(), Error> {
    let ok = (1..=ESCROW_MAX).contains(&e.len()) && e.chars().all(|c| c.is_ascii_alphanumeric() || "+/=-_".contains(c));
    ok.then_some(()).ok_or(Error::Bad("bad-escrow"))
}

fn short(s: &str, most: usize) -> String {
    s.trim().chars().filter(|c| !c.is_control()).take(most).collect()
}

fn visitor(headers: &HeaderMap) -> String {
    ["cf-connecting-ip", "x-real-ip"]
        .iter()
        .find_map(|h| headers.get(*h).and_then(|v| v.to_str().ok()))
        .unwrap_or("unknown")
        .to_string()
}

fn token_hash(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

async fn hash(app: &App, password: String) -> Result<String, Error> {
    let _turn = app.hashing.acquire().await.map_err(|_| Error::Unavailable)?;
    tokio::task::spawn_blocking(move || {
        let salt = SaltString::generate(&mut OsRng);
        Argon2::default().hash_password(password.as_bytes(), &salt).map(|h| h.to_string())
    })
    .await
    .map_err(|_| Error::Unavailable)?
    .map_err(|_| Error::Unavailable)
}

/// Checks `password` against `stored`; with no account, against a hash of nothing, so a missing address takes
/// as long to refuse as a wrong password
async fn verify(app: &App, password: String, stored: Option<String>) -> Result<bool, Error> {
    static DUMMY: OnceLock<String> = OnceLock::new();
    let _turn = app.hashing.acquire().await.map_err(|_| Error::Unavailable)?;
    let known = stored.is_some();
    let stored = match stored {
        Some(s) => s,
        None => DUMMY
            .get_or_init(|| {
                let salt = SaltString::generate(&mut OsRng);
                Argon2::default().hash_password(b"not an account", &salt).map(|h| h.to_string()).unwrap_or_default()
            })
            .clone(),
    };
    let ok = tokio::task::spawn_blocking(move || {
        PasswordHash::new(&stored).is_ok_and(|h| Argon2::default().verify_password(password.as_bytes(), &h).is_ok())
    })
    .await
    .map_err(|_| Error::Unavailable)?;
    Ok(known && ok)
}

/// A new session for `account`: the token to give, its hash stored
async fn new_session(db: &Client, account: i64, label: &str) -> Result<String, Error> {
    let mut raw = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut raw);
    let token = URL_SAFE_NO_PAD.encode(raw);
    db.execute(
        "insert into sessions (token, account, label, expires) values ($1, $2, $3, now() + make_interval(days => $4))",
        &[&token_hash(&token), &account, &short(label, 100), &SESSION_DAYS],
    )
    .await?;
    Ok(token)
}

/// The account a request's bearer token signs in to, and the token's hash
async fn signed_in(app: &App, headers: &HeaderMap) -> Result<(Arc<Client>, i64, Vec<u8>), Error> {
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(Error::Unauthorized)?;
    let hashed = token_hash(token.trim());
    let db = app.db.get().await?;
    let row = db.query_opt("select account from sessions where token = $1 and expires > now()", &[&hashed]).await?;
    let account: i64 = row.ok_or(Error::Unauthorized)?.get(0);
    Ok((db, account, hashed))
}

#[derive(Deserialize)]
struct SignUp {
    email: String,
    name: String,
    password: String,
    #[serde(default)]
    label: String,
}

async fn sign_up(State(app): State<Shared>, headers: HeaderMap, Json(b): Json<SignUp>) -> Result<Response, Error> {
    if !app.limits.allow(&format!("up:{}", visitor(&headers)), 5, Duration::from_secs(3600)) {
        return Err(Error::TooMany);
    }
    let email = email(&b.email).ok_or(Error::Bad("bad-email"))?;
    let name = short(&b.name, 100);
    if name.is_empty() {
        return Err(Error::Bad("bad-name"));
    }
    check_password(&b.password)?;
    let hashed = hash(&app, b.password).await?;
    let db = app.db.get().await?;
    let row = db
        .query_opt(
            "insert into accounts (email, name, password) values ($1, $2, $3) on conflict (email) do nothing returning id",
            &[&email, &name, &hashed],
        )
        .await?;
    let account: i64 = row.ok_or(Error::Taken)?.get(0);
    let token = new_session(&db, account, &b.label).await?;
    Ok((StatusCode::CREATED, Json(json!({ "token": token, "email": email, "name": name }))).into_response())
}

#[derive(Deserialize)]
struct SignIn {
    email: String,
    password: String,
    #[serde(default)]
    label: String,
}

async fn sign_in(State(app): State<Shared>, headers: HeaderMap, Json(b): Json<SignIn>) -> Result<Json<Value>, Error> {
    let email = email(&b.email).ok_or(Error::WrongPassword)?;
    let fifteen = Duration::from_secs(900);
    if !app.limits.allow(&format!("in:{}", visitor(&headers)), 30, fifteen) || !app.limits.allow(&format!("in:{email}"), 10, fifteen) {
        return Err(Error::TooMany);
    }
    let db = app.db.get().await?;
    let row = db.query_opt("select id, name, password from accounts where email = $1", &[&email]).await?;
    let stored = row.as_ref().map(|r| r.get::<_, String>(2));
    if !verify(&app, b.password, stored).await? {
        return Err(Error::WrongPassword);
    }
    let row = row.ok_or(Error::WrongPassword)?;
    let token = new_session(&db, row.get(0), &b.label).await?;
    Ok(Json(json!({ "token": token, "email": email, "name": row.get::<_, String>(1) })))
}

async fn sign_out(State(app): State<Shared>, headers: HeaderMap) -> Result<StatusCode, Error> {
    let (db, _, hashed) = signed_in(&app, &headers).await?;
    db.execute("delete from sessions where token = $1", &[&hashed]).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn account(State(app): State<Shared>, headers: HeaderMap) -> Result<Json<Value>, Error> {
    let (db, account, _) = signed_in(&app, &headers).await?;
    let me = db.query_one("select email, name from accounts where id = $1", &[&account]).await?;
    let devices: Vec<Value> = db
        .query(
            "select device, name, to_char(updated at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') from devices where account = $1 order by updated desc",
            &[&account],
        )
        .await?
        .iter()
        .map(|r| json!({ "id": r.get::<_, String>(0), "name": r.get::<_, String>(1), "updated": r.get::<_, String>(2) }))
        .collect();
    Ok(Json(json!({ "email": me.get::<_, String>(0), "name": me.get::<_, String>(1), "devices": devices })))
}

#[derive(Deserialize)]
struct Password {
    password: String,
}

/// Deletes the account, its sessions and escrows; the password again, so a stolen token cannot
async fn delete_account(State(app): State<Shared>, headers: HeaderMap, Json(b): Json<Password>) -> Result<StatusCode, Error> {
    let (db, account, _) = signed_in(&app, &headers).await?;
    let stored: String = db.query_one("select password from accounts where id = $1", &[&account]).await?.get(0);
    if !verify(&app, b.password, Some(stored)).await? {
        return Err(Error::WrongPassword);
    }
    db.execute("delete from accounts where id = $1", &[&account]).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct NewPassword {
    password: String,
    new_password: String,
    /// Every device's escrow, wrapped again with the new password (the device id to the escrow)
    #[serde(default)]
    escrows: HashMap<String, String>,
}

/// A new password: the old one again, and every escrow wrapped with the new one, all in one transaction. Every
/// other session ends.
async fn change_password(State(app): State<Shared>, headers: HeaderMap, Json(b): Json<NewPassword>) -> Result<StatusCode, Error> {
    let (db, account, hashed) = signed_in(&app, &headers).await?;
    check_password(&b.new_password)?;
    for (id, escrow) in &b.escrows {
        device_id(id)?;
        check_escrow(escrow)?;
    }
    let stored: String = db.query_one("select password from accounts where id = $1", &[&account]).await?.get(0);
    if !verify(&app, b.password, Some(stored)).await? {
        return Err(Error::WrongPassword);
    }
    let known: Vec<String> = db.query("select device from devices where account = $1", &[&account]).await?.iter().map(|r| r.get(0)).collect();
    if known.len() != b.escrows.len() || known.iter().any(|d| !b.escrows.contains_key(d)) {
        return Err(Error::Bad("escrows-incomplete"));
    }
    let new_hash = hash(&app, b.new_password).await?;
    db.batch_execute("begin").await?;
    let done = async {
        db.execute("update accounts set password = $2 where id = $1", &[&account, &new_hash]).await?;
        for (id, escrow) in &b.escrows {
            db.execute("update devices set escrow = $3, updated = now() where account = $1 and device = $2", &[&account, id, escrow])
                .await?;
        }
        db.execute("delete from sessions where account = $1 and token <> $2", &[&account, &hashed]).await?;
        Ok::<_, tokio_postgres::Error>(())
    }
    .await;
    match done {
        Ok(()) => db.batch_execute("commit").await?,
        Err(e) => {
            let _ = db.batch_execute("rollback").await;
            return Err(e.into());
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct Device {
    name: String,
    escrow: String,
}

async fn put_device(State(app): State<Shared>, headers: HeaderMap, Path(id): Path<String>, Json(b): Json<Device>) -> Result<StatusCode, Error> {
    let (db, account, _) = signed_in(&app, &headers).await?;
    let id = device_id(&id)?;
    check_escrow(&b.escrow)?;
    let count: i64 = db.query_one("select count(*) from devices where account = $1", &[&account]).await?.get(0);
    let exists = db.query_opt("select 1 from devices where account = $1 and device = $2", &[&account, &id]).await?.is_some();
    if count >= 20 && !exists {
        return Err(Error::Bad("too-many-devices"));
    }
    db.execute(
        "insert into devices (account, device, name, escrow) values ($1, $2, $3, $4)
         on conflict (account, device) do update set name = excluded.name, escrow = excluded.escrow, updated = now()",
        &[&account, &id, &short(&b.name, 100), &b.escrow],
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn get_device(State(app): State<Shared>, headers: HeaderMap, Path(id): Path<String>) -> Result<Json<Value>, Error> {
    let (db, account, _) = signed_in(&app, &headers).await?;
    let id = device_id(&id)?;
    let row = db.query_opt("select name, escrow from devices where account = $1 and device = $2", &[&account, &id]).await?;
    let row = row.ok_or(Error::NotFound)?;
    Ok(Json(json!({ "id": id, "name": row.get::<_, String>(0), "escrow": row.get::<_, String>(1) })))
}

async fn delete_device(State(app): State<Shared>, headers: HeaderMap, Path(id): Path<String>) -> Result<StatusCode, Error> {
    let (db, account, _) = signed_in(&app, &headers).await?;
    let id = device_id(&id)?;
    let n = db.execute("delete from devices where account = $1 and device = $2", &[&account, &id]).await?;
    if n == 0 {
        return Err(Error::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn health(State(app): State<Shared>) -> Result<&'static str, Error> {
    app.db.get().await?.simple_query("select 1").await?;
    Ok("ok")
}

fn router(app: Shared) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/v1/accounts", post(sign_up))
        .route("/v1/sessions", post(sign_in).delete(sign_out))
        .route("/v1/account", get(account).delete(delete_account))
        .route("/v1/account/password", put(change_password))
        .route("/v1/devices/{id}", put(put_device).get(get_device).delete(delete_device))
        .layer(DefaultBodyLimit::max(64 * 1024))
        .with_state(app)
}

/// For the image's HEALTHCHECK (a scratch image has no curl): 0 when /health answers 200
fn healthcheck() -> i32 {
    use std::io::{Read, Write};
    let Ok(mut s) = std::net::TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], PORT)), Duration::from_secs(3)) else { return 1 };
    let _ = s.set_read_timeout(Some(Duration::from_secs(4)));
    if s.write_all(b"GET /health HTTP/1.0\r\nHost: localhost\r\n\r\n").is_err() {
        return 1;
    }
    let mut head = [0u8; 12];
    match s.read_exact(&mut head) {
        Ok(()) if head.ends_with(b"200") => 0,
        _ => 1,
    }
}

#[tokio::main]
async fn main() {
    if std::env::args().nth(1).as_deref() == Some("--healthcheck") {
        std::process::exit(healthcheck());
    }
    let Ok(config) = std::env::var("ACCOUNTS_DB") else {
        eprintln!("ACCOUNTS_DB (a Postgres connection string) is not set");
        std::process::exit(2);
    };
    let app = Arc::new(App { db: Db { config, client: RwLock::new(None) }, limits: Limits::default(), hashing: Semaphore::new(HASHING) });
    // The database may still be starting: the schema waits for it.
    loop {
        match app.db.get().await {
            Ok(db) => match db.batch_execute(SCHEMA).await {
                Ok(()) => break,
                Err(e) => eprintln!("schema: {e}"),
            },
            Err(_) => {}
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    // Expired sessions go once an hour
    let sweeper = app.clone();
    tokio::spawn(async move {
        loop {
            if let Ok(db) = sweeper.db.get().await {
                let _ = db.execute("delete from sessions where expires <= now()", &[]).await;
            }
            tokio::time::sleep(Duration::from_secs(3600)).await;
        }
    });
    let listener = match tokio::net::TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], PORT))).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("listen on {PORT}: {e}");
            std::process::exit(1);
        }
    };
    println!("symos-accounts on :{PORT}");
    let stop = async {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM");
        tokio::select! { _ = term.recv() => {}, _ = tokio::signal::ctrl_c() => {} }
    };
    if let Err(e) = axum::serve(listener, router(app)).with_graceful_shutdown(stop).await {
        eprintln!("serve: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_are_trimmed_and_lower_case() {
        assert_eq!(email("  Someone@Example.COM "), Some("someone@example.com".into()));
        for bad in ["", "no-at", "@example.com", "a@nodot", "a@.com", "a b@example.com", "a@example.com."] {
            assert_eq!(email(bad), None, "{bad}");
        }
    }

    #[test]
    fn passwords_devices_and_escrows_are_checked() {
        assert_eq!(check_password("short"), Err(Error::Bad("password-too-short")));
        assert!(check_password("long enough").is_ok());
        assert!(device_id("4c0d2b9e-a1").is_ok());
        assert!(device_id("../etc").is_err());
        assert!(device_id("").is_err());
        assert!(check_escrow("AbC-_+/=").is_ok());
        assert!(check_escrow("not base64!").is_err());
        assert!(check_escrow(&"A".repeat(ESCROW_MAX + 1)).is_err());
    }

    #[test]
    fn attempts_are_limited_per_key_and_window() {
        let limits = Limits::default();
        for _ in 0..3 {
            assert!(limits.allow("in:a", 3, Duration::from_secs(60)));
        }
        assert!(!limits.allow("in:a", 3, Duration::from_secs(60)));
        assert!(limits.allow("in:b", 3, Duration::from_secs(60)));
        // A window that has passed starts again
        assert!(limits.allow("in:a", 3, Duration::ZERO));
    }

    #[test]
    fn only_the_tokens_hash_is_kept() {
        let h = token_hash("abc");
        assert_eq!(h.len(), 32);
        assert_ne!(h, b"abc".to_vec());
    }
}
