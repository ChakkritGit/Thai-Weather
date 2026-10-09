'use client';

import { useEffect } from 'react';
import type { RunMeta } from '../lib/api';
import { fmtDay, fmtStep, nearestStep, thaiDate, thaiHour } from '../lib/format';
import { useT } from '../i18n';
import { Icon } from './Icon';

interface Props {
  run: RunMeta;
  daily: boolean;
  index: number;
  onChange: (i: number) => void;
  playing: boolean;
  onPlaying: (p: boolean) => void;
}

export function Timeline({ run, daily, index, onChange, playing, onPlaying }: Props) {
  const { t, lang } = useT();
  const n = daily ? run.days.length : run.times.length;

  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => onChange((index + 1) % n), daily ? 1400 : 650);
    return () => window.clearInterval(id);
  }, [playing, index, n, daily, onChange]);

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

  const nowIdx = nearestStep(run.times);
  const dayStarts = run.times.map((tm, i) => (i === 0 || thaiHour(tm) === 0 ? i : -1)).filter((i) => i >= 0);
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
          <span aria-live="polite">{fmtStep(run.times[index], lang)}</span>
          {index !== nowIdx ? (
            <button type="button" className="btn btn--ghost timeline-now-btn" onClick={() => onChange(nowIdx)}>
              {t('now')}
            </button>
          ) : (
            <span className="now-chip">{t('now')}</span>
          )}
        </div>
        <input
          className="range"
          type="range"
          min={0}
          max={n - 1}
          value={index}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label={t('time')}
          aria-valuetext={fmtStep(run.times[index], lang)}
        />
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
