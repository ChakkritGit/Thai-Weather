'use client';

import { cssGradient, radarScale } from '../lib/color';
import { fmtHour } from '../lib/format';
import type { RadarState } from '../lib/useRadar';
import { useT } from '../i18n';
import { Icon } from './Icon';
import { ScrubRange } from './ScrubRange';

/**
 * Radar strip in the map's bottom stack: the observed frame's time (latest / past) and a frame slider, with
 * the radar colours as a thin bar underneath. One line, so it does not cover the map; Play is the timeline's
 * (one playback runs the radar frames, then the forecast). Labels always describe the frame on screen.
 */
export function RadarControl({
  radar,
  active,
  onSelect,
}: {
  radar: RadarState;
  /** the timeline is on the current hour, so the radar is on the map */
  active: boolean;
  onSelect: (id: string) => void;
}) {
  const { t, lang } = useT();
  const th = lang === 'th';
  const { frame, frames, selectedId } = radar;

  const head = (text: React.ReactNode) => (
    <span className="radar-strip-label">
      <Icon name="radar" />
      {text}
    </span>
  );
  if (!frame) {
    return (
      <div className="radar-strip glass" role="status">
        {head(<span className="muted">{radar.status === 'loading' ? t('loading') : t('radarOff')}</span>)}
      </div>
    );
  }

  const index = Math.max(0, frames.findIndex((f) => f.id === selectedId));
  const time = `${fmtHour(frame.frameTime, lang)}${th ? ' น.' : ''}`;
  return (
    <div className="radar-strip glass" role="group" aria-label={t('radar')} data-active={active ? undefined : 'false'}>
      <div className="radar-strip-row">
        {head(
          <b aria-live="polite">
            {radar.isLatest ? t('radarLatest') : t('radarPast')} {time}
            {radar.pending && <span className="spinner radar-spinner" aria-label={t('loading')} />}
          </b>,
        )}
        {active && frames.length > 1 ? (
          <ScrubRange
            className="range radar-range"
            max={frames.length - 1}
            value={index}
            onChange={(i) => onSelect(frames[i].id)}
            aria-label={t('radarFrames')}
            aria-valuetext={`${fmtHour(frames[index].time, lang)}${th ? ' น.' : ''}`}
          />
        ) : (
          !active && <span className="radar-strip-note">{t('radarNowOnly')}</span>
        )}
      </div>
      {(radar.stale || radar.refreshError) && (
        <p className="radar-note">{radar.stale ? t('radarStale') : t('radarRefreshFailed')}</p>
      )}
      <div className="radar-strip-scale" title={`${th ? 'ภาพตรวจวัดจริง' : 'Observed'} · RainViewer`}>
        <span>{th ? 'เบา' : 'Light'}</span>
        <i style={{ background: cssGradient(radarScale, 12, 70) }} aria-hidden="true" />
        <span>{th ? 'หนัก' : 'Heavy'}</span>
        <span className="muted radar-credit">RainViewer</span>
      </div>
    </div>
  );
}
