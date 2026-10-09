import { useEffect, useState } from 'react';
import { api, type RadarFrame } from './api';

const REFRESH_MS = 5 * 60 * 1000;

export type RadarState = { status: 'off' | 'loading' | 'ready' | 'unavailable'; frame: RadarFrame | null };

/** Latest radar frame while `enabled`; refreshed every 5 minutes. 404 / errors → 'unavailable'. */
export function useRadar(enabled: boolean): RadarState {
  const [state, setState] = useState<RadarState>({ status: 'off', frame: null });
  useEffect(() => {
    if (!enabled) {
      setState({ status: 'off', frame: null });
      return;
    }
    let cancelled = false;
    setState((s) => (s.status === 'ready' ? s : { status: 'loading', frame: null }));
    const load = () =>
      api
        .nowcastLayer(0)
        .then((frame) => !cancelled && setState(frame ? { status: 'ready', frame } : { status: 'unavailable', frame: null }))
        .catch(() => !cancelled && setState((s) => (s.status === 'ready' ? s : { status: 'unavailable', frame: null })));
    load();
    const id = window.setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [enabled]);
  return state;
}
