import { ApiError } from './api';
import type { PushPrefs, SerializedSubscription } from './push';

/** Same origin by default; NEXT_PUBLIC_API_BASE for split deployments (see api.ts). */
const BASE = (process.env.NEXT_PUBLIC_API_BASE ?? '').replace(/\/+$/, '');

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${BASE}${path}`, init);
  if (!r.ok) {
    let detail = r.statusText;
    try {
      const d = (await r.json()).detail;
      if (typeof d === 'string') detail = d;
    } catch {
      /* not JSON */
    }
    throw new ApiError(r.status, detail);
  }
  return r.json() as Promise<T>;
}

const post = <T>(path: string, body: unknown) =>
  call<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export interface PushRegistration {
  id: string;
  lat: number;
  lon: number;
  label: string;
  prefs: PushPrefs;
}

export const pushApi = {
  publicKey: () => call<{ public_key: string }>('/api/v1/push/public-key'),
  subscribe: (subscription: SerializedSubscription, lat: number, lon: number, label: string, prefs: PushPrefs) =>
    post<PushRegistration>('/api/v1/push/subscribe', { subscription, lat, lon, label, prefs }),
  unsubscribe: (subscription: SerializedSubscription) => post<{ ok: boolean }>('/api/v1/push/unsubscribe', subscription),
  test: (subscription: SerializedSubscription) => post<{ ok: boolean }>('/api/v1/push/test', subscription),
};
