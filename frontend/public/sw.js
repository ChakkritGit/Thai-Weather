/* Service worker: Web Push notifications only.
 * Deliberately no fetch handler / caching: forecasts and radar must always be fresh, and the API
 * responses are never stored here. */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

/** Only same-origin paths are accepted, so a payload can never open another site. */
function safeUrl(u) {
  return typeof u === 'string' && u.startsWith('/') && !u.startsWith('//') ? u : '/';
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'ฟ้าละเอียด';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      lang: data.lang || 'th',
      icon: '/icons/192',
      badge: '/icons/badge-96',
      tag: data.tag || undefined,
      renotify: Boolean(data.tag), // a newer alert with the same tag replaces the old one and alerts again
      data: { url: safeUrl(data.url) },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = safeUrl(event.notification.data && event.notification.data.url);
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = wins.find((c) => new URL(c.url).origin === self.location.origin);
      if (open) {
        await open.focus();
        if ('navigate' in open) {
          try {
            await open.navigate(url);
          } catch (_) {
            /* focusing the existing tab is enough */
          }
        }
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
