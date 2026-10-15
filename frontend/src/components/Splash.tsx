'use client';

import { useEffect, useState } from 'react';
import { LogoMark } from '@/components/Logo';
import { useT } from '@/i18n';

/** Fired by WeatherMap once the first weather layer is on the map (or failed to load). */
export const MAP_READY_EVENT = 'thwx:map-ready';
/** never keep the map covered longer than this, whatever happens to the data */
const MAX_MS = 8000;
const FADE_MS = 350;

// Once per page load: coming back to the map from another page shows it at once.
let dismissed = false;

/**
 * The opening screen of the map: logo, name and a thin progress line over the map until its first
 * weather layer is drawn, then a short fade. Rendered on the server too, so it is the first thing
 * painted (no blank or half-built map while the scripts and data load).
 */
export function Splash() {
  const { t } = useT();
  const [state, setState] = useState<'shown' | 'fading' | 'gone'>(dismissed ? 'gone' : 'shown');

  useEffect(() => {
    if (state !== 'shown') return;
    const hide = () => {
      dismissed = true;
      setState('fading');
    };
    const maxTimer = window.setTimeout(hide, MAX_MS);
    window.addEventListener(MAP_READY_EVENT, hide, { once: true });
    return () => {
      window.clearTimeout(maxTimer);
      window.removeEventListener(MAP_READY_EVENT, hide);
    };
  }, [state]);

  useEffect(() => {
    if (state !== 'fading') return;
    const t = window.setTimeout(() => setState('gone'), FADE_MS);
    return () => window.clearTimeout(t);
  }, [state]);

  if (state === 'gone') return null;
  return (
    <div className="splash" data-state={state} role="status" aria-live="polite" aria-label={t('loading')}>
      <div className="splash-inner">
        <LogoMark className="brand-mark splash-mark" />
        <p className="splash-name">{t('brand')}</p>
        <p className="splash-tagline">{t('tagline')}</p>
        <span className="splash-bar" aria-hidden="true" />
      </div>
    </div>
  );
}
