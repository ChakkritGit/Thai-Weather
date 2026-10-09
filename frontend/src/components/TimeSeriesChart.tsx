'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { fmtHour, fmtNum, fmtStep, thaiHour } from '../lib/format';
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
 * crosshair tooltip. The 2 km series is solid blue, the 22 km series dashed
 * orange – colour + dash so identity never relies on colour alone.
 */
export function TimeSeriesChart({ title, times, series, unit, digits = 1, height = 150, nowIndex, zeroBased, yMax }: Props) {
  const { lang } = useT();
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const figRef = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(340);
  useEffect(() => {
    const el = figRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
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
    setHover(Math.max(0, Math.min(n - 1, Math.round(((px - M.left) / iw) * (n - 1)))));
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
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
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
          <text className="axis-label" x={M.left - 6} y={M.top - 2} textAnchor="end" style={{ fontSize: 9 }}>
            {unit}
          </text>
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
                {s.tone === 'fine' ? (lang === 'th' ? '2 กม.' : '2 km') : lang === 'th' ? '22 กม.' : '22 km'}
              </text>
            );
          })}
        {nowIndex !== undefined && <line className="now-line" x1={x(nowIndex)} x2={x(nowIndex)} y1={M.top} y2={M.top + ih} />}
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
          <div className="muted">{fmtStep(times[hover], lang)}</div>
          {series.map((s) => (
            <div className="row" key={s.key}>
              <i style={{ background: `var(--color-chart-${s.tone})` }} />
              {s.label}: <b className="num">{fmtNum(s.values[hover], digits)}</b> {unit}
            </div>
          ))}
        </div>
      )}
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
