'use client';

import { useId } from 'react';
import { useT } from '../i18n';
import { Icon } from './Icon';

export type LocateStatus = 'idle' | 'locating' | 'denied' | 'failed';

/** Icon-only location control in the map toolbar, with progress and actionable error feedback. */
export function LocateCta({
  status,
  onLocate,
}: {
  status: LocateStatus;
  onLocate: () => void;
}) {
  const { t } = useT();
  const hintId = useId();
  const busy = status === 'locating';
  const error = status === 'denied' || status === 'failed';
  const hint = busy ? t('locating') : status === 'denied' ? t('locateDenied') : status === 'failed' ? t('locateFailed') : t('locateHint');
  return (
    <div className="map-locate">
      <button
        type="button"
        className="btn btn--icon"
        onClick={onLocate}
        disabled={busy}
        aria-label={t('locateCta')}
        title={t('locateCta')}
        aria-busy={busy}
        aria-describedby={hintId}
      >
        {busy ? <span className="spinner" /> : <Icon name="locate" />}
      </button>
      <span className={error ? 'map-locate-error glass' : 'sr-only'} id={hintId} role={error ? 'alert' : 'status'}>
        {hint}
      </span>
    </div>
  );
}
