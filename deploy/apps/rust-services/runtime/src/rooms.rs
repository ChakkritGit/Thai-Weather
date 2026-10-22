//! Yjs v1 wire-compatible relay. Empty rooms and cursor ownership stay ephemeral.
use crate::util::Locked;
use crate::{checks::millis, util};
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
use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::mpsc;
use yrs::{
    Doc, ReadTxn, Subscription, Transact,
    encoding::read::Cursor,
    sync::{
        Awareness,
        protocol::{DefaultProtocol, Message, Protocol, SyncMessage},
    },
    updates::decoder::DecoderV1,
    updates::{decoder::Decode, encoder::Encode},
};
// Rooms are public and in memory, so they are capped: a client that floods one cannot grow it (or
// the process) without bound. Only document updates count towards the byte budgets, not cursors.
const MAX_ROOMS: usize = 1000;
const MAX_PEERS: usize = 64;
const MAX_NAME: usize = 256;
const ROOM_BYTES: usize = 64 << 20;
const TOTAL_BYTES: usize = 1 << 30;
const MAX_MESSAGE: usize = 16 << 20;
struct Connection {
    send: mpsc::Sender<Ws>,
    clients: HashSet<u64>,
}
type Connections = Arc<Mutex<HashMap<u64, Connection>>>;
struct Room {
    awareness: Awareness,
    connections: Connections,
    origin: Arc<AtomicU64>,
    bytes: usize,
    _doc_sub: Subscription,
    _awareness_sub: Subscription,
}
fn broadcast(conns: &Connections, data: Vec<u8>, except: u64) {
    let data = Ws::Binary(data.into());
    conns
        .locked()
        .retain(|id, c| *id == except || c.send.try_send(data.clone()).is_ok());
}
impl Room {
    fn new() -> Self {
        let connections: Connections = Arc::new(Mutex::new(HashMap::new()));
        let origin = Arc::new(AtomicU64::new(0));
        let doc = Doc::new();
        let cs = connections.clone();
        let sender = origin.clone();
        let doc_sub = doc
            .observe_update_v1(move |_, event| {
                broadcast(
                    &cs,
                    Message::Sync(SyncMessage::Update(event.update.clone())).encode_v1(),
                    sender.load(Ordering::Relaxed),
                )
            })
            .expect("document observer");
        let awareness = Awareness::new(doc);
        let cs = connections.clone();
        let sender = origin.clone();
        let awareness_sub = awareness.on_update(move |awareness, event, _| {
            let id = sender.load(Ordering::Relaxed);
            {
                let mut conns = cs.locked();
                if let Some(c) = conns.get_mut(&id) {
                    c.clients
                        .extend(event.added().iter().chain(event.updated()).copied());
                    for client in event.removed() {
                        c.clients.remove(client);
                    }
                }
            }
            let clients = event
                .added()
                .iter()
                .chain(event.updated())
                .chain(event.removed())
                .copied();
            if let Ok(update) = awareness.update_with_clients(clients) {
                broadcast(&cs, Message::Awareness(update).encode_v1(), id);
            }
        });
        Self {
            awareness,
            connections,
            origin,
            bytes: 0,
            _doc_sub: doc_sub,
            _awareness_sub: awareness_sub,
        }
    }
    fn input(&mut self, id: u64, data: &[u8], total: &AtomicUsize) -> Result<(), ()> {
        let (tag, _) = varint(data).ok_or(())?;
        if tag > 1 {
            return Ok(());
        }
        if tag == 0 {
            let n = data.len();
            if self.bytes + n > ROOM_BYTES {
                return Err(());
            }
            if total.fetch_add(n, Ordering::Relaxed) + n > TOTAL_BYTES {
                total.fetch_sub(n, Ordering::Relaxed);
                return Err(());
            }
            self.bytes += n;
        }
        let mut decoder = DecoderV1::new(Cursor::new(data));
        let message = Message::decode(&mut decoder).map_err(|_| ())?;
        self.origin.store(id, Ordering::Relaxed);
        let result = DefaultProtocol
            .handle_message(&self.awareness, message)
            .map_err(|_| ());
        self.origin.store(0, Ordering::Relaxed);
        if let Some(response) = result?
            && let Some(c) = self.connections.locked().get(&id)
        {
            let _ = c.send.try_send(Ws::Binary(response.encode_v1().into()));
        }
        Ok(())
    }
    fn expire(&self) {
        let now = millis() as u64;
        let stale = self
            .awareness
            .iter()
            .filter(|(_, s)| s.data.is_some() && now.saturating_sub(s.last_updated) >= 30_000)
            .map(|(id, _)| id)
            .collect::<Vec<_>>();
        for id in stale {
            self.awareness.remove_state(id);
        }
    }
}
struct Hub {
    rooms: Mutex<HashMap<String, Arc<Mutex<Room>>>>,
    bytes: AtomicUsize,
    next: AtomicU64,
    prefix: String,
}
impl Hub {
    fn join(&self, name: &str, id: u64, send: mpsc::Sender<Ws>) -> Option<Arc<Mutex<Room>>> {
        let mut rooms = self.rooms.locked();
        if !rooms.contains_key(name) && rooms.len() >= MAX_ROOMS {
            return None;
        }
        let room = rooms
            .entry(name.into())
            .or_insert_with(|| Arc::new(Mutex::new(Room::new())))
            .clone();
        let r = room.locked();
        if r.connections.locked().len() >= MAX_PEERS {
            return None;
        }
        let hello = Message::Sync(SyncMessage::SyncStep1(
            r.awareness.doc().transact().state_vector(),
        ))
        .encode_v1();
        let _ = send.try_send(Ws::Binary(hello.into()));
        if r.awareness.iter().any(|(_, s)| s.data.is_some())
            && let Ok(update) = r.awareness.update()
        {
            let _ = send.try_send(Ws::Binary(Message::Awareness(update).encode_v1().into()));
        }
        r.connections.locked().insert(
            id,
            Connection {
                send,
                clients: HashSet::new(),
            },
        );
        drop(r);
        Some(room)
    }
    fn leave(&self, name: &str, id: u64) {
        let mut rooms = self.rooms.locked();
        let Some(room) = rooms.get(name).cloned() else {
            return;
        };
        let r = room.locked();
        let conn = r.connections.locked().remove(&id);
        if let Some(conn) = conn {
            for client in conn.clients {
                r.awareness.remove_state(client);
            }
        }
        if r.connections.locked().is_empty() {
            self.bytes.fetch_sub(r.bytes, Ordering::Relaxed);
            rooms.remove(name);
        }
    }
}
fn varint(data: &[u8]) -> Option<(u64, usize)> {
    let mut v = 0u64;
    for (i, &b) in data.iter().take(10).enumerate() {
        if i == 9 && b > 1 {
            return None;
        }
        v |= ((b & 127) as u64) << (7 * i);
        if b < 128 {
            return Some((v, i + 1));
        }
    }
    None
}
fn room_name(path: &str, prefix: &str) -> Option<String> {
    let path = if !prefix.is_empty() && (path == prefix || path.starts_with(&format!("{prefix}/")))
    {
        &path[prefix.len()..]
    } else {
        path
    };
    let path = path.get(1..).unwrap_or("");
    let b = path.as_bytes();
    for i in 0..b.len() {
        if b[i] == b'%'
            && (i + 2 >= b.len() || !b[i + 1].is_ascii_hexdigit() || !b[i + 2].is_ascii_hexdigit())
        {
            return None;
        }
    }
    let name = percent_encoding::percent_decode_str(path)
        .decode_utf8()
        .ok()?;
    if name.len() > MAX_NAME {
        return None;
    }
    Some(if name.is_empty() {
        "default".into()
    } else {
        name.into_owned()
    })
}
async fn connection(mut ws: WebSocket, hub: Arc<Hub>, name: Option<String>) {
    let Some(name) = name else {
        let _ = ws
            .send(Ws::Close(Some(CloseFrame {
                code: 1008,
                reason: "bad room".into(),
            })))
            .await;
        return;
    };
    let id = hub.next.fetch_add(1, Ordering::Relaxed);
    let (send, mut messages) = mpsc::channel(32);
    let Some(room) = hub.join(&name, id, send) else {
        let _ = ws
            .send(Ws::Close(Some(CloseFrame {
                code: 1013,
                reason: "room limit".into(),
            })))
            .await;
        return;
    };
    let (mut sink, mut stream) = ws.split();
    loop {
        tokio::select! {
         outgoing=messages.recv()=>{let Some(message)=outgoing else{break;};if sink.send(message).await.is_err(){break;}}
         incoming=stream.next()=>{match incoming{Some(Ok(Ws::Binary(data)))=>{let ok=room.locked().input(id,&data,&hub.bytes).is_ok();if !ok{hub.leave(&name,id);let _=sink.send(Ws::Close(Some(CloseFrame{code:1003,reason:"bad message".into()}))).await;break;}},Some(Ok(Ws::Text(data)))=>{let ok=room.locked().input(id,data.as_bytes(),&hub.bytes).is_ok();if !ok{hub.leave(&name,id);let _=sink.send(Ws::Close(Some(CloseFrame{code:1003,reason:"bad message".into()}))).await;break;}},Some(Ok(Ws::Ping(data)))=>{if sink.send(Ws::Pong(data)).await.is_err(){break;}},Some(Ok(Ws::Pong(_)))=>{},_=>break}}
        }
    }
    hub.leave(&name, id);
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
    let Ok(ws) = ws else {
        return util::text(400, "BAD_REQUEST");
    };
    let name = room_name(uri.path(), &hub.prefix);
    ws.max_message_size(MAX_MESSAGE)
        .on_upgrade(move |ws| connection(ws, hub, name))
        .into_response()
}
async fn health(State(hub): State<Arc<Hub>>) -> Response {
    axum::http::Response::builder()
        .status(200)
        .header("content-type", "text/plain")
        .header("x-open-rooms", hub.rooms.locked().len().to_string())
        .body(axum::body::Body::from("ok\n"))
        .unwrap()
}
pub fn router() -> Router {
    let hub = Arc::new(Hub {
        rooms: Mutex::new(HashMap::new()),
        bytes: AtomicUsize::new(0),
        next: AtomicU64::new(1),
        prefix: util::env("PATH_PREFIX", "").trim_end_matches('/').into(),
    });
    let h = hub.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(3)).await;
            let rooms = h.rooms.locked().values().cloned().collect::<Vec<_>>();
            for r in rooms {
                r.locked().expire();
            }
        }
    });
    Router::new()
        .route("/__health", get(health))
        .route("/__health/", get(health))
        .fallback(upgrade)
        .with_state(hub)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn names_and_varints() {
        assert_eq!(room_name("/rooms/a%20b", "/rooms"), Some("a b".into()));
        assert_eq!(room_name("/a%20b", "/rooms"), Some("a b".into()));
        assert_eq!(room_name("/", "/rooms"), Some("default".into()));
        assert_eq!(room_name("/rooms/a%ff", "/rooms"), None);
        assert_eq!(room_name("/a%", ""), None);
        assert_eq!(varint(&[128]), None);
        assert_eq!(
            room_name(&format!("/{}", "a".repeat(MAX_NAME + 1)), ""),
            None
        );
    }
    #[test]
    fn document_bytes_are_capped_per_room_and_in_total() {
        let total = AtomicUsize::new(0);
        let mut room = Room::new();
        // a sync step 1 with an empty state vector: tag 0 (sync), sub-tag 0, then a 1-byte vector
        let step1 = [0u8, 0, 1, 0];
        assert!(room.input(1, &step1, &total).is_ok());
        assert_eq!((room.bytes, total.load(Ordering::Relaxed)), (4, 4));
        room.bytes = ROOM_BYTES - 3;
        assert!(room.input(1, &step1, &total).is_err());
        room.bytes = 0;
        total.store(TOTAL_BYTES - 3, Ordering::Relaxed);
        assert!(room.input(1, &step1, &total).is_err());
        assert_eq!(total.load(Ordering::Relaxed), TOTAL_BYTES - 3);
        // awareness (cursor) messages never count
        total.store(0, Ordering::Relaxed);
        let _ = room.input(1, &[1u8, 1, 0], &total);
        assert_eq!(total.load(Ordering::Relaxed), 0);
    }
}
