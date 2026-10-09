/**
 * Pure helpers for Web Push (no DOM access, so they can be unit-tested in node).
 * The browser glue lives in `usePush.ts`.
 */

/** base64url (as the server's VAPID public key) → bytes for `applicationServerKey`. */
export function urlBase64ToUint8Array(b64: string): Uint8Array {
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export interface PushEnv {
  ua: string;
  platform: string;
  maxTouchPoints: number;
  /** running as an installed app (display-mode: standalone or navigator.standalone) */
  standalone: boolean;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  permission: NotificationPermission | 'unsupported';
}

/** iPhone / iPad (including iPadOS, which reports itself as a Mac with a touch screen). */
export function isIos(e: Pick<PushEnv, 'ua' | 'platform' | 'maxTouchPoints'>): boolean {
  return /iPad|iPhone|iPod/.test(e.ua) || (e.platform === 'MacIntel' && e.maxTouchPoints > 1);
}

export type PushSupport =
  /** the browser cannot do Web Push */
  | 'unsupported'
  /** iOS Safari: push only works for a site added to the Home Screen (iOS 16.4+) */
  | 'ios-install'
  /** the user blocked notifications in the browser */
  | 'denied'
  | 'ready';

export function detectSupport(e: PushEnv): PushSupport {
  if (isIos(e) && !e.standalone) return 'ios-install';
  if (!e.hasServiceWorker || !e.hasPushManager || !e.hasNotification) return 'unsupported';
  if (e.permission === 'denied') return 'denied';
  return 'ready';
}

export interface SerializedSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** `PushSubscription.toJSON()` → the shape the API expects, or null when something is missing. */
export function serializeSubscription(j: {
  endpoint?: string;
  keys?: Record<string, string>;
}): SerializedSubscription | null {
  const p256dh = j.keys?.p256dh;
  const auth = j.keys?.auth;
  if (!j.endpoint || !p256dh || !auth) return null;
  return { endpoint: j.endpoint, keys: { p256dh, auth } };
}

export interface PushPrefs {
  storm: boolean;
  heavy_rain: boolean;
  cyclone: boolean;
  quiet_start: number;
  quiet_end: number;
}

export const DEFAULT_PREFS: PushPrefs = { storm: true, heavy_rain: true, cyclone: true, quiet_start: 22, quiet_end: 6 };

/** "22:00–06:00", or null when quiet hours are off (start === end). */
export function quietLabel(p: Pick<PushPrefs, 'quiet_start' | 'quiet_end'>): string | null {
  if (p.quiet_start === p.quiet_end) return null;
  const h = (n: number) => `${String(n).padStart(2, '0')}:00`;
  return `${h(p.quiet_start)}–${h(p.quiet_end)}`;
}

/** Locations are stored at ~1 km precision on the server; show the same rounding. */
export const roundCoord = (v: number) => Math.round(v * 100) / 100;

/** What the browser remembers about this device's subscription (localStorage). */
export interface StoredPush {
  id: string;
  lat: number;
  lon: number;
  label: string;
  prefs: PushPrefs;
}

export function parseStored(raw: string | null): StoredPush | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<StoredPush>;
    if (typeof v.id !== 'string' || typeof v.lat !== 'number' || typeof v.lon !== 'number' || typeof v.prefs !== 'object' || !v.prefs) {
      return null;
    }
    return { id: v.id, lat: v.lat, lon: v.lon, label: typeof v.label === 'string' ? v.label : '', prefs: { ...DEFAULT_PREFS, ...v.prefs } };
  } catch {
    return null;
  }
}
