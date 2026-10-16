'use client';

import { useT } from '../i18n';

type Metrics = { n: number; bias: number | null; mae: number | null; rmse: number | null };
type Row = { label: string; n: number; metrics: Record<string, Metrics>; extra: Record<string, string> };
type Contingency = { hits: number; misses: number; false_alarms: number; correct_negatives: number; pod: number | null; far: number | null; csi: number | null; freq_bias: number | null; brier: number | null };

export interface VerificationReport {
  since: string | null;
  until: string;
  generated: string;
  counts: { runs: number; stations: number; observations: number };
  temperature: {
    matched: number;
    overall: Record<string, Metrics>;
    by_lead: Row[];
    by_hour: Row[];
    by_elevation: Row[];
    by_station: Row[];
    holdout: string[];
    correction_effect: Row[];
  };
  rain: { threshold_mm: number; windows: number; by_source: Record<string, Contingency> };
  pop: { hours: number; rate: number | null; brier_shown: number | null; brier_raw: number | null; reliability: { bin: string; n: number; forecast: number; observed: number }[] };
  learning: {
    pop_calibration: { a: number; b: number; pairs: number; events: number; fitted_at: string | null; brier_raw: number | null; brier_cal: number | null; identity: boolean };
    temp_bias: { fitted_at: string | null; window_days: number; pairs: number; stations: number; mean_abs: number } | null;
    temp_mlp: {
      fitted_at: string; active: boolean; reason: string | null; pairs: number; days: number;
      required_pairs: number; required_days: number; test_days: number;
      metrics: { test_pairs: number; mae_raw: number; mae_hourly_bias: number; mae_mlp: number; epochs: number } | null;
    } | null;
    rain_mlp?: {
      fitted_at: string; active: boolean; reason: string | null; pairs: number; events: number; days: number;
      required_events: number; required_days: number; test_days: number;
      metrics: { test_hours: number; test_rain_hours: number; brier_raw: number; brier_logistic: number; brier_mlp: number; epochs: number } | null;
    } | null;
  };
}

const SOURCES = ['fine', 'gfs_raw', 'openmeteo'] as const;
const NAMES: Record<string, { th: string; en: string }> = {
  fine: { th: 'ฟ้าละเอียด 2.2 กม.', en: 'Thai Weather HD 2.2 km' },
  gfs_raw: { th: 'GFS ดิบ ~28 กม.', en: 'Raw GFS ~28 km' },
  openmeteo: { th: 'Open-Meteo', en: 'Open-Meteo' },
};
const n1 = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? '–' : v.toFixed(d));
const signed = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? '–' : `${v > 0 ? '+' : ''}${v.toFixed(d)}`);
const skill = (m: Metrics | undefined, base: Metrics | undefined) =>
  m?.mae && base?.mae ? Math.round((1 - m.mae / base.mae) * 100) : null;

