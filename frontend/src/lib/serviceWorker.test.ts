import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const origin = 'https://weather.example';
const source = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8');
const escapedExternal = `/${String.fromCharCode(92)}example.invalid`;

function worker(windows: { url: string; focus: () => Promise<unknown>; navigate?: (url: string) => Promise<unknown> }[] = []) {
  const handlers = new Map<string, (event: unknown) => void>();
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const openWindow = vi.fn().mockResolvedValue(undefined);
  const self = {
    location: { origin },
    addEventListener: (name: string, listener: (event: unknown) => void) => handlers.set(name, listener),
    registration: { showNotification },
    clients: { matchAll: vi.fn().mockResolvedValue(windows), openWindow },
  };
  // Execute the actual worker source; no browser permissions or notifications are used.
  const safeUrl = runInNewContext(`${source}\nsafeUrl;`, { self, URL }) as (value: unknown) => string;
  const dispatch = async (name: string, event: Record<string, unknown>) => {
    let pending: Promise<unknown> | undefined;
    handlers.get(name)!({ ...event, waitUntil: (promise: Promise<unknown>) => { pending = promise; } });
    await pending;
  };
  return { safeUrl, showNotification, openWindow, dispatch };
}

describe('service-worker notification URLs', () => {
  it('keeps a point forecast URL and its query/hash', () => {
    const { safeUrl } = worker();
    expect(safeUrl('/?lat=13.840&lon=100.560')).toBe('/?lat=13.840&lon=100.560');
    expect(safeUrl('/alerts?lang=en#storm')).toBe('/alerts?lang=en#storm');
    expect(safeUrl('/forecast/../?lat=13.840')).toBe('/?lat=13.840');
  });

  it('rejects slash/backslash authority tricks and normalized double-slash paths', () => {
    const { safeUrl } = worker();
    expect(new URL(escapedExternal, origin).origin).toBe('https://example.invalid');
    for (const value of [escapedExternal, '/\t/example.invalid', '/a/..//example.invalid', '/%2e%2e//example.invalid']) {
      expect(safeUrl(value)).toBe('/');
    }
  });

  it('falls back for external, protocol-relative, malformed and non-path inputs', () => {
    const { safeUrl } = worker();
    for (const value of [
      '//example.invalid', `//${new URL(origin).host}/alerts`, 'https://example.invalid/',
      'https://weather.example/alerts', 'javascript:alert(1)', 'alerts', '',
      `/${String.fromCharCode(92)}[invalid`, null, undefined, {}, 12,
    ]) expect(safeUrl(value)).toBe('/');
  });

  it('sanitizes a push payload before storing its notification target', async () => {
    const w = worker();
    await w.dispatch('push', { data: { json: () => ({ title: 'Rain', url: escapedExternal }) } });
    expect(w.showNotification).toHaveBeenCalledWith('Rain', expect.objectContaining({ data: { url: '/' } }));
  });

  it('sanitizes notification targets again before opening a new window', async () => {
    const w = worker();
    const close = vi.fn();
    await w.dispatch('notificationclick', { notification: { data: { url: escapedExternal }, close } });
    expect(close).toHaveBeenCalledOnce();
    expect(w.openWindow).toHaveBeenCalledWith('/');
  });

  it('focuses the same-origin tab and navigates to a valid point forecast', async () => {
    const focus = vi.fn().mockResolvedValue(undefined);
    const navigate = vi.fn().mockResolvedValue(undefined);
    const w = worker([{ url: `${origin}/alerts`, focus, navigate }]);
    await w.dispatch('notificationclick', { notification: { data: { url: '/?lat=13.840&lon=100.560' }, close: vi.fn() } });
    expect(focus).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith('/?lat=13.840&lon=100.560');
    expect(w.openWindow).not.toHaveBeenCalled();
  });
});
