import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type RadarFrame } from './api';
import { normaliseFrames, selectAfterUpdate, type RadarFrameInfo } from './radarHistory';

/** RainViewer adds a frame every 10 min and the server polls every ~5: checking the list every 2 min is plenty. */
const LIST_MS = 2 * 60 * 1000;

export interface RadarState {
  status: 'off' | 'loading' | 'ready' | 'unavailable';
  /** the frame on screen; its `frameTime` is what the UI labels (never the selection still loading) */
  frame: RadarFrame | null;
  frames: RadarFrameInfo[];
  selectedId: string | null;
  /** the frame on screen is the newest observed one */
  isLatest: boolean;
  /** the selected frame is still downloading (the previous one stays on screen) */
  pending: boolean;
  /** the newest frame is older than the server's freshness limit */
  stale: boolean;
  /** the last list refresh failed; the frames already loaded stay usable */
  refreshError: boolean;
  select: (id: string) => void;
  /** the frame is downloaded (playback waits for it instead of skipping ahead) */
  isLoaded: (id: string) => boolean;
}

/**
 * Observed radar frames of the last ~hour while `enabled`: the newest by default, new frames appended as
 * the server publishes them – without moving a past frame the user picked.  Playback is driven by the
 * map page, which runs the radar and the forecast timeline as one sequence (see MapPage).
 */
export function useRadar(enabled: boolean): RadarState {
  const [frames, setFrames] = useState<RadarFrameInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [shown, setShown] = useState<RadarFrame | null>(null);
  const [shownId, setShownId] = useState<string | null>(null);
  const [status, setStatus] = useState<RadarState['status']>('off');
  const [stale, setStale] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const cache = useRef(new Map<string, RadarFrame>());
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;
  const framesRef = useRef<RadarFrameInfo[]>([]);
  framesRef.current = frames;

  // ------------------------------------------------------------ frame list (poll)
  useEffect(() => {
    if (!enabled) {
      setStatus('off');
      setFrames([]);
      setSelectedId(null);
      setShown(null);
      setShownId(null);
      cache.current.clear();
      return;
    }
    let cancelled = false;
    setStatus((s) => (s === 'ready' ? s : 'loading'));
    const load = () =>
      api
        .radarFrames()
        .then((d) => {
          if (cancelled) return;
          const list = normaliseFrames(d.frames);
          const prev = framesRef.current;
          const onLatest = selectedRef.current === null || selectedRef.current === prev[prev.length - 1]?.id;
          const keep = new Set(list.map((f) => f.id));
          for (const id of cache.current.keys()) if (!keep.has(id)) cache.current.delete(id);
          setFrames(list);
          setStale(d.stale);
          setRefreshError(false);
          setSelectedId(selectAfterUpdate(list, selectedRef.current, onLatest));
          setStatus(list.length ? 'ready' : 'unavailable');
        })
        .catch(() => {
          if (cancelled) return;
          setRefreshError(true);
          setStatus((s) => (s === 'ready' ? s : 'unavailable'));
        });
    load();
    const id = window.setInterval(load, LIST_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [enabled]);

  // ------------------------------------------------------------ download frames (selected first, then the rest)
  const [loadedTick, setLoadedTick] = useState(0);
  useEffect(() => {
    if (!enabled || frames.length === 0) return;
    let cancelled = false;
    const order = [...frames].sort((a, b) => (a.id === selectedId ? -1 : b.id === selectedId ? 1 : Number(b.id) - Number(a.id)));
    (async () => {
      for (const f of order) {
        if (cancelled) return;
        if (cache.current.has(f.id)) continue;
        try {
          const frame = await api.radarFrame(f.id, f.time);
          if (cancelled) return;
          if (frame) {
            cache.current.set(f.id, frame);
            setLoadedTick((n) => n + 1);
          }
        } catch {
          /* keep what is on screen; the next list poll retries */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, frames, selectedId]);

  // show the selected frame once it is downloaded (until then the previous one stays, with its own time)
  useEffect(() => {
    if (!selectedId) return;
    const f = cache.current.get(selectedId);
    if (f) {
      setShown(f);
      setShownId(selectedId);
    }
  }, [selectedId, loadedTick]);

  const select = useCallback((id: string) => setSelectedId(id), []);
  const isLoaded = useCallback((id: string) => cache.current.has(id), []);

  const latestId = frames[frames.length - 1]?.id ?? null;
  return {
    status,
    frame: shown,
    frames,
    selectedId,
    isLatest: shownId !== null && shownId === latestId,
    pending: selectedId !== null && selectedId !== shownId,
    stale,
    refreshError,
    select,
    isLoaded,
  };
}
