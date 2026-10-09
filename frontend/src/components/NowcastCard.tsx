'use client';

import { fmtStep } from '../lib/format';
import { isFreshRadar, nowcastSentence, radarAgeMinutes, type NowcastSnapshot } from '../lib/nowcastText';
import { useT } from '../i18n';
import { Icon } from './Icon';
import { PushControl } from './PushControl';

interface Props {
  lat: number;
  lon: number;
  snapshot: NowcastSnapshot;
  nowMs: number;
}

/**
 * Radar nowcast for the selected point: will rain / a thunderstorm reach it within the hour,
 * plus any tropical cyclone near Thailand. The parent supplies the shared response.
 */
export function NowcastCard({ lat, lon, snapshot, nowMs }: Props) {
  const { t, lang } = useT();
  const { data, status: state } = snapshot;

  if (state === 'hidden') return null;
  if (state === 'loading') return <div className="skeleton" style={{ height: 88 }} aria-busy="true" />;
  if (!data) {
    return (
      <section className="panel-section nowcast" aria-labelledby="nowcast-h">
        <h3 id="nowcast-h">{t('nowcastTitle')}</h3>
        <p className="muted" style={{ fontSize: 'var(--font-size-sm)' }}>
          {t('nowcastError')}
        </p>
      </section>
    );
  }

  const age = radarAgeMinutes(snapshot, nowMs);
  // A retained response can age out even when no later request succeeds.
  const currentData = data.available && !isFreshRadar(snapshot, nowMs)
    ? { ...data, available: false, reason: age === null ? 'no_data' as const : 'stale' as const, age_min: age === null ? null : Math.round(age) }
    : data;
  const text = nowcastSentence(currentData, lang);
  const retained = state === 'error';
  const frame = data.frame_time && Number.isFinite(Date.parse(data.frame_time))
    ? `${t('radarAt')} ${fmtStep(data.frame_time, lang)}`
    : null;

  return (
    <section className="panel-section nowcast" aria-labelledby="nowcast-h">
      <h3 id="nowcast-h">{t('nowcastTitle')}</h3>
      <p className="nowcast-meta subtle">
        {t('radarOutlook')}
        {frame && <><br />{frame}</>}
      </p>
      {retained && <p className="nowcast-meta muted" role="status">{t('radarRefreshError')}</p>}
      <div className="nowcast-card" data-sev={text.severity} role="status">
        <Icon name={text.icon} className="nowcast-icon" />
        <div className="nowcast-body">
          <p className="nowcast-headline">{retained && currentData.available ? t('radarLastEstimate', { text: text.headline }) : text.headline}</p>
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
