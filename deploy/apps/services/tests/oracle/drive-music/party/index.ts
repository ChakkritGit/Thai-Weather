import { Server, routePartykitRequest, type Connection } from "../../partyserver";
import { jwtVerify } from "jose";
import type { SyncTokenPayload } from "../src/lib/sync";
import { HANDOFF_MS, HEARTBEAT_MS, LEASE_MS, PARTY_PROTOCOL, isQueueCommand, positionAt, reducePlayback, validCommand, validDeviceKind, validPlayback, type DeviceKind, type PartyCommand, type PartyPlayback, type PartyRoom } from "../src/lib/party";

interface Env { PARTY_TOKEN_SECRET: string }
type Device = { name: string; kind?: DeviceKind; seen: number; leaseUntil: number; connection: Connection | null; commands: boolean };

/** One command router and playback mirror per authenticated account. */
export class SyncServer extends Server<Env> {
  devices = new Map<string, Device>();
  room: PartyRoom = { type: "room", protocol: PARTY_PROTOCOL, revision: 0, transportRevision: 0, positionRevision: 0, controlMode: "snapshots", commandRevision: 0, outputGeneration: 0, devices: [], outputId: null, pendingOutputId: null, playback: null };
  releasing: { id: string; until: number } | null = null;
  pendingCommands: PartyCommand[] = [];
  pendingLocalPlayback: PartyPlayback | null = null;

