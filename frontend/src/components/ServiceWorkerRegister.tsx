'use client';

import { useEffect } from 'react';

/** Registers /sw.js (push notifications + installable PWA). Renders nothing. */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      /* e.g. insecure origin: the site works the same without it */
    });
  }, []);
  return null;
}
