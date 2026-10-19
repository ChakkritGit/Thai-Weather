import type { DriveFile, ParsedMetadata, PlaySource } from "../types";

export const PARTY_PROTOCOL = 2;
// Leave room for minute-batched background timers and a brief network reconnect.
// Explicit output selection has its own short deadline and never waits this long.
export const LEASE_MS = 90_000;
export const HANDOFF_MS = 2000;
export const LEGACY_LEASE_MS = 9000;
export const HEARTBEAT_MS = 2500;
export function leaseDeadline(sent: number, leaseMs: unknown): number {
  const duration = typeof leaseMs === "number" && Number.isFinite(leaseMs)
    ? Math.max(0, Math.min(leaseMs, LEASE_MS)) : LEGACY_LEASE_MS;
  return sent + duration;
}
export interface PartyPlayback {
  queue: DriveFile[];
  currentIndex: number;
  source: PlaySource | null;
  progress: number;
  duration: number;
  isPlaying: boolean;
  shuffle: boolean;
  shuffleOrder: number[];
  playNextIndex: number | null;
  loopMode: "off" | "all" | "one";
  meta: ParsedMetadata | null;
  updatedAt: number;
  /** The output's volume, 0–1, reported by outputs that support remote volume. */
  volume?: number;
}
export type DeviceKind = "phone" | "tablet" | "computer";
export interface PartyDevice { id: string; name: string; kind?: DeviceKind }
const DEVICE_KINDS: readonly string[] = ["phone", "tablet", "computer"];
export const validDeviceKind = (v: unknown): v is DeviceKind => typeof v === "string" && DEVICE_KINDS.includes(v);

/** A Spotify-style device label ("iPhone · Safari") and kind, from the user agent. iPadOS
 * reports itself as a Mac, so a Mac with a touch screen is an iPad. */
export function describeDevice(ua: string, maxTouchPoints = 0): { name: string; kind: DeviceKind } {
  const browser = /Edg\//.test(ua) ? "Edge" : /SamsungBrowser/.test(ua) ? "Samsung Internet" : /Firefox\/|FxiOS/.test(ua) ? "Firefox"
    : /Chrome\/|CriOS/.test(ua) ? "Chrome" : "Safari";
  const ipad = /iPad/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1);
  if (/iPhone/.test(ua)) return { name: `iPhone · ${browser}`, kind: "phone" };
  if (ipad) return { name: `iPad · ${browser}`, kind: "tablet" };
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? { name: `Android phone · ${browser}`, kind: "phone" } : { name: `Android tablet · ${browser}`, kind: "tablet" };
  const os = /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows PC" : /CrOS/.test(ua) ? "Chromebook" : "Linux PC";
  return { name: `${os} · ${browser}`, kind: "computer" };
}
export interface PartyRoom {
  type: "room";
  protocol: typeof PARTY_PROTOCOL;
  revision: number;
  /** Changes only for transport commands; queue/settings edits must not seek the output. */
  transportRevision?: number;
  /** Changes only when playback must move to a new position or output. */
  positionRevision?: number;
  /** Modern outputs own transport; room snapshots only describe their actual playback. */
  controlMode?: "commands" | "snapshots";
  /** Explicit controls use their own acknowledgement sequence, separate from room publishes. */
  commandRevision?: number;
  /** A fresh output grant invalidates commands and reports from its previous ownership. */
  outputGeneration?: number;
  devices: PartyDevice[];
  outputId: string | null;
  pendingOutputId: string | null;
  playback: PartyPlayback | null;
}
export type PartyCommand =
  | { type: "play"; queue: DriveFile[]; index: number; source?: PlaySource }
  | { type: "toggle" | "next" | "previous" | "shuffle" | "loop" }
  | { type: "playing"; value: boolean }
  | { type: "seek"; seconds: number }
  | { type: "insert"; file: DriveFile }
  | { type: "remove"; index: number; fileId: string }
  | { type: "volume"; value: number };

export interface PartyPlayerCommand {
  type: "player-command";
  protocol: typeof PARTY_PROTOCOL;
  outputId: string;
  revision: number;
  outputGeneration: number;
  command: PartyCommand;
}

/** Only explicit messages to the current output may drive an existing transport. */
export function validPlayerCommand(value: unknown): value is PartyPlayerCommand {
  if (!object(value)) return false;
  return value.type === "player-command" && value.protocol === PARTY_PROTOCOL
    && typeof value.outputId === "string" && Number.isInteger(value.revision) && finite(value.revision)
    && Number.isInteger(value.outputGeneration) && finite(value.outputGeneration) && validCommand(value.command);
}

