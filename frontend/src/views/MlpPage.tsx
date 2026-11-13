'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useT } from '../i18n';
import { MlpBadge } from '../components/MlpBadge';
import { paths } from '../lib/paths';
import {
  GAIN,
  KEYS,
  mlpState,
  needed,
  niceTicks,
  runsOf,
  seriesOf,
  shortDate,
  tickDigits,
  type MlpCurve,
  type MlpKind,
  type MlpRun,
  type MlpStatus,
} from '../lib/mlpRuns';
import { fmtDateTime } from '../lib/format';
import { useScrub, useWidth, type VerificationReport } from './VerificationPage';

const ROWS_SHOWN = 14;

type Line = { key: string; label: string; color: string; dash?: string; values: (number | null)[] };
type Mark = { at: number; label: string };

const COLOR = { raw: 'var(--color-chart-coarse)', base: 'var(--color-status-demo-solid)', mlp: 'var(--color-chart-fine)' };

/**
 * A line chart over shared x positions (days, or epochs). Lines break at missing values; the reference line is a
 * threshold to compare against, the vertical mark a single x of interest (the early-stopping epoch).
 */
function TrendChart({
  xs,
  lines,
  xText,
  yText,
  digits,
  refLine,
  vline,
  yTitle,
  xTitle,
  label,
}: {
  xs: number[];
  lines: Line[];
  xText: (x: number) => string;
  yText?: (v: number) => string;
  digits?: number;
  refLine?: Mark;
  vline?: Mark;
  yTitle: string;
  xTitle: string;
  label: string;
}) {
  const [box, W] = useWidth(340);
  const H = 240, L = (digits ?? 2) > 2 ? 66 : 52, R = 14, T = 12, B = 44;
  const all = lines.flatMap((l) => l.values).filter((v): v is number => v !== null);
  if (refLine) all.push(refLine.at);
  const ticks = niceTicks(Math.min(...all), Math.max(...all), 4);
  const lo = ticks[0], hi = ticks[ticks.length - 1];
  const d = digits ?? tickDigits(ticks);
  const fmt = yText ?? ((v: number) => v.toFixed(d));
  // one point has no span: give it a day (or an epoch) either side so it sits mid-chart
  const x0 = xs.length > 1 ? xs[0] : xs[0] - 1, x1 = xs.length > 1 ? xs[xs.length - 1] : xs[0] + 1;
  const x = (v: number) => L + ((W - L - R) * (v - x0)) / (x1 - x0);
  const y = (v: number) => T + ((H - T - B) * (hi - v)) / (hi - lo);
  const xt = (xs.length > 1 ? [0, 1, 2, 3].map((i) => x0 + ((x1 - x0) * i) / 3) : [xs[0]]).filter(
    (v, i, a) => i === 0 || xText(v) !== xText(a[i - 1]),
  );
  const markers = xs.length <= 14;
  const { hover, props, tipStyle } = useScrub(xs.length, (i) => x(xs[i]), W, box);
  const segments = (vals: (number | null)[]) => {
    const out: string[][] = [];
    let cur: string[] = [];
    vals.forEach((v, i) => {
      if (v === null) {
        if (cur.length) out.push(cur);
        cur = [];
      } else cur.push(`${x(xs[i])},${y(v)}`);
    });
    if (cur.length) out.push(cur);
    return out;
  };
  return (
    <figure className="verify-chart chart" ref={box}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} {...props}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="var(--color-chart-grid)" />
            <text x={L - 6} y={y(v) + 4} textAnchor="end" className="verify-axis">{fmt(v)}</text>
          </g>
        ))}
        {xt.map((v, i) => (
          <text key={i} x={x(v)} y={H - B + 16} textAnchor="middle" className="verify-axis">{xText(v)}</text>
        ))}
        <text x={L + (W - L - R) / 2} y={H - 4} textAnchor="middle" className="verify-axis-title">{xTitle}</text>
        <text transform={`translate(12 ${T + (H - T - B) / 2}) rotate(-90)`} textAnchor="middle" className="verify-axis-title">{yTitle}</text>
        {refLine && (
          <g>
            <line x1={L} x2={W - R} y1={y(refLine.at)} y2={y(refLine.at)} stroke="var(--color-fg-muted)" strokeDasharray="2 4" />
            <text x={W - R} y={y(refLine.at) - 5} textAnchor="end" className="verify-axis">{refLine.label}</text>
          </g>
        )}
        {vline && (
          <g>
            <line x1={x(vline.at)} x2={x(vline.at)} y1={T} y2={H - B} stroke="var(--color-fg-muted)" strokeDasharray="4 3" />
            <text x={x(vline.at) + (x(vline.at) > W * 0.6 ? -5 : 5)} y={T + 12} textAnchor={x(vline.at) > W * 0.6 ? 'end' : 'start'} className="verify-axis">{vline.label}</text>
          </g>
        )}
        {lines.map((l) => (
          <g key={l.key}>
            {segments(l.values).map((pts, i) => (
              <polyline key={i} fill="none" stroke={l.color} strokeWidth={l.key.endsWith('mlp') ? 2.5 : 2} strokeDasharray={l.dash} strokeLinejoin="round" points={pts.join(' ')} />
            ))}
            {markers &&
              l.values.map((v, i) =>
                v === null ? null : (
                  <circle key={i} cx={x(xs[i])} cy={y(v)} r={4} fill={l.color} stroke="var(--color-bg-surface)" strokeWidth={2}>
                    <title>{`${l.label} ${xText(xs[i])}: ${fmt(v)}`}</title>
                  </circle>
                ),
              )}
          </g>
        ))}
        {hover !== null && (
          <g aria-hidden="true">
            <line className="cross" x1={x(xs[hover])} x2={x(xs[hover])} y1={T} y2={H - B} />
            {lines.map((l) => (l.values[hover] === null ? null : <circle key={l.key} cx={x(xs[hover])} cy={y(l.values[hover] as number)} r={6} fill={l.color} stroke="var(--color-bg-surface)" strokeWidth={2} />))}
          </g>
        )}
        <rect x={L} y={T} width={W - L - R} height={H - T - B} fill="transparent" />
      </svg>
      {hover !== null && (
        <div className="chart-tip" style={tipStyle(x(xs[hover]))}>
          <div className="when">{xText(xs[hover])}</div>
          {lines.map((l) => (
            <div className="row" key={l.key}>
              <i style={{ background: l.color }} />
              {l.label}: <b>{l.values[hover] === null ? '–' : fmt(l.values[hover] as number)}</b>
            </div>
          ))}
        </div>
      )}
      <figcaption className="verify-legend">
        {lines.map((l) => (
          <span key={l.key}>
            <svg width="22" height="8" aria-hidden="true">
              <line x1="0" x2="22" y1="4" y2="4" stroke={l.color} strokeWidth={2.5} strokeDasharray={l.dash} />
            </svg>
            {l.label}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

const TEXT = {
  rain: {
    h: { th: 'โอกาสฝน: โครงข่ายประสาทเทียม (MLP)', en: 'Chance of rain: neural network (MLP)' },
    other: { th: 'การปรับแบบ logistic', en: 'the logistic calibration' },
    names: [
      { th: 'โอกาสฝนดิบ', en: 'Raw chance' },
      { th: 'ปรับแบบ logistic', en: 'Logistic' },
      { th: 'MLP', en: 'MLP' },
    ],
    unit: { th: 'คะแนน Brier', en: 'Brier score' },
  },
  temp: {
    h: { th: 'อุณหภูมิ: โครงข่ายประสาทเทียม (MLP)', en: 'Temperature: neural network (MLP)' },
    other: { th: 'วิธีหักค่าคลาดเคลื่อนรายชั่วโมง', en: 'the hourly bias' },
    names: [
      { th: 'พยากรณ์ดิบ', en: 'Raw forecast' },
      { th: 'หักค่าคลาดรายชั่วโมง', en: 'Hourly bias' },
      { th: 'MLP', en: 'MLP' },
    ],
    unit: { th: 'คลาดเคลื่อนเฉลี่ย (°C)', en: 'Mean error (°C)' },
  },
} as const;

const SHORT = [
  { th: 'ดิบ', en: 'Raw' },
  { th: 'วิธีเดิม', en: 'Current' },
  { th: 'MLP', en: 'MLP' },
] as const;

const pct = (a: number, b: number) => `${Math.min(100, Math.round((a / b) * 100))}%`;
const n = (v: number | null | undefined, d = 0) => (v === null || v === undefined ? '–' : v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));

function MlpSection({
  kind,
  runs,
  status,
  curve,
  th,
}: {
  kind: MlpKind;
  runs: MlpRun[];
  status: MlpStatus | null | undefined;
  curve: MlpCurve | null | undefined;
  th: boolean;
}) {
  const tx = TEXT[kind];
  const pick = (o: { th: string; en: string }) => (th ? o.th : o.en);
  const last = runs[runs.length - 1] ?? null;
  const state = mlpState(last);
  const other = pick(tx.other);
  const digits = kind === 'rain' ? 4 : 2;
  const m = last?.metrics;
  const best = m ? Math.min(m[KEYS[kind][0]], m[KEYS[kind][1]]) : null;
  const target = m ? needed(kind, m[KEYS[kind][0]], m[KEYS[kind][1]]) : null;
  const unitOf = kind === 'rain' ? '' : ' °C';
  const gain = GAIN[kind];
  const rule =
    kind === 'rain'
      ? th
        ? `ต้องดีกว่าวิธีที่ดีที่สุดของอีกสองแบบอย่างน้อย ${gain.rel * 100}% (ยิ่งต่ำยิ่งดี)`
        : `It must beat the better of the other two by at least ${gain.rel * 100}% (lower is better).`
      : th
        ? `ต้องดีกว่าวิธีที่ดีที่สุดของอีกสองแบบอย่างน้อย ${gain.abs} °C และ ${gain.rel * 100}% (ยิ่งต่ำยิ่งดี)`
        : `It must beat the better of the other two by at least ${gain.abs} °C and ${gain.rel * 100}% (lower is better).`;

  let words: string;
  if (state === 'on') {
    words = th
      ? `ใช้งานอยู่: พยากรณ์รอบใหม่ใช้โครงข่ายนี้แทน${other} เพราะในวันที่กันไว้ทดสอบ (${status?.test_days ?? 14} วันล่าสุด) ให้ผลดีกว่า`
      : `In use: new forecast runs use this network instead of ${other}, because it did better on the days held out for testing.`;
  } else if (state === 'off') {
    words = th
      ? `ข้อมูลพอแล้ว แต่ยังไม่ดีกว่า ${other} มากพอ จึงยังไม่ใช้งาน ระบบเดิมทำงานต่อไป และจะตรวจใหม่ทุกวัน เปิดใช้เองเมื่อผ่านเกณฑ์`
      : `There is enough data, but it is not yet clearly better than ${other}, so it is not used. The current method keeps running; it is checked daily and switches on by itself once it passes.`;
  } else {
    words = th
      ? kind === 'rain'
        ? 'ฝนเกิดไม่บ่อย จึงรอให้มีชั่วโมงที่ฝนตกจริงและจำนวนวันครบก่อน แล้วจะเรียนเอง'
        : 'กำลังสะสมข้อมูล จะเริ่มเรียนเมื่อมีจำนวนวันและคู่ข้อมูลครบ'
      : kind === 'rain'
        ? 'Rain is rare, so it waits for enough hours with rain and enough days; then it trains by itself.'
        : 'Collecting data; it starts training once there are enough days and pairs.';
  }

  const metricRuns = seriesOf(runs, KEYS[kind]);
  const lineDefs = metricRuns.values.map((values, i) => ({
    key: KEYS[kind][i],
    label: pick(tx.names[i]),
    color: [COLOR.raw, COLOR.base, COLOR.mlp][i],
    dash: [undefined, '7 4', undefined][i],
    values,
  }));

  // while it is still waiting, the useful chart is how close the data is to the requirement
  const progRuns = runs.filter((r) => r.days !== null);
  const progXs = progRuns.map((r) => Date.parse(r.fitted_at));
  const need = status
    ? { days: status.required_days, count: kind === 'rain' ? status.required_events : status.required_pairs }
    : null;
  const countOf = (r: MlpRun) => (kind === 'rain' ? r.events : r.pairs);
  const countLabel = kind === 'rain' ? (th ? 'ชั่วโมงที่ฝนตก' : 'Rain hours') : th ? 'คู่ข้อมูล' : 'Pairs';
  const whenText = (ms: number) => shortDate(ms, th);
  const xTitleDate = th ? 'วันที่รัน' : 'Run date';

  const [all, setAll] = useState(false);
  const rows = [...runs].reverse();
  const shown = all ? rows : rows.slice(0, ROWS_SHOWN);

  return (
    <section className="card card-pad verify-section mlp-section" id={kind}>
      <div className="mlp-head">
        <h2>{pick(tx.h)}</h2>
        <MlpBadge state={state} th={th} />
      </div>
      <p>{words}</p>
      {last && state === 'wait' && need && status && (
        <div className="verify-progress">
          <span>{th ? `วัน ${last.days ?? 0}/${need.days}` : `Days ${last.days ?? 0}/${need.days}`}</span>
          <i><b style={{ width: pct(last.days ?? 0, need.days) }} /></i>
          {need.count !== undefined && (
            <>
              <span>{`${countLabel} ${n(countOf(last) ?? 0)}/${n(need.count)}`}</span>
              <i><b style={{ width: pct(countOf(last) ?? 0, need.count) }} /></i>
            </>
          )}
        </div>
      )}
      {m && best !== null && target !== null && (
        <p className="muted">
          {th
            ? `รอบล่าสุด: MLP ${n(m[KEYS[kind][2]], digits)}${unitOf} · ${other}${kind === 'rain' ? ` ${n(m[KEYS[kind][1]], digits)}` : ` ${n(m[KEYS[kind][1]], digits)}${unitOf}`} · ค่าที่ดีที่สุดของวิธีเดิม ${n(best, digits)}${unitOf} ต้องทำให้ได้ไม่เกิน ${n(target, digits)}${unitOf}`
            : `Latest run: MLP ${n(m[KEYS[kind][2]], digits)}${unitOf} · ${other} ${n(m[KEYS[kind][1]], digits)}${unitOf} · best of the others ${n(best, digits)}${unitOf}, so the MLP needs ${n(target, digits)}${unitOf} or lower.`}
        </p>
      )}
      <p className="muted verify-note">{rule}</p>

      {metricRuns.xs.length > 0 ? (
        <div className="mlp-block">
          <h3>{th ? `${pick(tx.unit)} ของแต่ละรอบ` : `${pick(tx.unit)} by daily run`}</h3>
          <p className="muted verify-note">{th ? 'คิดจากวันที่กันไว้ทดสอบ ยิ่งต่ำยิ่งดี' : 'Scored on the held-out days. Lower is better.'}</p>
          <TrendChart
            xs={metricRuns.xs}
            lines={lineDefs}
            xText={whenText}
            digits={digits}
            yTitle={pick(tx.unit)}
            xTitle={xTitleDate}
            label={th ? `${pick(tx.unit)} ตามวัน` : `${pick(tx.unit)} over time`}
          />
        </div>
      ) : (
        progXs.length > 0 &&
        need && (
          <div className="mlp-block">
            <h3>{th ? 'ความคืบหน้าของการสะสมข้อมูล' : 'Data collection progress'}</h3>
            <p className="muted verify-note">{th ? 'เส้นประคือเกณฑ์ที่ต้องถึงก่อนจะเริ่มเรียน' : 'The dotted line is the amount needed before it starts training.'}</p>
            <div className="mlp-pair">
              <TrendChart
                xs={progXs}
                lines={[{ key: 'days', label: th ? 'วันที่มีข้อมูล' : 'Days of data', color: COLOR.mlp, values: progRuns.map((r) => r.days) }]}
                xText={whenText}
                digits={0}
                refLine={{ at: need.days, label: th ? `ต้องการ ${need.days} วัน` : `Needs ${need.days} days` }}
                yTitle={th ? 'วัน' : 'Days'}
                xTitle={xTitleDate}
                label={th ? 'จำนวนวันที่มีข้อมูล' : 'Days of data over time'}
              />
              {need.count !== undefined && (
                <TrendChart
                  xs={progXs}
                  lines={[{ key: 'count', label: countLabel, color: COLOR.raw, values: progRuns.map(countOf) }]}
                  xText={whenText}
                  yText={(v) => (v >= 1000 ? `${v / 1000}k` : String(v))}
                  refLine={{ at: need.count, label: th ? `ต้องการ ${n(need.count)}` : `Needs ${n(need.count)}` }}
                  yTitle={countLabel}
                  xTitle={xTitleDate}
                  label={`${countLabel}`}
                />
              )}
            </div>
          </div>
        )
      )}

      <div className="mlp-block">
        <h3>{th ? 'เส้นโค้งการเรียนรู้ของรอบล่าสุดที่ฝึก' : 'Learning curve of the latest trained run'}</h3>
        {curve && curve.val.length > 0 ? (
          <>
            <p className="muted verify-note">
              {th
                ? `${fmtDateTime(curve.fitted_at, 'th')} · เส้นตรวจสอบหยุดดีขึ้นหลังรอบที่ ${curve.best_epoch} ระบบจึงหยุดฝึกและเก็บค่าของรอบนั้นไว้ (early stopping) · ยิ่งต่ำยิ่งดี`
                : `${fmtDateTime(curve.fitted_at, 'en')} · the validation line stopped improving after epoch ${curve.best_epoch}, so training stopped and kept that epoch (early stopping). Lower is better.`}
            </p>
            <TrendChart
              xs={curve.val.map((_, i) => i + 1)}
              lines={[
                { key: 'train', label: th ? 'ชุดฝึก' : 'Training', color: COLOR.raw, dash: '7 4', values: curve.train },
                { key: 'val', label: th ? 'ชุดตรวจสอบ' : 'Validation', color: COLOR.mlp, values: curve.val },
              ]}
              xText={(v) => String(Math.round(v))}
              digits={curve.metric === 'brier' ? 4 : 2}
              vline={{ at: curve.best_epoch, label: th ? `หยุดที่รอบ ${curve.best_epoch}` : `Stopped at ${curve.best_epoch}` }}
              yTitle={curve.metric === 'brier' ? 'Brier' : th ? 'คลาดเคลื่อน °C' : 'Error °C'}
              xTitle={th ? 'รอบการฝึก (epoch)' : 'Training epoch'}
              label={th ? 'เส้นโค้งการเรียนรู้' : 'Learning curve'}
            />
          </>
        ) : (
          <p className="muted">
            {th
              ? 'ยังไม่มีเส้นโค้ง: จะบันทึกตั้งแต่รอบที่มีข้อมูลพอให้ฝึก'
              : 'No curve yet: it is recorded from the first run that has enough data to train.'}
          </p>
        )}
      </div>

      <div className="mlp-block">
        <h3>{th ? 'รอบล่าสุด' : 'Recent runs'}</h3>
        {rows.length === 0 ? (
          <p className="muted">{th ? 'ยังไม่มีรอบ' : 'No runs yet'}</p>
        ) : (
          <>
            <div className="table-wrap">
              <table className="data-table verify-table mlp-table">
                <thead>
                  <tr>
                    <th>{th ? 'วันที่ · สถานะ · ข้อมูล' : 'Date · status · data'}</th>
                    {SHORT.map((nm, i) => (
                      <th className="num" key={i}>{pick(nm)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.fitted_at}>
                      <td className="mlp-run">
                        <b>{shortDate(Date.parse(r.fitted_at), th)}</b>
                        <MlpBadge state={mlpState(r)} th={th} />
                        <small className="muted">
                          {r.days === null ? '–' : `${r.days} ${th ? 'วัน' : 'd'}`} · {n(countOf(r))} {kind === 'rain' ? (th ? 'ชม.ฝน' : 'rain h') : th ? 'คู่' : 'pairs'}
                        </small>
                      </td>
                      {KEYS[kind].map((k) => (
                        <td className="num" key={k}>{n(r.metrics?.[k], digits)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rows.length > ROWS_SHOWN && (
              <button type="button" className="btn" onClick={() => setAll(!all)}>
                {all ? (th ? 'แสดงน้อยลง' : 'Show fewer') : th ? `แสดงทั้งหมด (${rows.length})` : `Show all (${rows.length})`}
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}

export function MlpPage({ report }: { report: VerificationReport }) {
  const { lang } = useT();
  const th = lang === 'th';
  const l = report.learning;
  return (
    <div className="page">
      <div className="page-inner">
        <header className="page-head">
          <p className="muted">
            <Link href={paths.verification}>{th ? '← พยากรณ์แม่นแค่ไหน' : '← How accurate is the forecast'}</Link>
          </p>
          <h1>{th ? 'ผลการเรียนรู้ของโครงข่ายประสาทเทียม (MLP)' : 'What the neural networks (MLP) have learned'}</h1>
          <p>
            {th
              ? 'ทุกวันระบบฝึกโครงข่ายประสาทเทียมขนาดเล็กสองตัว ตัวหนึ่งแก้โอกาสฝน อีกตัวแก้อุณหภูมิ แล้วทดสอบกับวันล่าสุดที่กันไว้ไม่ให้ฝึก จะเปิดใช้จริงก็ต่อเมื่อดีกว่าวิธีเดิมชัดเจนเท่านั้น หน้านี้ดูว่าแต่ละตัวอยู่ตรงไหนและดีขึ้นหรือยัง'
              : 'Every day two small neural networks are trained, one for the chance of rain and one for temperature, and tested on the latest days held out from training. A network is switched on only when it is clearly better than the current method. This page shows where each one stands and whether it is improving.'}
          </p>
        </header>
        <MlpSection kind="rain" runs={runsOf(l.mlp?.rain, l.rain_mlp)} status={l.rain_mlp} curve={l.mlp?.rain.curve} th={th} />
        <MlpSection kind="temp" runs={runsOf(l.mlp?.temp, l.temp_mlp)} status={l.temp_mlp} curve={l.mlp?.temp.curve} th={th} />
      </div>
    </div>
  );
}
