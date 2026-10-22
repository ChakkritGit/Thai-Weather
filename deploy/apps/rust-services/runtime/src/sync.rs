//! Party Play protocol 2: JWT-isolated rooms, leases, handoff fencing and SQLite playback.
use crate::util::Locked;
use crate::{checks::millis, playback as p, util};
use axum::{
    Router,
    extract::{
        State,
        ws::{CloseFrame, Message as Ws, WebSocket, WebSocketUpgrade},
    },
    http::{Method, Uri},
    response::{IntoResponse, Response},
    routing::get,
};
use futures_util::{SinkExt, StreamExt};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Notify, mpsc};
const LEASE: i64 = 90_000;
const HEARTBEAT: i64 = 2500;
const HANDOFF: i64 = 2000;
type Db = Arc<Mutex<Connection>>;
#[derive(Clone)]
struct Conn {
    id: String,
    instance: u64,
    send: mpsc::Sender<Ws>,
    abort: Arc<Notify>,
}
impl Conn {
    fn raw(&self, m: Ws) {
        if self.send.try_send(m).is_err() {
            self.abort.notify_one();
        }
    }
    fn send(&self, v: Value) {
        self.raw(Ws::Text(serde_json::to_string(&v).unwrap().into()));
    }
    fn close(&self, code: u16, reason: &'static str) {
        self.raw(Ws::Close(Some(CloseFrame {
            code,
            reason: reason.into(),
        })));
    }
}
struct Device {
    name: String,
    kind: Option<String>,
    seen: i64,
    lease: i64,
    connection: Conn,
    commands: bool,
}
struct Party {
    name: String,
    db: Db,
    wake: Arc<Notify>,
    connections: HashMap<String, Conn>,
    devices: Vec<(String, Device)>,
    room: Value,
    releasing: Option<(String, i64)>,
    pending_commands: Vec<Value>,
    pending_playback: Option<Value>,
    alarm: Option<i64>,
}
impl Party {
    fn new(name: &str, db: Db, wake: Arc<Notify>) -> Result<Self, Box<dyn std::error::Error>> {
        let raw = db
            .locked()
            .query_row(
                "SELECT value FROM kv WHERE room=? AND key='playback'",
                [name],
                |r| r.get::<_, String>(0),
            )
            .optional()?;
        let mut playback = Value::Null;
        if let Some(raw) = raw {
            let v = serde_json::from_str::<Value>(&raw)?;
            if p::valid(&v) {
                playback = v;
                playback["isPlaying"] = json!(false);
                playback["updatedAt"] = json!(millis());
            }
        }
        Ok(Self {
            name: name.into(),
            db,
            wake,
            connections: HashMap::new(),
            devices: Vec::new(),
            room: json!({"type":"room","protocol":2,"revision":0,"transportRevision":0,"positionRevision":0,"controlMode":"snapshots","commandRevision":0,"outputGeneration":0,"devices":[],"outputId":null,"pendingOutputId":null,"playback":playback}),
            releasing: None,
            pending_commands: Vec::new(),
            pending_playback: None,
            alarm: None,
        })
    }
    fn device(&self, id: &str) -> Option<&Device> {
        self.devices.iter().find(|(k, _)| k == id).map(|(_, d)| d)
    }
    fn device_mut(&mut self, id: &str) -> Option<&mut Device> {
        self.devices
            .iter_mut()
            .find(|(k, _)| k == id)
            .map(|(_, d)| d)
    }
    fn selected(&self, key: &str) -> Option<String> {
        self.room[key].as_str().map(str::to_string)
    }
    fn bump(&mut self) -> u64 {
        let n = self.room["revision"].as_u64().unwrap() + 1;
        self.room["revision"] = json!(n);
        n
    }
    fn snapshot(&mut self) -> Ws {
        self.room["serverTime"] = json!(millis());
        Ws::Text(serde_json::to_string(&self.room).unwrap().into())
    }
    fn publish(&mut self) -> Result<(), rusqlite::Error> {
        if !self.room["outputId"].is_null() && self.room["pendingOutputId"].is_null() {
            for c in std::mem::take(&mut self.pending_commands) {
                self.dispatch(&c);
            }
        }
        self.room["devices"] = json!(
            self.devices
                .iter()
                .map(|(id, d)| {
                    let mut v = json!({"id":id,"name":d.name});
                    if let Some(k) = &d.kind {
                        v["kind"] = json!(k);
                    }
                    v
                })
                .collect::<Vec<_>>()
        );
        let wire = self.snapshot();
        for c in self.connections.values() {
            c.raw(wire.clone());
        }
        if !self.room["playback"].is_null() {
            self.db.locked().execute("INSERT INTO kv (room,key,value) VALUES (?,'playback',?) ON CONFLICT(room,key) DO UPDATE SET value=excluded.value",params![self.name,serde_json::to_string(&self.room["playback"]).unwrap()])?;
        }
        if !self.devices.is_empty() || self.releasing.is_some() {
            let next = self
                .releasing
                .as_ref()
                .map_or(millis() + HEARTBEAT, |(_, until)| {
                    (millis() + HEARTBEAT).min(*until)
                });
            if self.alarm.is_none_or(|t| t > next) {
                self.alarm = Some(next);
                self.wake.notify_one();
            }
        }
        Ok(())
    }
    fn select_output(
        &mut self,
        id: Option<String>,
        local: Option<Value>,
    ) -> Result<(), rusqlite::Error> {
        if id == self.selected("outputId") && self.releasing.is_none() {
            return Ok(());
        }
        if self.releasing.is_some() && id == self.selected("pendingOutputId") {
            if local.is_some() {
                self.pending_playback = local;
            }
            return Ok(());
        }
        if id != self.selected("pendingOutputId") {
            self.pending_commands.clear();
        }
        self.pending_playback = local;
        let now = millis();
        if !self.room["playback"].is_null() {
            let pos = if self.releasing.is_some() {
                p::n(&self.room["playback"]["progress"])
            } else {
                p::position(&self.room["playback"], now)
            };
            self.room["playback"]["progress"] = json!(pos);
            self.room["playback"]["updatedAt"] = json!(now);
        }
        if let Some(old) = self.selected("outputId") {
            let until = self
                .device(&old)
                .map_or(now, |d| d.lease)
                .min(now + HANDOFF);
            self.releasing = Some((old, until));
        }
        self.room["outputId"] = Value::Null;
        self.room["pendingOutputId"] = json!(id);
        self.bump();
        if self
            .releasing
            .as_ref()
            .is_none_or(|(_, until)| *until <= now)
        {
            self.finish();
        }
        self.publish()
    }
    fn finish(&mut self) {
        let next = self
            .selected("pendingOutputId")
            .filter(|id| self.device(id).is_some());
        self.room["outputId"] = json!(next);
        if next.is_some()
            && let Some(local) = self.pending_playback.take()
        {
            self.room["playback"] = local;
        }
        self.pending_playback = None;
        if let Some(id) = &next
            && let Some(d) = self.device_mut(id)
        {
            d.lease = millis() + LEASE;
        }
        self.room["pendingOutputId"] = Value::Null;
        self.releasing = None;
        let rev = self.bump();
        self.room["transportRevision"] = json!(rev);
        self.room["positionRevision"] = json!(rev);
        self.room["outputGeneration"] = json!(self.room["outputGeneration"].as_u64().unwrap() + 1);
        self.room["commandRevision"] = json!(0);
        self.room["controlMode"] = json!(if next
            .as_deref()
            .and_then(|id| self.device(id))
            .is_some_and(|d| d.commands)
        {
            "commands"
        } else {
            "snapshots"
        });
        if !self.room["playback"].is_null() {
            let playing = next.is_some() && self.room["playback"]["isPlaying"] == true;
            self.room["playback"]["isPlaying"] = json!(playing);
            self.room["playback"]["updatedAt"] = json!(millis());
        }
    }
    fn dispatch(&mut self, command: &Value) {
        let output = self
            .selected("outputId")
            .and_then(|id| self.device(&id))
            .filter(|d| d.commands)
            .map(|d| d.connection.clone());
        if let Some(output) = output {
            self.room["commandRevision"] =
                json!(self.room["commandRevision"].as_u64().unwrap() + 1);
            self.bump();
            output.send(json!({"type":"player-command","protocol":2,"outputId":self.room["outputId"],"outputGeneration":self.room["outputGeneration"],"revision":self.room["commandRevision"],"command":command}));
            return;
        }
        let base = &self.room["playback"];
        let Some(playback) = p::reduce(base, command, millis()) else {
            return;
        };
        let next = self.room["revision"].as_u64().unwrap() + 1;
        if base.is_null() || !p::queue_command(command) {
            self.room["transportRevision"] = json!(next);
        }
        if self.room["playback"].is_null()
            || ["play", "next", "previous", "seek"]
                .contains(&command["type"].as_str().unwrap_or(""))
        {
            self.room["positionRevision"] = json!(next);
        }
        self.room["playback"] = playback;
        self.bump();
    }
    fn message(&mut self, c: &Conn, m: &Value) -> Result<(), rusqlite::Error> {
        if !m.is_object()
            || self
                .connections
                .get(&c.id)
                .is_none_or(|live| live.instance != c.instance)
        {
            return Ok(());
        }
        let now = millis();
        let kind = m["type"].as_str().unwrap_or("");
        if kind == "hello" && m["protocol"].as_f64() == Some(2.0) && m["name"].is_string() {
            let lease = self.device(&c.id).map_or(0, |d| d.lease);
            let name = String::from_utf16_lossy(
                &m["name"]
                    .as_str()
                    .unwrap()
                    .encode_utf16()
                    .take(80)
                    .collect::<Vec<_>>(),
            );
            let device = Device {
                name,
                kind: m["kind"]
                    .as_str()
                    .filter(|k| ["phone", "tablet", "computer"].contains(k))
                    .map(str::to_string),
                seen: now,
                lease,
                connection: c.clone(),
                commands: m["commands"] == true,
            };
            if let Some(d) = self.device_mut(&c.id) {
                *d = device;
            } else {
                self.devices.push((c.id.clone(), device));
            }
            c.send(json!({"type":"welcome","deviceId":c.id}));
            return self.publish();
        }
        let Some(device) = self.device(&c.id) else {
            return Ok(());
        };
        if device.connection.instance != c.instance {
            return Ok(());
        }
        match kind {
            "heartbeat" if m["sent"].as_f64().is_some_and(f64::is_finite) => {
                let granted = self.room["outputId"] == c.id;
                let d = self.device_mut(&c.id).unwrap();
                d.seen = now;
                if granted {
                    d.lease = now + LEASE;
                }
                c.send(json!({"type":"lease","sent":m["sent"],"leaseMs":LEASE,"revision":self.room["revision"],"granted":granted}));
            }
            "detach"
                if self.room["outputId"] == c.id
                    || self.room["pendingOutputId"] == c.id
                    || self.releasing.as_ref().is_some_and(|(id, _)| id == &c.id) =>
            {
                if self.room["outputId"] == c.id {
                    self.device_mut(&c.id).unwrap().lease = 0;
                    return self.select_output(None, None);
                }
                if self.releasing.as_ref().is_some_and(|(id, _)| id == &c.id) {
                    self.finish();
                } else {
                    return self.select_output(None, None);
                }
                self.publish()?;
            }
            "output" if m["id"].as_str().is_some_and(|id| self.device(id).is_some()) => {
                if (self.room["playback"].is_null()
                    || (self.room["outputId"].is_null() && self.room["pendingOutputId"].is_null()))
                    && p::valid(&m["seed"])
                {
                    self.room["playback"] = m["seed"].clone();
                    self.room["playback"]["updatedAt"] = json!(now);
                }
                let local = if m["adoptLocal"] == true && m["id"] == c.id && p::valid(&m["seed"]) {
                    let mut p = m["seed"].clone();
                    p["updatedAt"] = json!(now);
                    Some(p)
                } else {
                    None
                };
                self.select_output(m["id"].as_str().map(str::to_string), local)?;
            }
            "released"
                if self.releasing.as_ref().is_some_and(|(id, _)| id == &c.id)
                    && m["revision"].as_f64() == self.room["revision"].as_f64() =>
            {
                self.finish();
                self.publish()?;
            }
            "command" if p::valid_command(&m["command"]) => {
                if self.room["outputId"].is_null() && self.room["pendingOutputId"].is_null() {
                    self.select_output(Some(c.id.clone()), None)?;
                }
                if !self.room["pendingOutputId"].is_null() {
                    if self.pending_commands.len() < 100 {
                        self.pending_commands.push(m["command"].clone());
                    }
                    return Ok(());
                }
                self.dispatch(&m["command"]);
                self.publish()?;
            }
            "report" if self.room["outputId"] == c.id && p::valid(&m["playback"]) => {
                let commands = self.device(&c.id).unwrap().commands;
                let stale = if commands {
                    m["outputGeneration"].as_f64() != self.room["outputGeneration"].as_f64()
                        || m["commandRevision"].as_f64() != self.room["commandRevision"].as_f64()
                } else {
                    m["revision"].as_f64() != self.room["revision"].as_f64()
                };
                if !stale {
                    self.room["playback"] = m["playback"].clone();
                    self.room["playback"]["updatedAt"] = json!(now);
                    self.publish()?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    fn close(&mut self, c: &Conn) -> Result<(), rusqlite::Error> {
        if self
            .connections
            .get(&c.id)
            .is_some_and(|x| x.instance == c.instance)
        {
            self.connections.remove(&c.id);
        }
        if self
            .device(&c.id)
            .is_none_or(|d| d.connection.instance != c.instance)
        {
            return Ok(());
        }
        self.devices.retain(|(id, _)| id != &c.id);
        if self.room["outputId"] == c.id || self.room["pendingOutputId"] == c.id {
            return self.select_output(None, None);
        }
        if self.releasing.as_ref().is_some_and(|(id, _)| id == &c.id) {
            self.finish();
        }
        self.publish()
    }
    fn on_alarm(&mut self) -> Result<(), rusqlite::Error> {
        let now = millis();
        let mut changed = false;
        let ids = self
            .devices
            .iter()
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in ids {
            let Some(d) = self.device(&id) else {
                continue;
            };
            let deadline = if self.room["outputId"] == id
                || self.releasing.as_ref().is_some_and(|(x, _)| x == &id)
            {
                d.lease
            } else {
                d.seen + LEASE
            };
            let connection = d.connection.clone();
            if now >= deadline {
                if self.room["outputId"] == id {
                    self.select_output(None, None)?;
                }
                self.devices.retain(|(x, _)| x != &id);
                connection.close(4000, "Heartbeat expired");
                changed = true;
            } else {
                connection.send(json!({"type":"heartbeat-request"}));
            }
        }
        if self
            .releasing
            .as_ref()
            .is_some_and(|(_, until)| now >= *until)
        {
            self.finish();
            changed = true;
        }
        if changed {
            self.publish()?;
        } else if !self.devices.is_empty() || self.releasing.is_some() {
            self.alarm = Some(
                self.releasing
                    .as_ref()
                    .map_or(now + HEARTBEAT, |(_, until)| (now + HEARTBEAT).min(*until)),
            );
            self.wake.notify_one();
        }
        Ok(())
    }
}
const MAX_PEERS: usize = 32; // devices in one party; a token is needed to join, this caps a leaked one
struct Hub {
    db: Db,
    secret: String,
    rooms: Mutex<HashMap<String, Arc<Mutex<Party>>>>,
    wake: Arc<Notify>,
    next: AtomicU64,
    readonly: bool,
}
impl Hub {
    fn release(&self, name: &str) {
        let mut rooms = self.rooms.locked();
        let Some(r) = rooms.get(name).cloned() else {
            return;
        };
        let r = r.locked();
        if r.connections.is_empty() && r.alarm.is_none() {
            rooms.remove(name);
        }
    }
    fn join(&self, name: &str, c: &Conn) -> Result<Arc<Mutex<Party>>, Box<dyn std::error::Error>> {
        let mut rooms = self.rooms.locked();
        let r = if let Some(r) = rooms.get(name) {
            r.clone()
        } else {
            let r = Arc::new(Mutex::new(Party::new(
                name,
                self.db.clone(),
                self.wake.clone(),
            )?));
            rooms.insert(name.into(), r.clone());
            r
        };
        {
            let mut p = r.locked();
            if p.connections.len() >= MAX_PEERS && !p.connections.contains_key(&c.id) {
                return Err("party is full".into());
            }
            p.connections.insert(c.id.clone(), c.clone());
            c.raw(p.snapshot());
        }
        Ok(r)
    }
    fn authorized(&self, token: &str, name: &str) -> bool {
        if self.secret.is_empty() {
            return false;
        }
        let mut validation = Validation::new(Algorithm::HS256);
        validation.required_spec_claims.clear();
        validation.validate_aud = false;
        validation.validate_exp = false;
        validation.leeway = 0;
        let Ok(data) = decode::<Value>(
            token,
            &DecodingKey::from_secret(self.secret.as_bytes()),
            &validation,
        ) else {
            return false;
        };
        let v = data.claims;
        let now = millis() as f64 / 1000.0;
        v["sub"] == name
            && ["exp", "nbf", "iat"]
                .iter()
                .all(|k| v.get(k).is_none_or(Value::is_number))
            && v.get("exp")
                .is_none_or(|v| v.as_f64().is_some_and(|t| t > now.floor()))
            && v.get("nbf")
                .is_none_or(|v| v.as_f64().is_some_and(|t| t <= now.floor()))
    }
}
async fn socket(ws: WebSocket, hub: Arc<Hub>, name: String, id: String) {
    let (tx, mut rx) = mpsc::channel(64);
    let abort = Arc::new(Notify::new());
    let c = Conn {
        id,
        instance: hub.next.fetch_add(1, Ordering::Relaxed),
        send: tx,
        abort: abort.clone(),
    };
    let joined = hub.join(&name, &c).ok();
    let room = match joined {
        Some(r) => r,
        None => {
            let mut ws = ws;
            let _ = ws
                .send(Ws::Close(Some(CloseFrame {
                    code: 1011,
                    reason: "Storage unavailable".into(),
                })))
                .await;
            return;
        }
    };
    let (mut sink, mut stream) = ws.split();
    loop {
        tokio::select! {biased;
        _=abort.notified()=>{let _=sink.send(Ws::Close(Some(CloseFrame{code:1009,reason:"Slow client".into()}))).await;break;},
        message=rx.recv()=>{let Some(m)=message else{break;};let closing=matches!(m,Ws::Close(_));if sink.send(m).await.is_err()||closing{break;}},
        message=stream.next()=>{match message{Some(Ok(Ws::Text(text)))=>{if text.encode_utf16().count()<=2_000_000&&let Ok(m)=serde_json::from_str::<Value>(text.as_str())&&room.locked().message(&c,&m).is_err(){eprintln!("sync persistence failed");}},Some(Ok(Ws::Ping(b)))=>{if sink.send(Ws::Pong(b)).await.is_err(){break;}},Some(Ok(Ws::Binary(_)|Ws::Pong(_)))=>{},_=>break}}
        }
    }
    if room.locked().close(&c).is_err() {
        eprintln!("sync close persistence failed");
    }
    hub.release(&name);
}
async fn upgrade(
    State(hub): State<Arc<Hub>>,
    method: Method,
    uri: Uri,
    ws: Result<WebSocketUpgrade, axum::extract::ws::rejection::WebSocketUpgradeRejection>,
) -> Response {
    if method != Method::GET {
        return util::text(404, "NOT_FOUND");
    }
    let Some(raw) = uri
        .path()
        .trim_end_matches('/')
        .strip_prefix("/parties/sync-server/")
        .filter(|s| !s.is_empty() && !s.contains('/'))
    else {
        return util::text(404, "NOT_FOUND");
    };
    if hub.readonly {
        return util::text(503, "read only");
    }
    let Ok(name) = percent_encoding::percent_decode_str(raw).decode_utf8() else {
        return util::text(401, "Unauthorized");
    };
    let query = url::form_urlencoded::parse(uri.query().unwrap_or("").as_bytes())
        .into_owned()
        .collect::<HashMap<_, _>>();
    if !hub.authorized(query.get("token").map_or("", String::as_str), &name) {
        return util::text(401, "Unauthorized");
    }
    let Ok(ws) = ws else {
        return util::text(400, "BAD_REQUEST");
    };
    let id = query
        .get("_pk")
        .filter(|s| !s.is_empty())
        .cloned()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let name = name.into_owned();
    ws.max_message_size(16 * 1024 * 1024)
        .on_upgrade(move |ws| socket(ws, hub, name, id))
        .into_response()
}
async fn health(State(hub): State<Arc<Hub>>) -> Response {
    let ok = !hub.secret.is_empty();
    let mut r = util::json(
        if ok { 200 } else { 503 },
        json!({"status":if ok{"ok"}else{"degraded"},"service":"drive-music-sync","protocol":2}),
    );
    r.headers_mut().insert(
        "cache-control",
        axum::http::HeaderValue::from_static("no-store"),
    );
    r
}
// Only the session-verifying Next server may request a Party Play token. Never trust browser account input.
async fn issue_token(
    State(hub): State<Arc<Hub>>,
    headers: axum::http::HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    if hub.secret.is_empty() || hub.readonly {
        return util::json(503, json!({"error":"Sync is not configured"}));
    }
    if !util::secret(
        headers
            .get("x-sync-secret")
            .and_then(|v| v.to_str().ok())
            .unwrap_or(""),
        &hub.secret,
    ) {
        return util::json(403, json!({"error":"Forbidden"}));
    }
    let v = serde_json::from_slice::<Value>(&body).unwrap_or(Value::Null);
    let Some(account) = v["account"]
        .as_str()
        .filter(|s| !s.is_empty() && s.encode_utf16().count() <= 4096)
    else {
        return util::json(400, json!({"error":"Invalid account"}));
    };
    use sha2::{Digest, Sha256};
    let room_id = format!(
        "{:x}",
        Sha256::digest(account.trim().to_lowercase().as_bytes())
    );
    let now = millis() / 1000;
    let header = jsonwebtoken::Header {
        typ: None,
        ..jsonwebtoken::Header::new(Algorithm::HS256)
    };
    let Ok(token) = jsonwebtoken::encode(
        &header,
        &json!({"sub":room_id,"iat":now,"exp":now+300}),
        &jsonwebtoken::EncodingKey::from_secret(hub.secret.as_bytes()),
    ) else {
        return util::json(500, json!({"error":"Internal server error"}));
    };
    let mut r = util::json(200, json!({"token":token,"roomId":room_id}));
    r.headers_mut()
        .insert("cache-control", "private, no-store".parse().unwrap());
    r
}
pub fn router() -> Result<Router, Box<dyn std::error::Error>> {
    let readonly = util::env("SYNC_READ_ONLY", "") == "true";
    let path = util::env("SYNC_DB", "/data/sync.db");
    let db = if readonly {
        Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?
    } else {
        Connection::open(path)?
    };
    db.busy_timeout(Duration::from_secs(5))?;
    if !readonly {
        db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS kv (room TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(room,key));")?;
    }
    let hub = Arc::new(Hub {
        db: Arc::new(Mutex::new(db)),
        secret: util::env("PARTY_TOKEN_SECRET", ""),
        rooms: Mutex::new(HashMap::new()),
        wake: Arc::new(Notify::new()),
        next: AtomicU64::new(1),
        readonly,
    });
    let h = hub.clone();
    tokio::spawn(async move {
        loop {
            let notified = h.wake.notified();
            let rooms = h
                .rooms
                .locked()
                .iter()
                .map(|(n, r)| (n.clone(), r.clone()))
                .collect::<Vec<_>>();
            let now = millis();
            let mut next: Option<i64> = None;
            for (name, r) in rooms {
                {
                    let mut p = r.locked();
                    if p.alarm.is_some_and(|at| at <= now) {
                        p.alarm = None;
                        if p.on_alarm().is_err() {
                            eprintln!("sync alarm persistence failed");
                        }
                    }
                    if let Some(at) = p.alarm {
                        next = Some(next.map_or(at, |n| n.min(at)));
                    }
                }
                h.release(&name);
            }
            if let Some(at) = next {
                tokio::select! {_=tokio::time::sleep(Duration::from_millis((at-millis()).max(0) as u64))=>{},_=notified=>{}}
            } else {
                notified.await;
            }
        }
    });
    Ok(Router::new()
        .route("/internal/token", axum::routing::post(issue_token))
        .route("/health", get(health))
        .route("/health/", get(health))
        .fallback(upgrade)
        .with_state(hub))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn expired_output_releases_and_stale_socket_cannot_rejoin() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE kv(room TEXT,key TEXT,value TEXT,PRIMARY KEY(room,key));")
            .unwrap();
        let mut p =
            Party::new("fixture", Arc::new(Mutex::new(db)), Arc::new(Notify::new())).unwrap();
        let (tx, _rx) = mpsc::channel(64);
        let old = Conn {
            id: "device".into(),
            instance: 1,
            send: tx,
            abort: Arc::new(Notify::new()),
        };
        p.connections.insert(old.id.clone(), old.clone());
        p.message(
            &old,
            &json!({"type":"hello","protocol":2,"name":"Original"}),
        )
        .unwrap();
        p.select_output(Some(old.id.clone()), None).unwrap();
        p.device_mut("device").unwrap().lease = millis() - 1;
        p.on_alarm().unwrap();
        assert!(p.room["outputId"].is_null());
        assert!(p.devices.is_empty());
        let mut replacement = old.clone();
        replacement.instance = 2;
        p.connections.insert(old.id.clone(), replacement.clone());
        p.message(
            &replacement,
            &json!({"type":"hello","protocol":2,"name":"Replacement"}),
        )
        .unwrap();
        p.message(&old, &json!({"type":"hello","protocol":2,"name":"Stale"}))
            .unwrap();
        assert_eq!(p.device("device").unwrap().name, "Replacement");
    }
}
