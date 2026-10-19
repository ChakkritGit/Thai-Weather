//! Yjs v1 wire-compatible relay. Empty rooms and cursor ownership stay ephemeral.
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
        atomic::{AtomicU64, Ordering},
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
struct Connection {
    send: mpsc::Sender<Ws>,
    clients: HashSet<u64>,
}
type Connections = Arc<Mutex<HashMap<u64, Connection>>>;
struct Room {
    awareness: Awareness,
    connections: Connections,
    origin: Arc<AtomicU64>,
    _doc_sub: Subscription,
    _awareness_sub: Subscription,
}
fn broadcast(conns: &Connections, data: Vec<u8>, except: u64) {
    let data = Ws::Binary(data.into());
    conns
        .lock()
        .unwrap()
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
                let mut conns = cs.lock().unwrap();
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
            _doc_sub: doc_sub,
            _awareness_sub: awareness_sub,
        }
    }
    fn input(&self, id: u64, data: &[u8]) -> Result<(), ()> {
        let (tag, _) = varint(data).ok_or(())?;
        if tag > 1 {
            return Ok(());
        }
        let mut decoder = DecoderV1::new(Cursor::new(data));
        let message = Message::decode(&mut decoder).map_err(|_| ())?;
        self.origin.store(id, Ordering::Relaxed);
        let result = DefaultProtocol
            .handle_message(&self.awareness, message)
            .map_err(|_| ());
        self.origin.store(0, Ordering::Relaxed);
        if let Some(response) = result?
            && let Some(c) = self.connections.lock().unwrap().get(&id)
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
    next: AtomicU64,
    prefix: String,
}
impl Hub {
    fn join(&self, name: &str, id: u64, send: mpsc::Sender<Ws>) -> Arc<Mutex<Room>> {
        let mut rooms = self.rooms.lock().unwrap();
        let room = rooms
            .entry(name.into())
            .or_insert_with(|| Arc::new(Mutex::new(Room::new())))
            .clone();
        let r = room.lock().unwrap();
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
        r.connections.lock().unwrap().insert(
            id,
            Connection {
                send,
                clients: HashSet::new(),
            },
        );
        drop(r);
        room
    }
    fn leave(&self, name: &str, id: u64) {
        let mut rooms = self.rooms.lock().unwrap();
        let Some(room) = rooms.get(name).cloned() else {
            return;
        };
        let r = room.lock().unwrap();
        let conn = r.connections.lock().unwrap().remove(&id);
        if let Some(conn) = conn {
            for client in conn.clients {
                r.awareness.remove_state(client);
            }
        }
        if r.connections.lock().unwrap().is_empty() {
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
    let room = hub.join(&name, id, send);
    let (mut sink, mut stream) = ws.split();
    loop {
        tokio::select! {
         outgoing=messages.recv()=>{let Some(message)=outgoing else{break;};if sink.send(message).await.is_err(){break;}}
         incoming=stream.next()=>{match incoming{Some(Ok(Ws::Binary(data)))=>{let ok=room.lock().unwrap().input(id,&data).is_ok();if !ok{hub.leave(&name,id);let _=sink.send(Ws::Close(Some(CloseFrame{code:1003,reason:"bad message".into()}))).await;break;}},Some(Ok(Ws::Text(data)))=>{let ok=room.lock().unwrap().input(id,data.as_bytes()).is_ok();if !ok{hub.leave(&name,id);let _=sink.send(Ws::Close(Some(CloseFrame{code:1003,reason:"bad message".into()}))).await;break;}},Some(Ok(Ws::Ping(data)))=>{if sink.send(Ws::Pong(data)).await.is_err(){break;}},Some(Ok(Ws::Pong(_)))=>{},_=>break}}
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
    ws.max_message_size(16 * 1024 * 1024)
        .on_upgrade(move |ws| connection(ws, hub, name))
        .into_response()
}
async fn health(State(hub): State<Arc<Hub>>) -> Response {
    axum::http::Response::builder()
        .status(200)
        .header("content-type", "text/plain")
        .header("x-open-rooms", hub.rooms.lock().unwrap().len().to_string())
        .body(axum::body::Body::from("ok\n"))
        .unwrap()
}
pub fn router() -> Router {
    let hub = Arc::new(Hub {
        rooms: Mutex::new(HashMap::new()),
        next: AtomicU64::new(1),
        prefix: util::env("PATH_PREFIX", "").trim_end_matches('/').into(),
    });
    let h = hub.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(3)).await;
            let rooms = h
                .rooms
                .lock()
                .unwrap()
                .values()
                .cloned()
                .collect::<Vec<_>>();
            for r in rooms {
                r.lock().unwrap().expire();
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
    }
}
