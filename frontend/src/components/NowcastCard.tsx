'use client';

import { useEffect, useState } from 'react';
import { api, ApiError, type Nowcast } from '../lib/api';
import { fmtHour } from '../lib/format';
import { nowcastSentence } from '../lib/nowcastText';
import { useT } from '../i18n';
import { Icon } from './Icon';
import { PushControl } from './PushControl';

const REFRESH_MS = 5 * 60 * 1000;

interface Props {
  lat: number;
  lon: number;
}

/**
 * Radar nowcast for the selected point: will rain / a thunderstorm reach it within the hour,
 * plus any tropical cyclone near Thailand.  Refreshes every 5 minutes while mounted.
 */
export function NowcastCard({ lat, lon }: Props) {
  const { t, lang } = useT();
  const [data, setData] = useState<Nowcast | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'hidden'>('loading');

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setState('loading');
    const load = () =>
      api
        .nowcast(lat, lon)
        .then((d) => {
          if (cancelled) return;
          setData(d);
          setState('ready');
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          // outside the nowcast domain: nothing useful to show
          if (e instanceof ApiError && e.status === 422) setState('hidden');
          else setState((s) => (s === 'ready' ? s : 'error')); // keep the last good card on a failed refresh
        });
    load();
    const id = window.setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [lat, lon]);

  if (state === 'hidden') return null;
  if (state === 'loading') return <div className="skeleton" style={{ height: 88 }} aria-busy="true" />;
  if (state === 'error' || !data) {
    return (
      <section className="panel-section nowcast" aria-labelledby="nowcast-h">
        <h3 id="nowcast-h">{t('nowcastTitle')}</h3>
        <p className="muted" style={{ fontSize: 'var(--font-size-sm)' }}>
          {t('nowcastError')}
        </p>
      </section>
    );
  }

  const text = nowcastSentence(data, lang);
  const frame = data.frame_time ? `${t('radarAt')} ${fmtHour(data.frame_time, lang)}${lang === 'th' ? ' น.' : ''}` : null;

  return (
    <section className="panel-section nowcast" aria-labelledby="nowcast-h">
      <h3 id="nowcast-h">{t('nowcastTitle')}</h3>
      <div className="nowcast-card" data-sev={text.severity} role="status">
        <Icon name={text.icon} className="nowcast-icon" />
        <div className="nowcast-body">
          <p className="nowcast-headline">{text.headline}</p>
          {text.details.length > 0 && (
            <ul className="nowcast-lines">
              {text.details.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {text.cyclones.map((c) => (
        <div className="nowcast-card" data-sev={c.severity} key={c.id}>
          <Icon name="cyclone" className="nowcast-icon" />
          <div className="nowcast-body">
            <p className="nowcast-headline nowcast-headline--sm">{c.text}</p>
            {c.url && (
              <a className="nowcast-link" href={c.url} target="_blank" rel="noopener noreferrer">
                {t('cyclones')} · GDACS
              </a>
            )}
          </div>
        </div>
      ))}

      <PushControl lat={lat} lon={lon} />

      <p className="nowcast-meta subtle">
        {frame && <span>{frame} · </span>}
        {t('radarEstimate')}
        {data.attribution.length > 0 && (
          <>
            {' · '}
            {t('dataFrom')}:{' '}
            {data.attribution.map((a, i) => (
              <span key={a.name}>
                {i > 0 && ', '}
                <a href={a.url} target="_blank" rel="noopener noreferrer">
                  {a.name}
                </a>
              </span>
            ))}
          </>
        )}
      </p>
    </section>
  );
}
