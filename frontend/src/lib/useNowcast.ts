import { useEffect, useState } from 'react';
import { api, ApiError } from './api';
import { nowcastForPoint, type NowcastSnapshot } from './nowcastText';

// The radar comes every 10 minutes and lands a few minutes late, so a 5-minute poll could show a frame 15 minutes
// old; the request only reads the server's latest snapshot.
const REFRESH_MS = 2 * 60_000;
/** back on screen (a phone woken, a tab returned to) after this long: asked again at once */
const STALE_ON_RETURN_MS = 60_000;

/** One point-nowcast request supplies both the radar card and the model comparison. */
export function useNowcast(lat: number, lon: number) {
  const [snapshot, setSnapshot] = useState<NowcastSnapshot>({
    lat, lon, status: 'loading', data: null, receivedAtMs: null,
  });
  const [clockMs, setClockMs] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    let loading = false;
    let lastMs = 0;
    setSnapshot({ lat, lon, status: 'loading', data: null, receivedAtMs: null });
    const load = async () => {
      // A slow request must not overlap the next refresh and overwrite a newer result.
      if (loading) return;
      loading = true;
      lastMs = Date.now();
      try {
        const data = await api.nowcast(lat, lon);
        if (cancelled) return;
        const receivedAtMs = Date.now();
        setClockMs(receivedAtMs);
        setSnapshot({ lat, lon, status: 'ready', data, receivedAtMs });
      } catch (e: unknown) {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 422) {
          setSnapshot({ lat, lon, status: 'hidden', data: null, receivedAtMs: null });
        } else {
          // Retain the last estimate, while marking it unsuitable as current evidence.
          setSnapshot((last) => ({ ...last, status: 'error' }));
        }
      } finally {
        loading = false;
      }
    };
    void load();
    const refreshId = window.setInterval(() => void load(), REFRESH_MS);
    const clockId = window.setInterval(() => setClockMs(Date.now()), 60_000);
    // timers sleep while the page is hidden: coming back shows a new estimate, not the one from before
    const back = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastMs > STALE_ON_RETURN_MS) void load();
    };
    document.addEventListener('visibilitychange', back);
    window.addEventListener('focus', back);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', back);
      window.removeEventListener('focus', back);
      window.clearInterval(refreshId);
      window.clearInterval(clockId);
    };
  }, [lat, lon]);

  return { snapshot: nowcastForPoint(snapshot, lat, lon), nowMs: Math.max(clockMs, Date.now()) };
}
