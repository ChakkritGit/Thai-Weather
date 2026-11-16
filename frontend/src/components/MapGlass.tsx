'use client';

import { useEffect, useLayoutEffect, useState } from 'react';
import type { Map as MLMap } from 'maplibre-gl';
import { createMapGlass } from '../lib/mapGlass';

/** One map's glass layer over the page's glass elements; true once it has drawn. */
function useGlassLayer(map: MLMap | null, off: boolean): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!map || off) return;
    const g = createMapGlass({ map, onActive: setOn });
    return () => {
      g?.destroy();
      setOn(false);
    };
  }, [map, off]);
  return on;
}

/**
 * Run the WebGL glass over the maps for the page's glass elements (every `<GlassPane/>` host and the bottom nav): one
 * glass layer in each map that is on screen (the fine map, and the coarse one in compare mode, where each draws the
 * elements over its own side of the split). Returns whether the glass is drawing, which is when the panes stop
 * rendering Glisse's glass. While it is, `<html data-map-glass="on">` lets base.css restyle the elements, the nav
 * included; leaving the page removes it, so the nav keeps Glisse's glass on every other page.
 */
export function useMapGlass(fine: MLMap | null, coarse: MLMap | null): boolean {
  const [reduced, setReduced] = useState(false);
  // a reader who asked for less transparency keeps the opaque panes
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-transparency: reduce)');
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  const fineOn = useGlassLayer(fine, reduced);
  // the coarse map's layer follows the fine one's state: the glass must not flash back to Glisse while it starts
  useGlassLayer(coarse, reduced);
  // before paint, in the commit that drops Glisse's panes: no frame with neither glass
  useLayoutEffect(() => {
    if (!fineOn) return;
    const root = document.documentElement;
    root.dataset.mapGlass = 'on';
    return () => {
      delete root.dataset.mapGlass;
    };
  }, [fineOn]);
  return fineOn;
}