export function VerificationPage({ report }: { report: VerificationReport }) {
  const { lang } = useT();
  const th = lang === 'th';
  const name = (s: string) => (th ? NAMES[s]?.th : NAMES[s]?.en) ?? s;
  const t = report.temperature;
  const fine = t.overall.fine;
  const gfs = t.overall.gfs_raw;
  const sk = skill(fine, gfs);
  const date = (iso: string) =>
    new Date(iso).toLocaleString(th ? 'th-TH' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' });
  const holdout = new Set(t.holdout);

  return (
    <div className="page">
      <div className="page-inner">
        <header className="page-head">
          <h1>{th ? 'พยากรณ์แม่นแค่ไหน' : 'How accurate is the forecast'}</h1>
          <p>
            {th
              ? `เทียบพยากรณ์กับค่าที่สถานีตรวจอากาศสนามบิน (METAR) วัดได้จริง ${t.matched.toLocaleString()} คู่ จาก ${report.counts.stations} สถานี ${report.counts.runs} รอบพยากรณ์ ช่วง ${report.since ? date(report.since) : ''} – ${date(report.until)} · อัปเดตทุกชั่วโมง`
              : `Forecasts against what airport weather stations (METAR) measured: ${t.matched.toLocaleString()} pairs from ${report.counts.stations} stations and ${report.counts.runs} runs, ${report.since ? date(report.since) : ''} – ${date(report.until)} · updated hourly`}
          </p>
        </header>

        <section className="verify-tiles">
          {SOURCES.map((s) => (
            <div key={s} className="card card-pad verify-tile" data-source={s}>
              <span className="muted">{name(s)}</span>
              <b>{n1(t.overall[s]?.mae)} °C</b>
              <span className="muted">
                {th ? 'คลาดเคลื่อนเฉลี่ย' : 'mean error'} · bias {signed(t.overall[s]?.bias)}
              </span>
            </div>
          ))}
          <div className="card card-pad verify-tile verify-tile--accent">
            <span className="muted">{th ? 'ดีกว่า GFS ดิบ' : 'Better than raw GFS'}</span>
            <b>{sk === null ? '–' : `${sk > 0 ? '+' : ''}${sk}%`}</b>
            <span className="muted">{th ? 'คิดจากความคลาดเคลื่อนเฉลี่ย' : 'by mean absolute error'}</span>
          </div>
        </section>

        <section className="card card-pad verify-section">
          <h2>{th ? 'ยิ่งพยากรณ์ไกล ยิ่งคลาด' : 'Error grows with lead time'}</h2>
          <BarTable rows={t.by_lead} name={name} th={th} first={th ? 'ล่วงหน้า' : 'Lead'} />
        </section>

        <section className="card card-pad verify-section">
          <h2>{th ? 'เย็นหรือร้อนเกินจริงตามเวลาของวัน' : 'Too cold or too warm by time of day'}</h2>
          <p className="muted">
            {th
              ? 'ค่าบวก = พยากรณ์ร้อนเกินจริง · ค่าลบ = เย็นเกินจริง (°C) · ชั่วโมงตามเวลาไทย'
              : 'Positive = forecast too warm · negative = too cold (°C) · Bangkok time'}
          </p>
          <BiasChart rows={t.by_hour} name={name} />
        </section>

        <section className="two-col">
          <div className="card card-pad verify-section">
            <h2>{th ? 'ฝนตกหรือไม่ (ช่วง 3 ชม.)' : 'Rain or not (3-hour windows)'}</h2>
            <p className="muted">
              {th
                ? `${report.rain.windows.toLocaleString()} ช่วง · พยากรณ์ว่า "ฝนตก" เมื่อ ≥ ${report.rain.threshold_mm} มม./ชม. · ความถี่ 1.0 = บอกว่าฝนตกบ่อยเท่าที่ตกจริง`
                : `${report.rain.windows.toLocaleString()} windows · "rain" when ≥ ${report.rain.threshold_mm} mm/h · frequency 1.0 = forecast as often as it rained`}
            </p>
            <table className="data-table verify-table">
              <thead>
                <tr>
                  <th />
                  <th className="num">{th ? 'จับได้' : 'Hit rate'}</th>
                  <th className="num">{th ? 'เตือนเก้อ' : 'False alarms'}</th>
                  <th className="num">{th ? 'ความถี่' : 'Frequency'}</th>
                </tr>
              </thead>
              <tbody>
                {SOURCES.filter((s) => report.rain.by_source[s]).map((s) => {
                  const c = report.rain.by_source[s];
                  return (
                    <tr key={s}>
                      <td>{name(s)}</td>
                      <td className="num">{c.pod === null ? '–' : `${Math.round(c.pod * 100)}%`}</td>
                      <td className="num">{c.far === null ? '–' : `${Math.round(c.far * 100)}%`}</td>
                      <td className="num">{n1(c.freq_bias, 1)}×</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="muted verify-note">
              {th
                ? 'รายงานสนามบินบอกเฉพาะฝนที่ตกตอนรายงาน ฝนสั้น ๆ ระหว่างรายงานจึงหลุด ทำให้ทุกแหล่งดูบอกฝนเกินจริง'
                : 'Airport reports only note rain falling at report time, so short showers in between are missed and every source looks rainier than observed.'}
            </p>
          </div>
          <div className="card card-pad verify-section">
            <h2>{th ? 'โอกาสฝนเชื่อได้แค่ไหน' : 'Is the chance of rain reliable'}</h2>
            <p className="muted">
              {th
                ? `ถ้าเชื่อได้ จุดควรอยู่บนเส้นทแยง · ${report.pop.hours.toLocaleString()} ชั่วโมง · ฝนตกจริง ${n1((report.pop.rate ?? 0) * 100, 1)}% ของชั่วโมง`
                : `Reliable points sit on the diagonal · ${report.pop.hours.toLocaleString()} hours · it rained in ${n1((report.pop.rate ?? 0) * 100, 1)}% of them`}
            </p>
            <Reliability bins={report.pop.reliability} th={th} />
          </div>
        </section>

        <section className="card card-pad verify-section">
          <h2>{th ? 'สิ่งที่ระบบเรียนรู้จากสถานี' : 'What the forecast learns from the stations'}</h2>
          <Learning l={report.learning} th={th} date={date} />
        </section>

        <section className="card card-pad verify-section">
          <h2>{th ? 'รายสถานี' : 'By station'}</h2>
          <p className="muted">
            {th
              ? 'สถานีที่มีป้าย "ทดสอบ" ไม่ถูกนำไปใช้แก้หรือเรียนรู้ จึงเป็นตัววัดที่ตรงไปตรงมาที่สุด'
              : 'Stations marked "test" are never used to correct or train the forecast, so they are the honest score.'}
          </p>
          <div className="table-wrap">
            <table className="data-table verify-table">
              <thead>
                <tr>
                  <th>{th ? 'สถานี' : 'Station'}</th>
                  <th className="num">{th ? 'สูง (ม.)' : 'Elev. (m)'}</th>
                  <th className="num">N</th>
                  <th className="num">{name('fine')}</th>
                  <th className="num">{name('gfs_raw')}</th>
                  <th className="num">{th ? 'ดีกว่า' : 'Skill'}</th>
                </tr>
              </thead>
              <tbody>
                {t.by_station.map((r) => {
                  const s = skill(r.metrics.fine, r.metrics.gfs_raw);
                  return (
                    <tr key={r.label}>
                      <td>
                        {r.extra.name || r.label} <span className="muted">{r.label}</span>
                        {holdout.has(r.label) && <span className="badge badge--info verify-badge">{th ? 'ทดสอบ' : 'test'}</span>}
                      </td>
                      <td className="num">{r.extra.elevation ?? '–'}</td>
                      <td className="num">{r.n}</td>
                      <td className="num">{n1(r.metrics.fine?.mae)}</td>
                      <td className="num">{n1(r.metrics.gfs_raw?.mae)}</td>
                      <td className="num">{s === null ? '–' : `${s > 0 ? '+' : ''}${s}%`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card card-pad prose">
          <h2>{th ? 'ข้อจำกัดของการวัด' : 'Limits of this measurement'}</h2>
          <ul>
            <li>{th ? 'อุณหภูมิจาก METAR ปัดเป็นองศาเต็ม จึงมีความคลาดเคลื่อนจากการปัดราว 0.3 °C อยู่ในทุกตัวเลข' : 'METAR temperatures are whole degrees, which adds about 0.3 °C of rounding noise to every number.'}</li>
            <li>{th ? 'สถานีส่วนใหญ่เป็นสนามบินบนที่ราบหรือในเมือง จึงยังไม่ได้วัดบนภูเขาสูง' : 'Most stations are airports on flat ground or in cities, so high mountains are not measured.'}</li>
            <li>{th ? 'METAR ของไทยไม่รายงานปริมาณฝน จึงตรวจได้แค่ "ตกหรือไม่ตก"' : 'Thai METARs carry no rain amounts, so rain is checked only as rain or no rain.'}</li>
          </ul>
        </section>
      </div>
    </div>
  );
}

function BarTable({ rows, name, th, first }: { rows: Row[]; name: (s: string) => string; th: boolean; first: string }) {
  const max = Math.max(...rows.flatMap((r) => [r.metrics.fine?.mae ?? 0, r.metrics.gfs_raw?.mae ?? 0]), 0.1);
  return (
    <table className="data-table verify-table">
      <thead>
        <tr>
          <th>{first}</th>
          <th>{th ? 'คลาดเคลื่อนเฉลี่ย (°C)' : 'Mean error (°C)'}</th>
          <th className="num">N</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label}>
            <td>{r.label.replace(' h', th ? ' ชม.' : ' h')}</td>
            <td>
              {(['fine', 'gfs_raw'] as const).map((s) => (
                <div key={s} className="verify-bar" data-source={s} title={`${name(s)}: ${n1(r.metrics[s]?.mae)} °C`}>
                  <i style={{ width: `${((r.metrics[s]?.mae ?? 0) / max) * 100}%` }} />
                  <span>{n1(r.metrics[s]?.mae)}</span>
                </div>
              ))}
            </td>
            <td className="num">{r.n.toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
      <caption className="verify-legend">
        {(['fine', 'gfs_raw'] as const).map((s) => (
          <span key={s} data-source={s}>
            <i /> {name(s)}
          </span>
        ))}
      </caption>
    </table>
  );
}

function BiasChart({ rows, name }: { rows: Row[]; name: (s: string) => string }) {
  const W = 640, H = 220, L = 40, R = 12, T = 12, B = 30;
  const vals = rows.flatMap((r) => [r.metrics.fine?.bias ?? 0, r.metrics.gfs_raw?.bias ?? 0]);
  const lim = Math.max(1, Math.ceil(Math.max(...vals.map(Math.abs)) * 2) / 2);
  const x = (i: number) => L + ((W - L - R) * (i + 0.5)) / rows.length;
  const y = (v: number) => T + ((H - T - B) * (lim - v)) / (2 * lim);
  const ticks = [-lim, -lim / 2, 0, lim / 2, lim];
  return (
    <figure className="verify-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="bias by hour">
        {ticks.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke={v === 0 ? 'var(--color-chart-axis)' : 'var(--color-chart-grid)'} />
            <text x={L - 6} y={y(v) + 4} textAnchor="end" className="verify-axis">{`${v > 0 ? '+' : ''}${v}`}</text>
          </g>
        ))}
        {rows.map((r, i) => (
          <text key={r.label} x={x(i)} y={H - 10} textAnchor="middle" className="verify-axis">{r.label.slice(0, 2)}:00</text>
        ))}
        {(['gfs_raw', 'fine'] as const).map((s) => (
          <g key={s}>
            <polyline
              fill="none"
              stroke={s === 'fine' ? 'var(--color-chart-fine)' : 'var(--color-chart-coarse)'}
              strokeWidth={2}
              points={rows.map((r, i) => `${x(i)},${y(r.metrics[s]?.bias ?? 0)}`).join(' ')}
            />
            {rows.map((r, i) => (
              <circle key={r.label} cx={x(i)} cy={y(r.metrics[s]?.bias ?? 0)} r={4} fill={s === 'fine' ? 'var(--color-chart-fine)' : 'var(--color-chart-coarse)'} stroke="var(--color-bg-surface)" strokeWidth={2}>
                <title>{`${name(s)} ${r.label}: ${signed(r.metrics[s]?.bias)} °C`}</title>
              </circle>
            ))}
          </g>
        ))}
      </svg>
      <figcaption className="verify-legend">
        {(['fine', 'gfs_raw'] as const).map((s) => (
          <span key={s} data-source={s}>
            <i /> {name(s)}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

function Reliability({ bins, th }: { bins: VerificationReport['pop']['reliability']; th: boolean }) {
  const S = 260, P = 34;
  const x = (v: number) => P + ((S - P - 10) * v) / 100;
  const y = (v: number) => S - P - ((S - P - 10) * v) / 100;
  const maxN = Math.max(...bins.map((b) => b.n), 1);
  return (
    <figure className="verify-chart verify-chart--square">
      <svg viewBox={`0 0 ${S} ${S}`} role="img" aria-label={th ? 'ความน่าเชื่อถือของโอกาสฝน' : 'chance of rain reliability'}>
        {[0, 25, 50, 75, 100].map((v) => (
          <g key={v}>
            <line x1={x(0)} x2={x(100)} y1={y(v)} y2={y(v)} stroke="var(--color-chart-grid)" />
            <text x={P - 6} y={y(v) + 4} textAnchor="end" className="verify-axis">{v}</text>
            <text x={x(v)} y={S - P + 16} textAnchor="middle" className="verify-axis">{v}</text>
          </g>
        ))}
        <line x1={x(0)} y1={y(0)} x2={x(100)} y2={y(100)} stroke="var(--color-chart-axis)" strokeDasharray="4 4" />
        <polyline fill="none" stroke="var(--color-chart-fine)" strokeWidth={2} points={bins.map((b) => `${x(b.forecast)},${y(b.observed)}`).join(' ')} />
        {bins.map((b) => (
          <circle key={b.bin} cx={x(b.forecast)} cy={y(b.observed)} r={3 + 5 * Math.sqrt(b.n / maxN)} fill="var(--color-chart-fine)" stroke="var(--color-bg-surface)" strokeWidth={2}>
            <title>{`${b.bin}%: ${th ? 'พยากรณ์' : 'forecast'} ${b.forecast.toFixed(0)}% · ${th ? 'ตกจริง' : 'observed'} ${b.observed.toFixed(1)}% · ${b.n.toLocaleString()} ${th ? 'ชม.' : 'h'}`}</title>
          </circle>
        ))}
      </svg>
      <figcaption className="muted verify-note">
        {th ? 'แนวนอน: โอกาสฝนที่พยากรณ์ (%) · แนวตั้ง: ฝนตกจริง (%) · จุดใหญ่ = ชั่วโมงมาก' : 'Across: forecast chance (%) · up: how often it rained (%) · bigger dot = more hours'}
      </figcaption>
    </figure>
  );
}

function Learning({ l, th, date }: { l: VerificationReport['learning']; th: boolean; date: (iso: string) => string }) {
  const m = l.temp_mlp;
  const r = l.rain_mlp;
  const pct = (a: number, b: number) => `${Math.min(100, Math.round((a / b) * 100))}%`;
  return (
    <div className="verify-learning">
      <div>
        <h3>{th ? 'ปรับโอกาสฝน' : 'Chance-of-rain calibration'}</h3>
        <p className="muted">
          {r?.active
            ? th ? 'สำรองไว้: ตอนนี้ใช้ MLP โอกาสฝนแทน' : 'On standby: the chance-of-rain MLP is in use'
            : l.pop_calibration.identity
            ? th ? 'ยังไม่ใช้: ข้อมูลยังน้อย' : 'Not used yet: too little data'
            : th
              ? `ปรับทุกวันจาก ${l.pop_calibration.pairs.toLocaleString()} ชั่วโมง (${l.pop_calibration.events} ชั่วโมงที่ฝนตก) · Brier ${n1(l.pop_calibration.brier_raw, 3)} → ${n1(l.pop_calibration.brier_cal, 3)} (ต่ำกว่า = ดีกว่า)`
              : `Refitted daily on ${l.pop_calibration.pairs.toLocaleString()} hours (${l.pop_calibration.events} wet) · Brier ${n1(l.pop_calibration.brier_raw, 3)} → ${n1(l.pop_calibration.brier_cal, 3)} (lower is better)`}
        </p>
      </div>
      <div>
        <h3>{th ? 'โอกาสฝน: โครงข่ายประสาทเทียม (MLP)' : 'Chance of rain: neural network (MLP)'}</h3>
        {!r ? (
          <p className="muted">{th ? 'ยังไม่เริ่ม' : 'Not started'}</p>
        ) : r.active ? (
          <p className="muted">
            {th
              ? `ใช้งานอยู่แทนการปรับแบบ logistic · ทดสอบ ${r.test_days} วันล่าสุด Brier ${n1(r.metrics?.brier_mlp, 4)} เทียบ ${n1(r.metrics?.brier_logistic, 4)}`
              : `In use instead of the logistic calibration · last ${r.test_days} days: Brier ${n1(r.metrics?.brier_mlp, 4)} vs ${n1(r.metrics?.brier_logistic, 4)}`}
          </p>
        ) : (
          <>
            <p className="muted">
              {r.reason === 'waiting for data'
                ? th
                  ? 'ฝนเกิดไม่บ่อย จึงรอให้มีชั่วโมงที่ฝนตกจริงครบก่อน แล้วจะเรียนและเปิดใช้เองถ้า Brier ดีกว่าการปรับแบบ logistic'
                  : 'Rain is rare, so it waits for enough hours with rain; then it trains and switches itself on if its Brier score beats the logistic calibration'
                : th
                  ? `ข้อมูลครบแล้วแต่ยังไม่ดีกว่าการปรับแบบ logistic (Brier ${n1(r.metrics?.brier_mlp, 4)} vs ${n1(r.metrics?.brier_logistic, 4)}) จึงยังไม่ใช้`
                  : `Enough data, but not better than the logistic calibration yet (Brier ${n1(r.metrics?.brier_mlp, 4)} vs ${n1(r.metrics?.brier_logistic, 4)}), so not used`}
            </p>
            <div className="verify-progress">
              <span>{th ? `ชั่วโมงฝนตก ${r.events.toLocaleString()}/${r.required_events.toLocaleString()}` : `Rain hours ${r.events.toLocaleString()}/${r.required_events.toLocaleString()}`}</span>
              <i><b style={{ width: pct(r.events, r.required_events) }} /></i>
              <span>{th ? `วัน ${r.days}/${r.required_days}` : `Days ${r.days}/${r.required_days}`}</span>
              <i><b style={{ width: pct(r.days, r.required_days) }} /></i>
            </div>
          </>
        )}
      </div>
      <div>
        <h3>{th ? 'อุณหภูมิ: ร้อน/เย็นเกินจริงรายสถานีรายชั่วโมง' : 'Temperature: each station’s bias by hour'}</h3>
        <p className="muted">
          {l.temp_bias
            ? th
              ? `${l.temp_bias.stations} สถานี · ${l.temp_bias.pairs.toLocaleString()} คู่ใน ${l.temp_bias.window_days} วัน · หักออกเฉลี่ย ${n1(l.temp_bias.mean_abs)} °C · ${l.temp_bias.fitted_at ? date(l.temp_bias.fitted_at) : ''}`
              : `${l.temp_bias.stations} stations · ${l.temp_bias.pairs.toLocaleString()} pairs over ${l.temp_bias.window_days} days · ${n1(l.temp_bias.mean_abs)} °C on average · ${l.temp_bias.fitted_at ? date(l.temp_bias.fitted_at) : ''}`
            : th ? 'ยังไม่มีข้อมูลพอ' : 'Not enough data yet'}
        </p>
      </div>
      <div>
        <h3>{th ? 'อุณหภูมิ: โครงข่ายประสาทเทียม (MLP)' : 'Temperature: neural network (MLP)'}</h3>
        {!m ? (
          <p className="muted">{th ? 'ยังไม่เริ่ม' : 'Not started'}</p>
        ) : m.active ? (
          <p className="muted">
            {th
              ? `ใช้งานอยู่แทนวิธีรายชั่วโมง · ทดสอบ ${m.test_days} วันล่าสุด คลาดเคลื่อน ${n1(m.metrics?.mae_mlp)} °C เทียบ ${n1(m.metrics?.mae_hourly_bias)} °C`
              : `In use instead of the hourly bias · on the last ${m.test_days} days: ${n1(m.metrics?.mae_mlp)} °C vs ${n1(m.metrics?.mae_hourly_bias)} °C`}
          </p>
        ) : (
          <>
            <p className="muted">
              {m.reason === 'waiting for data'
                ? th
                  ? 'รอข้อมูลสะสม จะเริ่มเรียนและเปิดใช้เองเมื่อครบเกณฑ์ และใช้ต่อเมื่อแม่นกว่าวิธีปัจจุบันเท่านั้น'
                  : 'Collecting data; it trains and switches itself on when the bars fill, and only while it beats the current method'
                : th
                  ? `ข้อมูลครบแล้วแต่ยังไม่แม่นกว่าวิธีปัจจุบัน (${n1(m.metrics?.mae_mlp)} vs ${n1(m.metrics?.mae_hourly_bias)} °C) จึงยังไม่ใช้`
                  : `Enough data, but not better than the current method yet (${n1(m.metrics?.mae_mlp)} vs ${n1(m.metrics?.mae_hourly_bias)} °C), so not used`}
            </p>
            <div className="verify-progress">
              <span>{th ? `วัน ${m.days}/${m.required_days}` : `Days ${m.days}/${m.required_days}`}</span>
              <i><b style={{ width: pct(m.days, m.required_days) }} /></i>
              <span>{th ? `คู่ข้อมูล ${m.pairs.toLocaleString()}/${m.required_pairs.toLocaleString()}` : `Pairs ${m.pairs.toLocaleString()}/${m.required_pairs.toLocaleString()}`}</span>
              <i><b style={{ width: pct(m.pairs, m.required_pairs) }} /></i>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
