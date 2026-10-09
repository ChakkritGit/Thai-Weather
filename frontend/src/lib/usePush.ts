'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from './api';
import {
  detectSupport,
  parseStored,
  serializeSubscription,
  urlBase64ToUint8Array,
  type PushPrefs,
  type PushSupport,
  type SerializedSubscription,
  type StoredPush,
} from './push';
import { pushApi } from './pushApi';

const STORAGE_KEY = 'thwx.push';

/** Why an action failed, so the UI can show the right sentence. */
export type PushError = 'denied' | 'outside' | 'full' | 'rate' | 'gone' | 'failed';

function readStored(): StoredPush | null {
  try {
    return parseStored(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

function writeStored(v: StoredPush | null) {
  try {
    if (v) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* private mode / blocked storage: the browser's own subscription is the source of truth */
  }
}

function readSupport(): PushSupport {
  const nav = navigator as Navigator & { standalone?: boolean };
  return detectSupport({
    ua: nav.userAgent,
    platform: nav.platform ?? '',
    maxTouchPoints: nav.maxTouchPoints ?? 0,
    standalone: window.matchMedia?.('(display-mode: standalone)').matches === true || nav.standalone === true,
    hasServiceWorker: 'serviceWorker' in navigator,
    hasPushManager: 'PushManager' in window,
    hasNotification: 'Notification' in window,
    permission: 'Notification' in window ? Notification.permission : 'unsupported',
  });
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration('/');
  if (!existing) await navigator.serviceWorker.register('/sw.js');
  return navigator.serviceWorker.ready;
}

function toError(e: unknown): PushError {
  if (e instanceof ApiError) {
    if (e.status === 422) return 'outside';
    if (e.status === 503) return 'full';
    if (e.status === 429) return 'rate';
    if (e.status === 410 || e.status === 404) return 'gone';
  }
  return 'failed';
}

export interface PushController {
  /** `checking` until the browser has been inspected (first client render) */
  support: PushSupport | 'checking';
  /** what this device has subscribed to (one location per device) */
  stored: StoredPush | null;
  busy: boolean;
  error: PushError | null;
  /** Subscribe this device to a location, or update the existing subscription (also moves it). */
  save: (lat: number, lon: number, label: string, prefs: PushPrefs) => Promise<boolean>;
  remove: () => Promise<void>;
  sendTest: () => Promise<boolean>;
}

export function usePush(): PushController {
  const [support, setSupport] = useState<PushController['support']>('checking');
  const [stored, setStored] = useState<StoredPush | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PushError | null>(null);

  useEffect(() => {
    const s = readSupport();
    setSupport(s);
    const local = readStored();
    setStored(local);
    if (s !== 'ready' || !local) return;
    // forget the stored id when the browser no longer holds the subscription (e.g. site data cleared)
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => {
        if (!sub) {
          writeStored(null);
          setStored(null);
        }
      })
      .catch(() => {});
  }, []);

  const currentSubscription = useCallback(async (): Promise<SerializedSubscription | null> => {
    const reg = await registration();
    const sub = await reg.pushManager.getSubscription();
    return sub ? serializeSubscription(sub.toJSON()) : null;
  }, []);

  const save = useCallback<PushController['save']>(async (lat, lon, label, prefs) => {
    setBusy(true);
    setError(null);
    try {
      // must run inside the click handler: browsers only show the permission prompt for a user gesture
      const permission = await Notification.requestPermission();
      setSupport(readSupport());
      if (permission !== 'granted') {
        setError('denied');
        return false;
      }
      const reg = await registration();
      const { public_key } = await pushApi.publicKey();
      const key = urlBase64ToUint8Array(public_key);
      let sub = await reg.pushManager.getSubscription();
      try {
        sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      } catch {
        // an old subscription made with another server key blocks subscribing: drop it and retry once
        await sub?.unsubscribe();
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      }
      const json = serializeSubscription(sub.toJSON());
      if (!json) throw new Error('incomplete subscription');
      const r = await pushApi.subscribe(json, lat, lon, label, prefs);
      const next: StoredPush = { id: r.id, lat: r.lat, lon: r.lon, label: r.label, prefs: r.prefs };
      writeStored(next);
      setStored(next);
      return true;
    } catch (e) {
      setError(toError(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const remove = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const json = await currentSubscription();
      if (json) await pushApi.unsubscribe(json).catch(() => {}); // the server also drops dead endpoints itself
      const reg = await registration();
      await (await reg.pushManager.getSubscription())?.unsubscribe();
    } catch {
      /* best effort: the local state is cleared either way */
    } finally {
      writeStored(null);
      setStored(null);
      setBusy(false);
    }
  }, [currentSubscription]);

  const sendTest = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const json = await currentSubscription();
      if (!json) throw new ApiError(404, 'no subscription');
      await pushApi.test(json);
      return true;
    } catch (e) {
      const err = toError(e);
      if (err === 'gone') {
        writeStored(null); // the server no longer knows this subscription
        setStored(null);
      }
      setError(err);
      return false;
    } finally {
      setBusy(false);
    }
  }, [currentSubscription]);

  return { support, stored, busy, error, save, remove, sendTest };
}
