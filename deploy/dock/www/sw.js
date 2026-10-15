// Dock's service worker: Web Push from the chat service only (no caching – Dock always shows live data).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

/** only Dock's own pages can be opened from a notification */
const safeUrl = (u) => (typeof u === 'string' && u.startsWith('/') && !u.startsWith('//') ? u : '/#/chat');

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(d.title || 'Dock', {
    body: d.body || '',
    icon: '/icon-180.png',
    tag: d.tag || undefined,
    lang: 'th',
    data: { url: safeUrl(d.url) },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = safeUrl(event.notification.data && event.notification.data.url);
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = wins.find((c) => new URL(c.url).origin === self.location.origin);
    if (open) {
      await open.focus();
      if ('navigate' in open) await open.navigate(url).catch(() => {});
      return;
    }
    await self.clients.openWindow(url);
  })());
});
