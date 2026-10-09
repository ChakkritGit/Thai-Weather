'use client';

import { useT } from '../i18n';
import { Icon } from './Icon';

export type LocateStatus = 'idle' | 'locating' | 'denied' | 'failed';

/**
 * "Forecast where I am" – the first thing a visitor usually wants. Rendered as a
 * calm card above the overview (desktop sidebar) or a floating pill over the
 * map (mobile). MapPage owns the geolocation call and passes `onLocate`.
 */
export function LocateCta({
  variant,
  status,
  onLocate,
}: {
  variant: 'card' | 'float';
  status: LocateStatus;
  onLocate: () => void;
}) {
  const { t } = useT();
  const busy = status === 'locating';
  const error = status === 'denied' || status === 'failed';
  const hint = busy ? t('locating') : status === 'denied' ? t('locateDenied') : status === 'failed' ? t('locateFailed') : t('locateHint');
  const button = (
    <button
      type="button"
      className={variant === 'float' ? 'locate-cta locate-float' : 'locate-cta'}
      onClick={onLocate}
      disabled={busy}
      data-error={error ? 'true' : undefined}
      aria-describedby={`locate-hint-${variant}`}
    >
      <span className="locate-cta-icon">{busy ? <span className="spinner" /> : <Icon name="locate" />}</span>
      <span className="locate-cta-text">
        <span className="locate-cta-title">{t('locateCta')}</span>
        <span className="locate-cta-hint" id={`locate-hint-${variant}`} data-error={error ? 'true' : undefined} role={error ? 'alert' : undefined}>
          {hint}
        </span>
      </span>
      <Icon name="chevron" className="chev" />
    </button>
  );
  // the sidebar variant sits in its own padded wrapper
  return variant === 'card' ? <div className="locate-card">{button}</div> : button;
}
