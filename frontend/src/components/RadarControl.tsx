'use client';

import { cssGradient, radarScale } from '../lib/color';
import { fmtHour } from '../lib/format';
import type { RadarState } from '../lib/useRadar';
import { useT } from '../i18n';
import { Icon } from './Icon';

/**
 * Radar box on the map: the observed frame's time (latest / past), Play through the last hour and a
 * frame slider.  Labels always describe the frame on screen, never a selection that is still loading.
 */
export function RadarControl({
  radar,
  active,
  playing,
  onPlaying,
  onSelect,
}: {
  radar: RadarState;
  /** the timeline is on the current hour, so the radar is on the map */
  active: boolean;
  playing: boolean;
  onPlaying: (p: boolean) => void;
  onSelect: (id: string) => void;
}) {
  const { t, lang } = useT();
  const th = lang === 'th';
  const { frame, frames, selectedId } = radar;

  if (radar.status === 'loading' && !frame) {
    return (
      <div className="radar-tag glass" role="status">
        <span className="muted">{t('loading')}</span>
      </div>
    );
  }
  if (!frame) {
    return (
      <div className="radar-tag glass" role="status">
        <span className="muted">{t('radarOff')}</span>
      </div>
    );
  }

  const index = Math.max(0, frames.findIndex((f) => f.id === selectedId));
  const time = `${fmtHour(frame.frameTime, lang)}${th ? ' น.' : ''}`;
  return (
    <div className="radar-tag glass" role="group" aria-label={t('radar')} data-active={active ? undefined : 'false'}>
      <div className="radar-head">
        {frames.length > 1 && (
          <button
            type="button"
            className="radar-play"
            onClick={() => onPlaying(!playing)}
            aria-label={playing ? t('radarPause') : t('radarPlay')}
            title={playing ? t('radarPause') : t('radarPlay')}
          >
            <Icon name={playing ? 'pause' : 'play'} />
          </button>
        )}
        <span aria-live={playing ? 'off' : 'polite'}>
          <b>
            {radar.isLatest ? t('radarLatest') : t('radarPast')} {time}
          </b>
          {radar.pending && <span className="spinner radar-spinner" aria-label={t('loading')} />}
        </span>
      </div>
      {frames.length > 1 && (
        <input
          className="range radar-range"
          type="range"
          min={0}
          max={frames.length - 1}
          value={index}
          onChange={(e) => onSelect(frames[Number(e.target.value)].id)}
          aria-label={t('radarFrames')}
          aria-valuetext={`${fmtHour(frames[index].time, lang)}${th ? ' น.' : ''}`}
        />
      )}
      {!active && <p className="radar-note radar-note--muted">{t('radarFutureHidden')}</p>}
      {radar.stale && <p className="radar-note">{t('radarStale')}</p>}
      {radar.refreshError && <p className="radar-note">{t('radarRefreshFailed')}</p>}
      <div className="radar-tag-bar" style={{ background: cssGradient(radarScale, 12, 70) }} aria-hidden="true" />
      <div className="radar-tag-scale muted" aria-hidden="true">
        {[20, 40, 60].map((v) => (
          <span key={v} style={{ left: `${((v - 12) / 58) * 100}%` }}>
            {v}
          </span>
        ))}
      </div>
      <span className="muted radar-credit">{th ? 'ภาพตรวจวัดจริง' : 'Observed'} · RainViewer</span>
    </div>
  );
}
