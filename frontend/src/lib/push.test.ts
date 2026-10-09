import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFS,
  detectSupport,
  isIos,
  parseStored,
  quietLabel,
  roundCoord,
  serializeSubscription,
  urlBase64ToUint8Array,
  type PushEnv,
} from './push';

const env = (over: Partial<PushEnv> = {}): PushEnv => ({
  ua: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130',
  platform: 'Linux x86_64',
  maxTouchPoints: 0,
  standalone: false,
  hasServiceWorker: true,
  hasPushManager: true,
  hasNotification: true,
  permission: 'default',
  ...over,
});

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1';

describe('urlBase64ToUint8Array', () => {
  it('decodes base64url without padding', () => {
    expect(Array.from(urlBase64ToUint8Array('AQID'))).toEqual([1, 2, 3]);
    expect(Array.from(urlBase64ToUint8Array('-_8'))).toEqual([251, 255]); // url alphabet + missing padding
  });

  it('decodes a 65-byte VAPID public key', () => {
    const bytes = Uint8Array.from({ length: 65 }, (_, i) => (i * 7) % 256);
    const b64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(urlBase64ToUint8Array(b64)).toEqual(bytes);
  });
});

describe('platform detection', () => {
  it('recognises iPhone, iPad and iPadOS-as-Mac', () => {
    expect(isIos({ ua: IPHONE, platform: 'iPhone', maxTouchPoints: 5 })).toBe(true);
    expect(isIos({ ua: 'Mozilla/5.0 (iPad; CPU OS 16_4)', platform: 'iPad', maxTouchPoints: 5 })).toBe(true);
    expect(isIos({ ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5 })).toBe(true);
    expect(isIos({ ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 0 })).toBe(false);
    expect(isIos({ ua: env().ua, platform: 'Linux x86_64', maxTouchPoints: 0 })).toBe(false);
  });

  it('asks iOS users to install the app first', () => {
    const ios = { ua: IPHONE, platform: 'iPhone', maxTouchPoints: 5, hasPushManager: false };
    expect(detectSupport(env(ios))).toBe('ios-install');
    expect(detectSupport(env({ ...ios, standalone: true, hasPushManager: true }))).toBe('ready');
  });

  it('reports unsupported browsers and blocked permission', () => {
    expect(detectSupport(env())).toBe('ready');
    expect(detectSupport(env({ hasPushManager: false }))).toBe('unsupported');
    expect(detectSupport(env({ hasServiceWorker: false }))).toBe('unsupported');
    expect(detectSupport(env({ permission: 'denied' }))).toBe('denied');
    expect(detectSupport(env({ permission: 'granted' }))).toBe('ready');
  });
});

describe('subscription helpers', () => {
  it('keeps only what the API needs and rejects incomplete subscriptions', () => {
    expect(serializeSubscription({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'a', auth: 'b', extra: 'c' } })).toEqual({
      endpoint: 'https://fcm.googleapis.com/x',
      keys: { p256dh: 'a', auth: 'b' },
    });
    expect(serializeSubscription({ endpoint: 'https://x', keys: { p256dh: 'a' } })).toBeNull();
    expect(serializeSubscription({})).toBeNull();
  });

  it('formats quiet hours and coordinates', () => {
    expect(quietLabel({ quiet_start: 22, quiet_end: 6 })).toBe('22:00–06:00');
    expect(quietLabel({ quiet_start: 0, quiet_end: 0 })).toBeNull();
    expect(roundCoord(13.7512)).toBe(13.75);
    expect(roundCoord(100.4987)).toBe(100.5);
  });

  it('parses the stored subscription defensively', () => {
    const ok = { id: 'abc', lat: 13.75, lon: 100.5, label: 'บ้าน', prefs: { storm: false } };
    expect(parseStored(JSON.stringify(ok))).toEqual({ ...ok, prefs: { ...DEFAULT_PREFS, storm: false } });
    expect(parseStored(null)).toBeNull();
    expect(parseStored('{not json')).toBeNull();
    expect(parseStored('{"id":1}')).toBeNull();
  });
});