  async onStart() {
    const playback = await this.ctx.storage.get<unknown>("playback");
    // A restarted room never resumes speakers without a fresh selection.
    if (validPlayback(playback)) this.room.playback = { ...playback, isPlaying: false, updatedAt: Date.now() };
  }
  onConnect(connection: Connection) { connection.send(JSON.stringify({ ...this.room, serverTime: Date.now() })); }
  async publish() {
    if (this.room.outputId && !this.room.pendingOutputId && this.pendingCommands.length) {
      for (const command of this.pendingCommands.splice(0)) this.dispatchCommand(command);
    }
    this.room.devices = [...this.devices].filter(([, d]) => d.connection).map(([id, d]) => ({ id, name: d.name, ...(d.kind ? { kind: d.kind } : {}) }));
    this.broadcast(JSON.stringify({ ...this.room, serverTime: Date.now() }));
    if (this.room.playback) await this.ctx.storage.put("playback", this.room.playback);
    if (this.devices.size || this.releasing) {
      const next = Math.min(Date.now() + HEARTBEAT_MS, this.releasing?.until ?? Infinity);
      const scheduled = await this.ctx.storage.getAlarm();
      // Playback reports arrive more often than the alarm interval. Moving the alarm on
      // every publish would postpone heartbeats (and dead-output recovery) indefinitely.
      if (scheduled === null || scheduled > next) await this.ctx.storage.setAlarm(next);
    }
  }
  async selectOutput(id: string | null, localPlayback?: PartyPlayback) {
    if (id === this.room.outputId && !this.releasing) return;
    // A retry during a slow connection cannot restart the transfer or invalidate
    // controls already queued for this target.
    if (this.releasing && id === this.room.pendingOutputId) {
      if (localPlayback) this.pendingLocalPlayback = localPlayback;
      return;
    }
    if (id !== this.room.pendingOutputId) this.pendingCommands = [];
    this.pendingLocalPlayback = localPlayback ?? null;
    if (this.room.playback) this.room.playback = { ...this.room.playback, progress: this.releasing ? this.room.playback.progress : positionAt(this.room.playback, Date.now()), updatedAt: Date.now() };
    if (this.room.outputId) {
      this.releasing = { id: this.room.outputId,
        until: Math.min(this.devices.get(this.room.outputId)?.leaseUntil ?? Date.now(), Date.now() + HANDOFF_MS) };
    }
    this.room.outputId = null;
    this.room.pendingOutputId = id;
    this.room.revision++;
    if (!this.releasing || this.releasing.until <= Date.now()) this.finishHandoff();
    await this.publish();
  }
  finishHandoff() {
    const next = this.room.pendingOutputId;
    this.room.outputId = next && this.devices.get(next)?.connection ? next : null;
    // Selecting this device may already have started its local player while the
    // old output acknowledges. Adopt its seed once; do not restart it from the
    // previous output's delayed mirror when the grant arrives.
    if (this.room.outputId && this.pendingLocalPlayback) this.room.playback = this.pendingLocalPlayback;
    this.pendingLocalPlayback = null;
    if (this.room.outputId) this.devices.get(this.room.outputId)!.leaseUntil = Date.now() + LEASE_MS;
    this.room.pendingOutputId = null;
    this.releasing = null;
    this.room.revision++;
    this.room.transportRevision = this.room.revision;
    this.room.positionRevision = this.room.revision;
    this.room.outputGeneration = (this.room.outputGeneration ?? 0) + 1;
    this.room.commandRevision = 0;
    this.room.controlMode = this.room.outputId && this.devices.get(this.room.outputId)?.commands ? "commands" : "snapshots";
    if (this.room.playback) this.room.playback = { ...this.room.playback, isPlaying: this.room.outputId ? this.room.playback.isPlaying : false, updatedAt: Date.now() };
  }
  dispatchCommand(command: PartyCommand) {
    const output = this.room.outputId ? this.devices.get(this.room.outputId) : null;
    if (output?.commands && output.connection) {
      this.room.commandRevision = (this.room.commandRevision ?? 0) + 1;
      this.room.revision++;
      output.connection.send(JSON.stringify({ type: "player-command", protocol: PARTY_PROTOCOL,
        outputId: this.room.outputId, outputGeneration: this.room.outputGeneration,
        revision: this.room.commandRevision, command }));
      return;
    }
    // Existing tabs advertise no command support. Retain their old room reducer
    // until they reload, while new outputs never receive snapshot-driven control.
    const base = this.room.playback;
    const playback = reducePlayback(base, command, Date.now());
    if (playback === base) return;
    if (!base || !isQueueCommand(command)) this.room.transportRevision = this.room.revision + 1;
    if (!base || ["play", "next", "previous", "seek"].includes(command.type)) this.room.positionRevision = this.room.revision + 1;
    this.room.playback = playback;
    this.room.revision++;
  }
  async onMessage(connection: Connection, raw: string | ArrayBuffer | ArrayBufferView) {
    if (typeof raw !== "string" || raw.length > 2_000_000) return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== "object") return;
    const now = Date.now();
    if (m.type === "hello" && m.protocol === PARTY_PROTOCOL && typeof m.name === "string") {
      const previous = this.devices.get(connection.id);
      this.devices.set(connection.id, { name: m.name.slice(0, 80), kind: validDeviceKind(m.kind) ? m.kind : undefined, seen: now,
        leaseUntil: previous?.leaseUntil ?? 0, connection, commands: m.commands === true });
      connection.send(JSON.stringify({ type: "welcome", deviceId: connection.id }));
      await this.publish();
      return;
    }
    const device = this.devices.get(connection.id);
    if (!device || device.connection !== connection) return;
    if (m.type === "heartbeat" && typeof m.sent === "number" && Number.isFinite(m.sent)) {
      device.seen = now;
      // Only the selected output receives a lease. Echo the client's monotonic send time,
      // so delayed packets cannot grant extra audible time or depend on synchronized clocks.
      const granted = this.room.outputId === connection.id;
      if (granted) device.leaseUntil = now + LEASE_MS;
      connection.send(JSON.stringify({ type: "lease", sent: m.sent, leaseMs: LEASE_MS, revision: this.room.revision, granted }));
    } else if (m.type === "detach" && (this.room.outputId === connection.id || this.room.pendingOutputId === connection.id || this.releasing?.id === connection.id)) {
      // A reconnected main player can continue standalone. Give up only its
      // Party reservation, without routing a pause back into that transport.
      if (this.room.outputId === connection.id) {
        device.leaseUntil = 0;
        await this.selectOutput(null);
        return;
      } else if (this.releasing?.id === connection.id) this.finishHandoff();
      else { await this.selectOutput(null); return; }
      await this.publish();
    } else if (m.type === "output" && typeof m.id === "string" && this.devices.get(m.id)?.connection) {
      if ((!this.room.playback || (!this.room.outputId && !this.room.pendingOutputId)) && validPlayback(m.seed)) this.room.playback = { ...m.seed, updatedAt: now };
      // Only a device adopting its own running main player can supersede the
      // mirror. Ordinary controllers keep the current output's shared queue.
      const localPlayback = m.adoptLocal === true && m.id === connection.id && validPlayback(m.seed)
        ? { ...m.seed, updatedAt: now } : undefined;
      await this.selectOutput(m.id, localPlayback);
    } else if (m.type === "released" && this.releasing?.id === connection.id && m.revision === this.room.revision) {
      this.finishHandoff();
      await this.publish();
    } else if (m.type === "command" && validCommand(m.command)) {
      if (!this.room.outputId && !this.room.pendingOutputId) await this.selectOutput(connection.id);
      if (this.room.pendingOutputId) {
        if (this.pendingCommands.length < 100) this.pendingCommands.push(m.command);
        return;
      }
      this.dispatchCommand(m.command);
      await this.publish();
    } else if (m.type === "report" && connection.id === this.room.outputId && validPlayback(m.playback)) {
      if (device.commands ? (m.outputGeneration !== this.room.outputGeneration || m.commandRevision !== this.room.commandRevision) : m.revision !== this.room.revision) return;
      this.room.playback = { ...m.playback, updatedAt: now };
      await this.publish();
    }
  }
  async onClose(connection: Connection) {
    const device = this.devices.get(connection.id);
    // A close event from the previous socket must not evict its reconnected replacement.
    if (!device || device.connection !== connection) return;
    this.devices.delete(connection.id);
    // A disconnected page is terminated, not an output reserved until lease expiry.
    // Removing it first makes selectOutput's old lease deadline expire immediately.
    if (connection.id === this.room.outputId || connection.id === this.room.pendingOutputId) {
      await this.selectOutput(null);
      return;
    }
    if (connection.id === this.releasing?.id) this.finishHandoff();
    await this.publish();
  }
  async onError(connection: Connection) {
    await this.onClose(connection);
    connection.close(1011, "Connection failed");
  }
  async onAlarm() {
    const now = Date.now();
    let changed = false;
    for (const [id, device] of this.devices) {
      const deadline = id === this.room.outputId || id === this.releasing?.id ? device.leaseUntil : device.seen + LEASE_MS;
      if (now >= deadline) {
        if (this.room.outputId === id) await this.selectOutput(null);
        this.devices.delete(id);
        device.connection?.close(4000, "Heartbeat expired");
        changed = true;
      } else if (device.connection) {
        // Websocket events wake the client independently of throttled setInterval timers.
        device.connection.send(JSON.stringify({ type: "heartbeat-request" }));
      }
    }
    if (this.releasing && now >= this.releasing.until) { this.finishHandoff(); changed = true; }
    if (changed) await this.publish();
    else if (this.devices.size || this.releasing) await this.ctx.storage.setAlarm(Math.min(now + HEARTBEAT_MS, this.releasing?.until ?? Infinity));
  }
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname === "/health" && ["GET", "HEAD"].includes(request.method)) {
      return Response.json({ status: env.PARTY_TOKEN_SECRET ? "ok" : "degraded", service: "drive-music-sync", protocol: PARTY_PROTOCOL },
        { status: env.PARTY_TOKEN_SECRET ? 200 : 503, headers: { "Cache-Control": "no-store" } });
    }
    const response = await routePartykitRequest(request, env, {
      async onBeforeConnect(req, lobby) {
        const token = new URL(req.url).searchParams.get("token");
        if (!token || !env.PARTY_TOKEN_SECRET) return new Response("Unauthorized", { status: 401 });
        try {
          const { payload } = await jwtVerify<SyncTokenPayload>(token, new TextEncoder().encode(env.PARTY_TOKEN_SECRET), { algorithms: ["HS256"] });
          if (payload.sub !== lobby.name) return new Response("Unauthorized", { status: 401 });
        } catch { return new Response("Unauthorized", { status: 401 }); }
      },
    });
    return response ?? new Response("Not Found", { status: 404 });
  },
};

export default worker;