export function isQueueCommand(command: PartyCommand): boolean {
  // none of these may seek or restart the output's transport
  return ["insert", "remove", "shuffle", "loop", "volume"].includes(command.type);
}

/** Missing versions (older workers), a handoff or a missed transport command require a full apply. */
export function canPreserveTransport(previous: Pick<PartyRoom, "outputId" | "transportRevision"> | null, next: PartyRoom): boolean {
  return !!previous && previous.outputId === next.outputId && next.outputId !== null
    && next.transportRevision !== undefined && previous.transportRevision === next.transportRevision;
}

/** Play/pause changes use the output's actual clock. A missed seek still requires applying
 * the shared position, even if a later play/pause command arrives in the same render. */
export function canPreservePosition(previous: Pick<PartyRoom, "outputId" | "positionRevision"> | null, next: PartyRoom): boolean {
  return !!previous && previous.outputId === next.outputId && next.outputId !== null
    && next.positionRevision !== undefined && previous.positionRevision === next.positionRevision;
}

export function positionAt(p: PartyPlayback, now: number): number {
  const at = p.progress + (p.isPlaying ? Math.max(0, now - p.updatedAt) / 1000 : 0);
  return p.duration > 0 ? Math.min(p.duration, at) : at;
}

/** The output knows its real queue clock, including when a local audition borrows the
 * audio elements. Controllers extrapolate the room clock until their next report. */
