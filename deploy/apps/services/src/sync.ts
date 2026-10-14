/**
 * Drive Music "Party Play" sync – replaces the `drive-music-sync` Worker (partyserver Durable Object).
 *
 * Runs the repo's own SyncServer (vendored by scripts/vendor-drive-music.sh) on the partyserver shim,
 * at the same URL partysocket builds: /parties/sync-server/<account>?_pk=<device>&token=<jwt>.
 * The token is the app's HS256 JWT (PARTY_TOKEN_SECRET) and its `sub` must be the room name.
 */
import { Elysia } from 'elysia'
import { jwtVerify } from 'jose'
import { Rooms, type Connection } from './partyserver'
import { SyncServer } from './vendor/drive-music/party/index'
import { PARTY_PROTOCOL } from './vendor/drive-music/src/lib/party'

const PORT = Number(process.env.PORT ?? 8788)
const SECRET = process.env.PARTY_TOKEN_SECRET ?? ''
const env = { PARTY_TOKEN_SECRET: SECRET }

export function createApp(dbPath = process.env.SYNC_DB ?? '/data/sync.db') {
  const rooms = new Rooms(SyncServer, env, dbPath)
  const conns = new Map<string, { room: string; connection: Connection }>()

  async function authorized(token: string | undefined, room: string) {
    if (!token || !SECRET) return false
    try {
      const { payload } = await jwtVerify(token, new TextEncoder().encode(SECRET), { algorithms: ['HS256'] })
      return payload.sub === room
    } catch {
      return false
    }
  }

  const app = new Elysia()
    .get('/health', ({ set }) => {
      set.status = SECRET ? 200 : 503
      set.headers['cache-control'] = 'no-store'
      return { status: SECRET ? 'ok' : 'degraded', service: 'drive-music-sync', protocol: PARTY_PROTOCOL }
    })
    .ws('/parties/sync-server/:room', {
      async beforeHandle({ params, query, set }) {
        if (!(await authorized(query.token as string | undefined, decodeURIComponent(params.room)))) {
          set.status = 401
          return 'Unauthorized'
        }
      },
      open(ws) {
        const room = decodeURIComponent(ws.data.params.room)
        const raw = ws.raw
        const connection: Connection = {
          id: (ws.data.query._pk as string | undefined) || crypto.randomUUID(),
          uri: ws.data.request.url,
          send: (m) => void raw.send(m),
          close: (code, reason) => raw.close(code, reason),
        }
        conns.set(ws.id, { room, connection })
        rooms.run(room, async (s) => {
          s.connections.set(connection.id, connection)
          await s.onConnect(connection)
        })
      },
      message(ws, message) {
        const c = conns.get(ws.id)
        if (!c) return
        // Elysia parses JSON text frames; the server expects the raw string
        const text = typeof message === 'string' ? message : message instanceof Uint8Array ? message : JSON.stringify(message)
        rooms.run(c.room, (s) => s.onMessage(c.connection, text as string))
      },
      close(ws) {
        const c = conns.get(ws.id)
        if (!c) return
        conns.delete(ws.id)
        rooms
          .run(c.room, async (s) => {
            // a reconnect with the same _pk may already have replaced this socket
            if (s.connections.get(c.connection.id) === c.connection) s.connections.delete(c.connection.id)
            await s.onClose(c.connection)
          })
          .finally(() => rooms.release(c.room))
      },
    })
  return { app, rooms }
}

if (import.meta.main) {
  if (!SECRET) console.warn('PARTY_TOKEN_SECRET is not set: every connection will be refused')
  createApp().app.listen({ port: PORT, hostname: '0.0.0.0' })
  console.log(`drive-music sync listening on :${PORT}`)
}
