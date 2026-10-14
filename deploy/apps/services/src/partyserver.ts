/**
 * The slice of `partyserver` that Drive Music's SyncServer uses, on Bun instead of a Durable Object:
 * per-room storage (bun:sqlite), one alarm per room (a timer), broadcast and connections.
 * Like a Durable Object's input gate, each room handles one event at a time (see `Rooms.run`).
 */
import { Database } from 'bun:sqlite'

export type Connection = {
  id: string
  uri: string
  send(message: string): void
  close(code?: number, reason?: string): void
}

type Storage = {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
  getAlarm(): Promise<number | null>
  setAlarm(at: number): Promise<void>
  deleteAlarm(): Promise<void>
}

export class Server<Env = unknown> {
  ctx!: { storage: Storage }
  env!: Env
  name!: string
  connections = new Map<string, Connection>()
  onStart(): void | Promise<void> {}
  onConnect(_connection: Connection): void | Promise<void> {}
  onMessage(_connection: Connection, _message: string | ArrayBuffer | ArrayBufferView): void | Promise<void> {}
  onClose(_connection: Connection): void | Promise<void> {}
  onError(_connection: Connection, _error?: unknown): void | Promise<void> {}
  onAlarm(): void | Promise<void> {}
  broadcast(message: string, without: string[] = []) {
    for (const [id, c] of this.connections) {
      if (without.includes(id)) continue
      try {
        c.send(message)
      } catch {}
    }
  }
  getConnections() {
    return this.connections.values()
  }
}

export function routePartykitRequest(): never {
  throw new Error('routing is done by the Elysia app (src/sync.ts)')
}

type Entry<S extends Server> = { server: S; queue: Promise<unknown>; alarm: { at: number; timer: Timer } | null }

/** Rooms of one Server class, created on first use, kept while they have sockets or an alarm. */
export class Rooms<S extends Server<Env>, Env> {
  private rooms = new Map<string, Entry<S>>()
  private db: Database

  constructor(private Cls: new () => S, private env: Env, dbPath: string) {
    this.db = new Database(dbPath, { create: true })
    this.db.run('PRAGMA journal_mode = WAL')
    this.db.run('CREATE TABLE IF NOT EXISTS kv (room TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (room, key))')
  }

  get size() {
    return this.rooms.size
  }

  /** Run `fn` after everything already queued for this room (one event at a time, like an input gate). */
  run<T>(name: string, fn: (server: S) => T | Promise<T>): Promise<T> {
    const entry = this.get(name)
    const next = entry.queue.then(() => fn(entry.server))
    entry.queue = next.catch((e) => console.error(`room ${name}:`, e))
    return next
  }

  /** Drop an idle room from memory (its storage stays). */
  release(name: string) {
    const entry = this.rooms.get(name)
    if (!entry || entry.server.connections.size > 0 || entry.alarm) return
    this.rooms.delete(name)
  }

  private get(name: string): Entry<S> {
    let entry = this.rooms.get(name)
    if (entry) return entry
    const server = new this.Cls()
    server.env = this.env
    server.name = name
    const db = this.db
    const e: Entry<S> = { server, queue: Promise.resolve(), alarm: null }
    const fire = () => {
      e.alarm = null
      this.run(name, (s) => s.onAlarm()).finally(() => this.release(name))
    }
    server.ctx = {
      storage: {
        async get<T>(key: string) {
          const row = db.query('SELECT value FROM kv WHERE room = ? AND key = ?').get(name, key) as { value: string } | null
          return row ? (JSON.parse(row.value) as T) : undefined
        },
        async put(key, value) {
          db.query('INSERT INTO kv (room, key, value) VALUES (?, ?, ?) ON CONFLICT(room, key) DO UPDATE SET value = excluded.value').run(
            name, key, JSON.stringify(value),
          )
        },
        async getAlarm() {
          return e.alarm?.at ?? null
        },
        async setAlarm(at) {
          if (e.alarm) clearTimeout(e.alarm.timer)
          e.alarm = { at, timer: setTimeout(fire, Math.max(0, at - Date.now())) }
        },
        async deleteAlarm() {
          if (e.alarm) clearTimeout(e.alarm.timer)
          e.alarm = null
        },
      },
    }
    e.queue = Promise.resolve().then(() => server.onStart())
    this.rooms.set(name, e)
    return e
  }
}
