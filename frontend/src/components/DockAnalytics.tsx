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

/** The page this document loaded as: a load's TTFB, FCP and LCP belong to it, not to wherever the app is when they arrive. */
function loadedPath(): string {
  const nav = performance.getEntriesByType('navigation')[0];
  return nav ? new URL(nav.name).pathname : location.pathname;
}

// Module level, so the same function every render: Next re-subscribes when the callback changes,
// and each new subscription re-sent the load's metrics, tagged with the page navigated to.
const report: Parameters<typeof useReportWebVitals>[0] = (metric) =>
  send({ t: 'v', p: metric.name === 'INP' || metric.name === 'CLS' ? location.pathname : loadedPath(), n: metric.name, v: metric.value });

export function DockAnalytics() {
  const path = usePathname();
  useEffect(() => {
    if (!path) return;
    send({ t: 'pv', p: path, r: first ? document.referrer : '' });
    first = false;
  }, [path]);
  useReportWebVitals(report);
  return null;
}
