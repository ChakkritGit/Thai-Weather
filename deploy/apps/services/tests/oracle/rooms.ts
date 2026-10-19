/**
 * Whiteboard rooms – the Yjs relay that replaced the `whiteboard-rooms` Durable Object.
 *
 * Same protocol as the Worker and the repo's scripts/server.mjs: a room is the URL path, the server
 * keeps one Y.Doc + awareness per room while anyone is connected, relays sync/awareness messages and
 * withdraws a socket's cursors the moment it leaves. Boards live in the browsers (IndexedDB), so an
 * empty room is dropped.
 */
import { Elysia } from 'elysia'
import * as Y from 'yjs'
import * as sync from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1
const PORT = Number(process.env.PORT ?? 8787)
// Served on the whiteboard's own host as wss://whiteboard.chakkritton.com/rooms/<room>: the proxy
// passes the path through untouched (no re-encoding of room names) and the prefix is dropped here.
const PREFIX = (process.env.PATH_PREFIX ?? '').replace(/\/+$/, '')

type Sock = { id: string; send(data: Uint8Array): unknown; close(code?: number, reason?: string): unknown }
type Room = { doc: Y.Doc; awareness: awarenessProtocol.Awareness; conns: Map<string, { ws: Sock; clients: Set<number> }> }

const rooms = new Map<string, Room>()
const socketRoom = new Map<string, string>()

function broadcast(room: Room, payload: Uint8Array, exceptId: unknown) {
  for (const [id, c] of room.conns) {
    if (id === exceptId) continue // they already have it
    try {
      c.ws.send(payload)
    } catch {
      room.conns.delete(id)
    }
  }
}

function getRoom(name: string): Room {
  let room = rooms.get(name)
  if (room) return room
  const doc = new Y.Doc()
  const awareness = new awarenessProtocol.Awareness(doc)
  awareness.setLocalState(null)
  room = { doc, awareness, conns: new Map() }
  const r = room
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    const m = encoding.createEncoder()
    encoding.writeVarUint(m, MESSAGE_SYNC)
    sync.writeUpdate(m, update)
    broadcast(r, encoding.toUint8Array(m), origin)
  })
  awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    const owned = r.conns.get(origin as string)
    if (owned) {
      // a state that was removed and set again arrives as `updated`, not `added`
      added.concat(updated).forEach((c) => owned.clients.add(c))
      removed.forEach((c) => owned.clients.delete(c))
    }
    const m = encoding.createEncoder()
    encoding.writeVarUint(m, MESSAGE_AWARENESS)
    encoding.writeVarUint8Array(m, awarenessProtocol.encodeAwarenessUpdate(r.awareness, added.concat(updated, removed)))
    broadcast(r, encoding.toUint8Array(m), origin)
  })
  rooms.set(name, room)
  return room
}

function leave(id: string) {
  const name = socketRoom.get(id)
  socketRoom.delete(id)
  const room = name === undefined ? undefined : rooms.get(name)
  if (!room) return
  const owned = room.conns.get(id)
  room.conns.delete(id)
  // withdraw this socket's cursors at once (otherwise a refresh shows two of you for 30 s)
  if (owned && owned.clients.size > 0) awarenessProtocol.removeAwarenessStates(room.awareness, Array.from(owned.clients), null)
  if (room.conns.size === 0) {
    room.doc.destroy()
    rooms.delete(name!)
  }
}

function roomName(path: string): string | null {
  if (PREFIX && (path === PREFIX || path.startsWith(PREFIX + '/'))) path = path.slice(PREFIX.length)
  try {
    return decodeURIComponent(path.slice(1)) || 'default'
  } catch {
    return null
  }
}

export const app = new Elysia()
  // the status page's probe: no socket needed. (No catch-all GET: it would take the WebSocket
  // upgrade requests, which are GETs too, away from the ws route.)
  .get('/__health', () => new Response('ok\n', { headers: { 'content-type': 'text/plain', 'x-open-rooms': String(rooms.size) } }))
  .ws('/*', {
    open(ws) {
      const name = roomName(new URL(ws.data.request.url).pathname)
      if (name === null) return ws.close(1008, 'bad room')
      const room = getRoom(name)
      // Bun's own socket: Elysia's ws.send JSON-encodes objects, which turns a Uint8Array into garbage
      const sock = ws.raw as unknown as Sock
      room.conns.set(ws.id, { ws: sock, clients: new Set() })
      socketRoom.set(ws.id, name)
      // our half of the handshake: here is what I have, send me what I am missing
      const hello = encoding.createEncoder()
      encoding.writeVarUint(hello, MESSAGE_SYNC)
      sync.writeSyncStep1(hello, room.doc)
      sock.send(encoding.toUint8Array(hello))
      const states = room.awareness.getStates()
      if (states.size > 0) {
        const m = encoding.createEncoder()
        encoding.writeVarUint(m, MESSAGE_AWARENESS)
        encoding.writeVarUint8Array(m, awarenessProtocol.encodeAwarenessUpdate(room.awareness, Array.from(states.keys())))
        sock.send(encoding.toUint8Array(m))
      }
    },
    message(ws, raw) {
      const room = rooms.get(socketRoom.get(ws.id) ?? '')
      if (!room) return
      // garbage bytes make the decoders throw; never let that take the room down
      try {
        const bytes =
          raw instanceof Uint8Array ? raw : typeof raw === 'string' ? new TextEncoder().encode(raw) : new Uint8Array(raw as ArrayBuffer)
        const decoder = decoding.createDecoder(bytes)
        const encoder = encoding.createEncoder()
        switch (decoding.readVarUint(decoder)) {
          case MESSAGE_SYNC:
            encoding.writeVarUint(encoder, MESSAGE_SYNC)
            sync.readSyncMessage(decoder, encoder, room.doc, ws.id)
            if (encoding.length(encoder) > 1) ws.raw.send(encoding.toUint8Array(encoder))
            break
          case MESSAGE_AWARENESS:
            awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), ws.id)
            break
        }
      } catch {
        ws.close(1003, 'bad message')
        leave(ws.id)
      }
    },
    close(ws) {
      leave(ws.id)
    },
  })

