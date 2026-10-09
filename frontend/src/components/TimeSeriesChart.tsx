'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { fmtHour, fmtKm, fmtNum, fmtStep, thaiHour } from '../lib/format';
import { useT } from '../i18n';

export interface ChartSeries {
  key: string;
  label: string;
  values: number[];
  kind: 'line' | 'bar';
  tone: 'fine' | 'coarse';
}

interface Props {
  title: string;
  times: string[];
  series: ChartSeries[];
  unit: string;
  digits?: number;
  height?: number;
  nowIndex?: number;
  zeroBased?: boolean;
  yMax?: number;
  /** grid resolutions in km, used for the direct line labels (falls back to the series label) */
  fineKm?: number;
  coarseKm?: number;
}

const M = { top: 10, right: 12, bottom: 22, left: 34 };

function niceTicks(lo: number, hi: number, count = 4): number[] {
  const span = hi - lo || 1;
  const raw = span / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => span / s <= count) ?? pow * 10;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

/**
 * Single-axis time-series chart (lines and/or bars sharing one unit) with a
 * crosshair tooltip. The fine series is solid blue, the coarse series dashed
 * orange – colour + dash so identity never relies on colour alone.
 */
export function TimeSeriesChart({ title, times, series, unit, digits = 1, height = 150, nowIndex, zeroBased, yMax, fineKm, coarseKm }: Props) {
  const { lang, t } = useT();
  const uid = useId();
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [byKeyboard, setByKeyboard] = useState(false);
  const figRef = useRef<HTMLElement>(null);

  // touch: keep the readout after the finger lifts, dismiss on a tap elsewhere
  useEffect(() => {
    if (hover === null) return;
    const away = (e: PointerEvent) => {
      if (!figRef.current?.contains(e.target as Node)) setHover(null);
    };
    window.addEventListener('pointerdown', away);
    return () => window.removeEventListener('pointerdown', away);
  }, [hover]);
  const [width, setWidth] = useState(340);
  useEffect(() => {
    const el = figRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const km = (s: ChartSeries) => (s.tone === 'fine' ? fineKm : coarseKm);
  const directLabel = (s: ChartSeries) => {
    const k = km(s);
    return k === undefined ? s.label : `${fmtKm(k, lang)} ${lang === 'th' ? 'กม.' : 'km'}`;
  };
  const n = times.length;
  const iw = width - M.left - M.right;
  const ih = height - M.top - M.bottom;

  const { lo, hi, ticks } = useMemo(() => {
    const all = series.flatMap((s) => s.values).filter(Number.isFinite);
    let lo = zeroBased ? 0 : Math.min(...all);
    let hi = Math.max(...all, zeroBased ? 1 : -Infinity);
    if (yMax !== undefined) hi = Math.max(hi, yMax);
    if (!zeroBased) {
      const pad = Math.max(1, (hi - lo) * 0.12);
      lo -= pad;
      hi += pad;
    } else hi *= 1.1;
    const ticks = niceTicks(lo, hi);
    return { lo: Math.min(lo, ticks[0]), hi: Math.max(hi, ticks[ticks.length - 1]), ticks };
  }, [series, zeroBased, yMax]);

  const x = (i: number) => M.left + (n <= 1 ? 0 : (i / (n - 1)) * iw);
  const y = (v: number) => M.top + ih - ((v - lo) / (hi - lo)) * ih;
  const barW = Math.max(1.5, (iw / n) * 0.62);
  const bars = series.filter((s) => s.kind === 'bar');

  const onMove = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * width;
    setByKeyboard(false);
    setHover(Math.max(0, Math.min(n - 1, Math.round(((px - M.left) / iw) * (n - 1)))));
  };

  const onKey = (e: React.KeyboardEvent) => {
    const at = hover ?? nowIndex ?? 0;
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = Math.min(n - 1, at + 1);
    else if (e.key === 'ArrowLeft') next = Math.max(0, at - 1);
    else if (e.key === 'PageDown') next = Math.min(n - 1, at + 6);
    else if (e.key === 'PageUp') next = Math.max(0, at - 6);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    else if (e.key === 'Escape') {
      setHover(null);
      return;
    }
    if (next === null) return;
    e.preventDefault();
    setByKeyboard(true);
    setHover(next);
  };

  const xTicks = times.map((t, i) => (thaiHour(t) % 6 === 0 ? i : -1)).filter((i) => i >= 0);
  const daySeps = times.map((t, i) => (i > 0 && thaiHour(t) === 0 ? i : -1)).filter((i) => i >= 0);
  const lineSeries = series.filter((s) => s.kind === 'line');
  const lastLabelled = lineSeries.length >= 2 && lineSeries.length <= 4;

  return (
    <figure className="chart" style={{ margin: 0 }} ref={figRef}>
      <figcaption className="sr-only">{title}</figcaption>
      <svg
        ref={ref}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={title}
        aria-describedby={`${uid}-hint`}
        tabIndex={0}
        onPointerMove={onMove}
        onPointerDown={onMove}
        onPointerLeave={(e) => {
          if (e.pointerType === 'mouse') setHover(null);
        }}
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
        style={{ touchAction: 'pan-y' }}
      >
        <g className="grid">
          {ticks.map((t) => (
            <line key={t} x1={M.left} x2={width - M.right} y1={y(t)} y2={y(t)} />
          ))}
        </g>
        <g className="axis">
          {ticks.map((t) => (
            <text key={t} x={M.left - 6} y={y(t) + 3} textAnchor="end">
              {fmtNum(t, t % 1 ? 1 : 0)}
            </text>
          ))}
          {xTicks.map((i) => (
            <text key={i} x={x(i)} y={height - 6} textAnchor="middle">
              {fmtHour(times[i], lang).slice(0, 2)}
            </text>
          ))}
        </g>
        {daySeps.map((i) => (
          <line key={i} className="day-sep" x1={x(i)} x2={x(i)} y1={M.top} y2={M.top + ih} />
        ))}
        {bars.map((s, k) => (
          <g key={s.key}>
            {s.values.map((v, i) =>
              v > 0 ? (
                <rect
                  key={i}
                  className={`bar--${s.tone}`}
                  x={x(i) - barW / 2 + (bars.length > 1 ? (k - 0.5) * (barW / 2) : 0)}
                  width={bars.length > 1 ? barW / 2 : barW}
                  y={y(v)}
                  height={Math.max(0, y(lo) - y(v))}
                  rx={Math.min(2, barW / 4)}
                />
              ) : null,
            )}
          </g>
        ))}
        {lineSeries.map((s) => (
          <polyline
            key={s.key}
            className={`line line--${s.tone}`}
            points={s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}
          />
        ))}
        {lastLabelled &&
          lineSeries.map((s) => {
            const v = s.values[n - 1];
            return (
              <text key={s.key} className="direct-label" x={x(n - 1) - 2} y={y(v) - 6} textAnchor="end">
                {directLabel(s)}
              </text>
            );
          })}
        {nowIndex !== undefined && (
          <g aria-hidden="true">
            <line className="now-line" x1={x(nowIndex)} x2={x(nowIndex)} y1={M.top + 2} y2={M.top + ih} />
            <circle className="now-dot" cx={x(nowIndex)} cy={M.top + ih} r={2.5} />
            <text className="now-label" x={x(nowIndex)} y={M.top - 1} textAnchor="middle">
              {t('now')}
            </text>
          </g>
        )}
        {hover !== null && (
          <g>
            <line className="cross" x1={x(hover)} x2={x(hover)} y1={M.top} y2={M.top + ih} />
            {lineSeries.map((s) => (
              <circle key={s.key} className={`dot--${s.tone}`} cx={x(hover)} cy={y(s.values[hover])} r={4} />
            ))}
          </g>
        )}
        <rect x={M.left} y={M.top} width={iw} height={ih} fill="transparent" />
      </svg>
      {hover !== null && (
        <div
          className="chart-tip"
          style={{ left: `${(x(hover) / width) * 100}%`, transform: `translateX(${x(hover) > width * 0.6 ? '-105%' : '8px'})` }}
        >
          <div className="when">{fmtStep(times[hover], lang)}</div>
          {series.map((s) => (
            <div className="row" key={s.key}>
              <i style={{ background: `var(--color-chart-${s.tone})` }} />
              {s.label}: <b>{fmtNum(s.values[hover], digits)}</b> {unit}
            </div>
          ))}
        </div>
      )}
      <span id={`${uid}-hint`} className="sr-only">
        {t('chartKeys')}
      </span>
      <span className="sr-only" aria-live="polite">
        {byKeyboard && hover !== null
          ? `${fmtStep(times[hover], lang)}: ${series.map((s) => `${s.label} ${fmtNum(s.values[hover], digits)} ${unit}`).join(', ')}`
          : ''}
      </span>
    </figure>
  );
}

export function ChartLegend({ fine, coarse }: { fine: string; coarse: string }) {
  return (
    <div className="chart-legend">
      <span>
        <i className="fine" /> {fine}
      </span>
      <span>
        <i className="coarse" /> {coarse}
      </span>
    </div>
  );
}
