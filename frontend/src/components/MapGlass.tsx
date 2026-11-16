'use client';

import { createContext, useContext, useEffect, useRef, useState, type RefObject } from 'react';
import type { Map as MLMap } from 'maplibre-gl';
import { createMapGlass, type MapGlass } from '../lib/mapGlass';
import { GlassPane } from './GlassPane';

/** True while the WebGL glass (lib/mapGlass.ts) draws under the toolbar's buttons. */
const MapGlassContext = createContext(false);
export const MapGlassProvider = MapGlassContext.Provider;

/**
 * A map button's glass: Glisse's pane until the WebGL glass has drawn its first frame, and again whenever that cannot
 * draw (no WebGL 2, a lost context, reduced transparency), so the fallback is exactly the pane the page had before.
 */
export function ToolGlass() {
  return useContext(MapGlassContext) ? null : <GlassPane />;
}

/** One map's glass layer over the buttons in `host`; true once it has drawn. */
function useGlassLayer(host: RefObject<HTMLElement | null>, map: MLMap | null, suspended: boolean, off: boolean): boolean {
  const [on, setOn] = useState(false);
  const glass = useRef<MapGlass | null>(null);
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;
  useEffect(() => {
    const h = host.current;
    if (!h || !map || off) return;
    const g = createMapGlass({ host: h, map, onActive: setOn });
    g?.setSuspended(suspendedRef.current);
    glass.current = g;
    return () => {
      glass.current = null;
      g?.destroy();
      setOn(false);
    };
  }, [host, map, off]);
  useEffect(() => {
    glass.current?.setSuspended(suspended);
  }, [suspended]);
  return on;
}

/**
 * Run the WebGL glass over the maps for the buttons inside `host`: one glass layer in each map that is on screen (the
 * fine map, and the coarse one in compare mode, where each draws the buttons over its own side of the split).
 * `suspended` is for a toolbar that is faded out. Returns whether the glass is drawing, which is when the buttons stop
 * rendering their Glisse panes.
 */
export function useMapGlass(host: RefObject<HTMLElement | null>, fine: MLMap | null, coarse: MLMap | null, suspended: boolean): boolean {
  const [reduced, setReduced] = useState(false);
  // a reader who asked for less transparency keeps the opaque panes
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-transparency: reduce)');
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  const fineOn = useGlassLayer(host, fine, suspended, reduced);
  // the coarse map's layer follows the fine one's state: the buttons must not flash back to Glisse while it starts
  useGlassLayer(host, coarse, suspended, reduced);
  return fineOn;
}
