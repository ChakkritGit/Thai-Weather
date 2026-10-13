'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import '@/design/push.css';
import { paths } from '../lib/paths';
import { roundCoord } from '../lib/push';
import { usePush } from '../lib/usePush';
import { useT } from '../i18n';
import type { DictKey } from '../i18n/dict';
import { Icon } from './Icon';
import { Bell, PushControl } from './PushControl';

type Point = { lat: number; lon: number };
type Source = 'link' | 'saved' | 'here';

const SOURCE: Record<Source, DictKey> = { link: 'pushFromLink', saved: 'pushFromSaved', here: 'locateHint' };

/**
 * Web Push settings on the alerts page (`/alerts#notifications`).
 * Location order: a valid `?lat&lon` from the map → this device's saved subscription → the user picks
 * (current location or the map). It never chooses coordinates or asks for permission on its own, and
 * works while the forecast is still warming up.
 */
export function PushSettings({ initial }: { initial: Point | null }) {
  const { t, lang } = useT();
  const push = usePush();
  const [point, setPoint] = useState<Point | null>(initial);
  const [source, setSource] = useState<Source | null>(initial ? 'link' : null);
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState<DictKey | null>(null);

  // no point in the link: fall back to where this device is already subscribed
  useEffect(() => {
    if (!point && push.stored) {
      setPoint({ lat: push.stored.lat, lon: push.stored.lon });
      setSource('saved');
    }
  }, [point, push.stored]);

  const useHere = () => {
    if (!navigator.geolocation) {
      setLocateError('locateFailed');
      return;
    }
    setLocating(true);
    setLocateError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        setPoint({ lat: pos.coords.latitude, lon: pos.coords.longitude });
        setSource('here');
      },
      (err) => {
        setLocating(false);
        setLocateError(err.code === err.PERMISSION_DENIED ? 'locateDenied' : 'locateFailed');
      },
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 },
    );
  };

  const unsupported = push.support === 'unsupported';

  return (
    <section id="notifications" className="card card-pad push-settings" aria-labelledby="notifications-h">
      <h2 id="notifications-h" className="push-settings-title">
        <Bell /> {t('pushSection')}
      </h2>
      <p className="muted push-settings-lead">{t('pushSectionLead')}</p>

      {unsupported ? (
        <p className="push-note">{t('pushUnsupported')}</p>
      ) : (
        <>
          <div className="push-place">
            <div className="push-place-text">
              <span className="push-legend">{t('pushPlace')}</span>
              {point ? (
                <span>
                  <b className="num">
                    {roundCoord(point.lat).toFixed(2)}°N {roundCoord(point.lon).toFixed(2)}°E
                  </b>
                  {source && <span className="subtle"> · {t(SOURCE[source])}</span>}{' '}
                  <Link href={paths.mapAt(point.lat, point.lon)}>{lang === 'th' ? 'ดูบนแผนที่' : 'View on map'}</Link>
                </span>
              ) : (
                <span className="muted">{t('pushNoPlace')}</span>
              )}
            </div>
            <div className="push-actions">
              <button type="button" className="btn" onClick={useHere} disabled={locating}>
                {locating ? <span className="spinner" /> : <Icon name="locate" />}
                {locating ? t('locating') : t('pushUseHere')}
              </button>
              <Link className="btn btn--ghost" href={paths.map}>
                <Icon name="map" />
                {t('pushPickMap')}
              </Link>
            </div>
            {locateError && (
              <p className="push-msg" data-kind="error" role="alert">
                {t(locateError)}
              </p>
            )}
          </div>
          {point && <PushControl lat={point.lat} lon={point.lon} push={push} />}
        </>
      )}
    </section>
  );
}

/** On the map's point panel: a link to the settings for that point (the form itself lives on /alerts). */
export function PushSettingsLink({ lat, lon }: { lat: number; lon: number }) {
  const { t } = useT();
  const push = usePush();
  if (push.support === 'checking' || push.support === 'unsupported') return null;
  const here = !!push.stored && Math.abs(push.stored.lat - roundCoord(lat)) < 0.015 && Math.abs(push.stored.lon - roundCoord(lon)) < 0.015;
  return (
    <Link className="push-box push-link" href={paths.alertSettings(lat, lon)}>
      <span className="push-title">
        <Bell /> {here ? t('pushOn') : t('pushOpenSettings')}
      </span>
      <span className="push-link-cta">
        {here ? t('pushManage') : t('pushEnable')}
        <Icon name="chevron" width={16} />
      </span>
    </Link>
  );
}