export function playbackDisplay(
  room: PartyRoom,
  local: { isPlaying: boolean; progress: number; duration: number; syncRevision: number; isPreviewingTransition: boolean },
  localOutput: boolean,
  now: number,
): Pick<PartyPlayback, "isPlaying" | "progress" | "duration"> {
  if (!room.playback || (localOutput && (local.isPreviewingTransition || local.syncRevision === room.revision))) {
    return { isPlaying: local.isPlaying && !local.isPreviewingTransition, progress: local.progress, duration: local.duration };
  }
  const p = room.playback;
  return { isPlaying: p.isPlaying, duration: p.duration,
    progress: room.outputId && !room.pendingOutputId ? positionAt(p, now) : p.progress };
}
export function upcoming(p: PartyPlayback): number[] {
  const order = p.shuffle ? p.shuffleOrder.slice(p.shuffleOrder.indexOf(p.currentIndex) + 1)
    : p.queue.map((_, i) => i).slice(p.currentIndex + 1);
  return [...(p.playNextIndex !== null ? [p.playNextIndex] : []), ...order.filter(i => i !== p.playNextIndex)]
    .filter(i => i !== p.currentIndex && !!p.queue[i]);
}
function shuffled(length: number, current: number): number[] {
  const rest = Array.from({ length }, (_, i) => i).filter(i => i !== current);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return [current, ...rest];
}
/** Outputs reduce explicit commands against their actual queue; legacy rooms also use this reducer. */
export function reducePlayback(previous: PartyPlayback | null, command: PartyCommand, now: number): PartyPlayback | null {
  if (command.type === "play") {
    if (!command.queue[command.index]) return previous;
    const same = previous?.queue.map(f => f.id).join("\0") === command.queue.map(f => f.id).join("\0");
    return { queue: command.queue, currentIndex: command.index, source: command.source ?? null,
      progress: 0, duration: 0, isPlaying: true, shuffle: previous?.shuffle ?? false,
      shuffleOrder: previous?.shuffle ? (same ? previous.shuffleOrder : shuffled(command.queue.length, command.index)) : [],
      playNextIndex: null, loopMode: previous?.loopMode ?? "off", meta: null, updatedAt: now };
  }
  if (!previous) {
    return command.type === "insert" ? reducePlayback(null, { type: "play", queue: [command.file], index: 0 }, now) : null;
  }
  const p = { ...previous, progress: positionAt(previous, now), updatedAt: now };
  switch (command.type) {
    case "toggle": p.isPlaying = !p.isPlaying; break;
    case "playing": p.isPlaying = command.value; break;
    case "seek": p.progress = Math.max(0, p.duration ? Math.min(p.duration, command.seconds) : command.seconds); break;
    case "volume": p.volume = command.value; break;
    case "loop": p.loopMode = p.loopMode === "off" ? "all" : p.loopMode === "all" ? "one" : "off"; break;
    case "shuffle": p.shuffle = !p.shuffle; p.shuffleOrder = p.shuffle ? shuffled(p.queue.length, p.currentIndex) : []; break;
    case "next":
    case "previous": {
      if (command.type === "previous" && p.progress > 3) { p.progress = 0; break; }
      const order = p.shuffle ? p.shuffleOrder : p.queue.map((_, i) => i);
      const at = order.indexOf(p.currentIndex);
      p.currentIndex = command.type === "next" && p.playNextIndex !== null ? p.playNextIndex
        : order[(at + (command.type === "next" ? 1 : -1) + order.length) % order.length];
      p.playNextIndex = null; p.progress = 0; p.duration = 0; p.meta = null; p.isPlaying = true;
      break;
    }
    case "insert": {
      if (p.queue[p.currentIndex]?.id === command.file.id) return previous;
      const oldQueue = p.queue;
      const currentId = oldQueue[p.currentIndex]?.id;
      const ids = p.shuffleOrder.map(i => oldQueue[i]?.id).filter(id => id !== command.file.id);
      p.queue = oldQueue.filter(f => f.id !== command.file.id);
      p.currentIndex = p.queue.findIndex(f => f.id === currentId);
      const insertAt = p.currentIndex + 1;
      p.queue.splice(insertAt, 0, command.file);
      p.playNextIndex = insertAt;
      ids.splice(ids.indexOf(currentId) + 1, 0, command.file.id);
      p.shuffleOrder = p.shuffle ? ids.map(id => p.queue.findIndex(f => f.id === id)) : [];
      break;
    }
    case "remove": {
      // An old controller index must never delete a different track after another edit.
      const i = command.index;
      if (p.queue[i]?.id !== command.fileId || i === p.currentIndex) return previous;
      p.queue = p.queue.filter((_, index) => index !== i);
      if (p.currentIndex > i) p.currentIndex--;
      p.shuffleOrder = p.shuffleOrder.filter(index => index !== i).map(index => index > i ? index - 1 : index);
      p.playNextIndex = p.playNextIndex === i ? null : p.playNextIndex !== null && p.playNextIndex > i ? p.playNextIndex - 1 : p.playNextIndex;
      break;
    }
  }
  return p;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const file = (v: unknown): v is DriveFile => object(v) && typeof v.id === "string" && v.id.length > 0 && v.id.length < 256 && typeof v.name === "string" && typeof v.mimeType === "string";
const queue = (v: unknown): v is DriveFile[] => Array.isArray(v) && v.length > 0 && v.length <= 10000 && v.every(file);
const source = (v: unknown) => v == null || (object(v) && ["folder", "playlist", "library"].includes(String(v.type)) && typeof v.id === "string" && typeof v.name === "string");
export function validCommand(v: unknown): v is PartyCommand {
  if (!object(v)) return false;
  switch (v.type) {
    case "toggle": case "next": case "previous": case "shuffle": case "loop": return true;
    case "playing": return typeof v.value === "boolean";
    case "seek": return finite(v.seconds);
    case "insert": return file(v.file);
    case "remove": return Number.isInteger(v.index) && finite(v.index) && typeof v.fileId === "string";
    case "volume": return finite(v.value) && v.value <= 1;
    case "play": return queue(v.queue) && Number.isInteger(v.index) && finite(v.index) && v.index < v.queue.length && source(v.source);
    default: return false;
  }
}
function validMeta(v: unknown): boolean {
  return v === null || (object(v) && ["title", "artist", "album", "pictureDataUrl"].every(key => v[key] === undefined || typeof v[key] === "string"));
}
export function validPlayback(v: unknown): v is PartyPlayback {
  if (!object(v) || !queue(v.queue) || !Number.isInteger(v.currentIndex) || !finite(v.currentIndex) || v.currentIndex >= v.queue.length) return false;
  return finite(v.progress) && finite(v.duration) && finite(v.updatedAt) && typeof v.isPlaying === "boolean" && typeof v.shuffle === "boolean"
    && ["off", "all", "one"].includes(String(v.loopMode)) && source(v.source)
    && validMeta(v.meta)
    && Array.isArray(v.shuffleOrder) && v.shuffleOrder.every(i => Number.isInteger(i) && i >= 0 && i < (v.queue as DriveFile[]).length)
    && (!v.shuffle || v.shuffleOrder.includes(v.currentIndex))
    && (v.volume === undefined || (finite(v.volume) && v.volume <= 1))
    && (v.playNextIndex === null || (Number.isInteger(v.playNextIndex) && finite(v.playNextIndex) && v.playNextIndex < v.queue.length));
}
