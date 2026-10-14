'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useReportWebVitals } from 'next/web-vitals';

/**
 * Page views and Web Vitals for the self-hosted analytics in Dock (docker.chakkritton.com).
 * Posts to /_a on this same site, which the proxy hands to the analytics service. No cookies or
 * identifiers are sent; the referrer goes only with the first page of a visit, and the server
 * keeps just the referring site's name.
 */
let first = true;

function send(body: Record<string, unknown>) {
  const data = JSON.stringify(body);
  try {
    if (navigator.sendBeacon?.('/_a', new Blob([data], { type: 'text/plain' }))) return;
  } catch {}
  fetch('/_a', { method: 'POST', body: data, keepalive: true }).catch(() => {});
}

export function DockAnalytics() {
  const path = usePathname();
  useEffect(() => {
    if (!path) return;
    send({ t: 'pv', p: path, r: first ? document.referrer : '' });
    first = false;
  }, [path]);
  useReportWebVitals((metric) => send({ t: 'v', p: location.pathname, n: metric.name, v: metric.value }));
  return null;
}
