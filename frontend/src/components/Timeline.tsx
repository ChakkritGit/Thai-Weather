'use client';

import type { RunMeta } from '../lib/api';
import { fmtDay, fmtStep, nearestStep, thaiDate, thaiHour } from '../lib/format';
import { useT } from '../i18n';
import { Icon } from './Icon';
import { ScrubRange } from './ScrubRange';

interface Props {
  run: RunMeta;
  daily: boolean;
  index: number;
  /** the current hour's step, from MapPage's clock (so it moves on while the page stays open) */
  nowIndex?: number;
  onChange: (i: number) => void;
  playing: boolean;
  onPlaying: (p: boolean) => void;
  /** replaces the hour label, e.g. the radar frame's time while the radar part of playback runs */
  label?: string;
}

/** Hourly / daily time control. Playback itself runs in MapPage, so the radar and forecast stay in step. */
export function Timeline({ run, daily, index, nowIndex, onChange, playing, onPlaying, label }: Props) {
  const { t, lang } = useT();
  const n = daily ? run.days.length : run.times.length;

  if (daily) {
    return (
      <div className="timeline glass">
        <Icon name="drop" style={{ width: 20, height: 20, margin: '0 8px' }} />
        <div className="day-tabs" role="radiogroup" aria-label={t('daily')}>
          {run.days.map((d, i) => (
            <button key={d.date} type="button" className="chip" role="radio" aria-checked={i === index} onClick={() => onChange(i)}>
              {fmtDay(d.date, lang)}
              {d.hours < 24 && <span className="subtle">({d.hours} {lang === 'th' ? 'ชม.' : 'h'})</span>}
            </button>
          ))}
        </div>
      </div>
    );
  }

  const nowIdx = nowIndex ?? nearestStep(run.times);
  const midnights = run.times.map((tm, i) => (i > 0 && thaiHour(tm) === 0 ? i : -1)).filter((i) => i >= 0);
  // the first (partial) day keeps its label only when there is room before the next day's
  const dayStarts = midnights.length && midnights[0] / Math.max(1, run.times.length - 1) < 0.12 ? midnights : [0, ...midnights];
  return (
    <div className="timeline glass">
      <button
        type="button"
        className="timeline-play"
        onClick={() => onPlaying(!playing)}
        aria-label={playing ? t('pause') : t('play')}
      >
        <Icon name={playing ? 'pause' : 'play'} />
      </button>
      <div className="timeline-body">
        <div className="timeline-label">
          <span aria-live={playing ? 'off' : 'polite'}>{label ?? fmtStep(run.times[index], lang)}</span>
          {index !== nowIdx ? (
            <button type="button" className="btn btn--ghost timeline-now-btn" onClick={() => onChange(nowIdx)}>
              {t('now')}
            </button>
          ) : (
            <span className="now-chip">{t('now')}</span>
          )}
        </div>
        <ScrubRange max={n - 1} value={index} onChange={onChange} aria-label={t('time')} aria-valuetext={fmtStep(run.times[index], lang)} />
        <div className="timeline-days" aria-hidden="true">
          {dayStarts.map((i) => (
            <span key={i} style={{ left: `calc(${(i / (n - 1)) * 100}% )` }}>
              {fmtDay(thaiDate(run.times[i]), lang)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
