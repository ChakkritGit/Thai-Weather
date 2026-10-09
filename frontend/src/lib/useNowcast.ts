import { useEffect, useState } from 'react';
import { api, ApiError } from './api';
import { nowcastForPoint, type NowcastSnapshot } from './nowcastText';

const REFRESH_MS = 5 * 60_000;

/** One point-nowcast request supplies both the radar card and the model comparison. */
export function useNowcast(lat: number, lon: number) {
  const [snapshot, setSnapshot] = useState<NowcastSnapshot>({
    lat, lon, status: 'loading', data: null, receivedAtMs: null,
  });
  const [clockMs, setClockMs] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    let loading = false;
    setSnapshot({ lat, lon, status: 'loading', data: null, receivedAtMs: null });
    const load = async () => {
      // A slow request must not overlap the next refresh and overwrite a newer result.
      if (loading) return;
      loading = true;
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
    return () => {
      cancelled = true;
      window.clearInterval(refreshId);
      window.clearInterval(clockId);
    };
  }, [lat, lon]);

  return { snapshot: nowcastForPoint(snapshot, lat, lon), nowMs: Math.max(clockMs, Date.now()) };
}
