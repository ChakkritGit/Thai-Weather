'use client';

import { createContext, useCallback, useContext, type CSSProperties } from 'react';
import { Glass } from 'glisse';
import { trackGlassHost } from '../lib/mapGlass';

// inline: Glisse adds its own stylesheet at run time, after ours, and its .lg-glass is position: relative
const placed: CSSProperties = { position: 'absolute', inset: 0, zIndex: -1, borderRadius: 'inherit', pointerEvents: 'none' };

/** True while the WebGL glass (lib/mapGlass.ts) draws under the map page's glass elements. */
const MapGlassContext = createContext(false);
export const MapGlassProvider = MapGlassContext.Provider;

/**
 * Liquid Glass under a floating surface, as the host's first child. The host needs position and `isolation: isolate`
 * (base.css). While the map's WebGL glass draws, that glass is the pane and nothing is rendered here but the hidden
 * mark that tells the map which element to draw it under; otherwise Glisse's pane: Chromium bends the live map at the
 * rim, Safari and Firefox keep the blur and the rim light.
 */
export function GlassPane() {
  const webgl = useContext(MapGlassContext);
  // a stable callback: a new one each render would unregister and register the host on every update of the page
  const mark = useCallback((m: HTMLElement | null) => (m?.parentElement ? trackGlassHost(m.parentElement) : undefined), []);
  return (
    <>
      {/* the mark always renders: the map finds the hosts through it before the glass has drawn once */}
      <span className="wgl-pane" hidden aria-hidden ref={mark} />
      {!webgl && <Glass aria-hidden style={placed} />}
    </>
  );
}
