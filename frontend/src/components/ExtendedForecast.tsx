'use client';

import type { ForecastDay, ForecastHour, ForecastResponse } from '../lib/api';
import { scaleColor, scales } from '../lib/color';
import { fmtDay, fmtHour, fmtNum } from '../lib/format';
import type { Lang } from '../i18n/dict';
import { ConditionIcon } from './ConditionIcon';

const UV_LEVELS: [number, string, string][] = [
  [3, 'ต่ำ', 'Low'],
  [6, 'ปานกลาง', 'Moderate'],
  [8, 'สูง', 'High'],
  [11, 'สูงมาก', 'Very high'],
  [Infinity, 'อันตราย', 'Extreme'],
];
const uvLevel = (v: number, th: boolean) => {
  const l = UV_LEVELS.find(([max]) => v < max)!;
  return th ? l[1] : l[2];
};
const rgb = (v: number) => {
  const [r, g, b] = scaleColor(scales.temperature, v);
  return `rgb(${r},${g},${b})`;
};

/** The hour shown for the map's selected step (or the current one). */
export function hourAt(fc: ForecastResponse | null, iso: string | undefined): ForecastHour | null {
  if (!fc) return null;
  return fc.hourly.find((h) => h.time === iso) ?? fc.current;
}

export function DetailsGrid({ fc, hour, lang }: { fc: ForecastResponse; hour: ForecastHour | null; lang: Lang }) {
  const th = lang === 'th';
  const today = fc.daily[0];
  const air = fc.air;
  return (
    <section className="panel-section" aria-labelledby="details-h">
      <h3 id="details-h">{th ? 'รายละเอียด' : 'Details'}</h3>
      <div className="detail-grid">
        {hour && (
          <Tile label={th ? 'รู้สึกเหมือน' : 'Feels like'} value={`${fmtNum(hour.feels_like, 0)}°`}
            sub={th ? `ความชื้น ${fmtNum(hour.rh, 0)}%` : `Humidity ${fmtNum(hour.rh, 0)}%`} />
        )}
        {hour && (
          <Tile label={th ? 'จุดน้ำค้าง' : 'Dew point'} value={`${fmtNum(hour.dew_point, 0)}°`}
            sub={hour.dew_point >= 24 ? (th ? 'อบอ้าว เหนียวตัว' : 'Muggy') : hour.dew_point >= 20 ? (th ? 'ชื้น' : 'Humid') : th ? 'สบาย' : 'Comfortable'} />
        )}
        {hour?.pressure != null && (
          <Tile label={th ? 'ความกดอากาศ' : 'Pressure'} value={fmtNum(hour.pressure, 0)} unit="hPa" sub={th ? 'ระดับน้ำทะเล' : 'sea level'} />
        )}
        {today?.uv_clear_sky_max != null && (
          <Tile label={th ? 'UV สูงสุดวันนี้' : 'UV peak today'} value={fmtNum(today.uv_clear_sky_max, 0)}
            sub={`${uvLevel(today.uv_clear_sky_max, th)} · ${th ? 'ถ้าฟ้าเปิด' : 'if clear'}`} />
        )}
        {air && (
          <div className="detail-tile">
            <span className="detail-label">PM2.5</span>
            <span className="detail-value">
              {fmtNum(air.pm25, 0)} <small>µg/m³</small>
            </span>
            <span className="detail-sub">
              <i className="aq-dot" style={{ background: air.color ?? 'var(--color-fg-subtle)' }} /> {th ? air.label_th : air.label_en}
            </span>
            <span className="detail-sub subtle">
              {th ? air.station.name_th : air.station.name_en || air.station.name_th} · {fmtNum(air.station.distance_km, 0)} {th ? 'กม.' : 'km'} · {fmtHour(air.time, lang)}
            </span>
          </div>
        )}
        {today?.sunrise && today.sunset && (
          <Tile label={th ? 'พระอาทิตย์' : 'Sun'} value={`${fmtHour(today.sunrise, lang)} – ${fmtHour(today.sunset, lang)}`}
            sub={th ? `กลางวัน ${fmtNum(today.daylight_h ?? 0, 1)} ชม.` : `${fmtNum(today.daylight_h ?? 0, 1)} h of daylight`} />
        )}
        {today && (
          <div className="detail-tile">
            <span className="detail-label">{th ? 'ดวงจันทร์' : 'Moon'}</span>
            <span className="detail-value detail-moon">
              <MoonPhase phase={today.moon.phase} /> {th ? today.moon.thai_day : `${Math.round(today.moon.illumination * 100)}%`}
            </span>
            <span className="detail-sub">{th ? today.moon.label_th : today.moon.label_en}</span>
          </div>
        )}
      </div>
    </section>
  );
}

function Tile({ label, value, unit, sub }: { label: string; value: string; unit?: string; sub?: string }) {
  return (
    <div className="detail-tile">
      <span className="detail-label">{label}</span>
      <span className="detail-value">
        {value} {unit && <small>{unit}</small>}
      </span>
      {sub && <span className="detail-sub">{sub}</span>}
    </div>
  );
}

/** The lit part of the moon as seen from Thailand (waxing: lit on the right). */
function MoonPhase({ phase }: { phase: number }) {
  const r = 8;
  const k = Math.cos(2 * Math.PI * phase); // 1 new, -1 full
  const waxing = phase < 0.5;
  const rx = Math.abs(k) * r;
  // the terminator is an ellipse; the lit side is a half-disc plus or minus that half-ellipse
  const lit = waxing
    ? `M10 2 A${r} ${r} 0 0 1 10 18 A${rx} ${r} 0 0 ${k > 0 ? 0 : 1} 10 2Z`
    : `M10 2 A${r} ${r} 0 0 0 10 18 A${rx} ${r} 0 0 ${k > 0 ? 1 : 0} 10 2Z`;
  return (
    <svg viewBox="0 0 20 20" width={20} height={20} aria-hidden="true" className="moon-phase">
      <circle cx="10" cy="10" r={r} className="moon-dark" />
      <path d={lit} className="moon-lit" />
    </svg>
  );
}

export function TenDay({ fc, lang }: { fc: ForecastResponse; lang: Lang }) {
  const th = lang === 'th';
  const days = fc.daily.filter((d) => d.tmin != null && d.tmax != null) as (ForecastDay & { tmin: number; tmax: number })[];
  if (!days.length) return null;
  const lo = Math.floor(Math.min(...days.map((d) => d.tmin)));
  const hi = Math.ceil(Math.max(...days.map((d) => d.tmax)));
  const span = Math.max(1, hi - lo);
  const metFrom = days.findIndex((d) => d.source === 'met');
  return (
    <section className="panel-section" aria-labelledby="tenday-h">
      <h3 id="tenday-h">{th ? `พยากรณ์ ${days.length} วัน` : `${days.length}-day forecast`}</h3>
      <ol className="tenday">
        {days.map((d, k) => {
          const wet = (d.pop_max ?? 0) >= 30 || d.rain_mm >= 1;
          return (
            <li key={d.date} className="tenday-row" data-source={d.source}>
              <span className="tenday-day">{k === 0 ? (th ? 'วันนี้' : 'Today') : fmtDay(d.date, lang).split(' ')[0]}</span>
              <ConditionIcon code={d.condition.code} size={26} title={th ? d.condition.label_th : d.condition.label_en} />
              <span className="tenday-rain" data-wet={wet || undefined}>
                {d.pop_max != null ? `${fmtNum(d.pop_max, 0)}%` : d.rain_mm >= 0.1 ? `${fmtNum(d.rain_mm, 1)} ${th ? 'มม.' : 'mm'}` : ''}
              </span>
              <span className="tenday-t muted">{fmtNum(d.tmin, 0)}°</span>
              <span className="tenday-bar" aria-hidden="true">
                <i style={{ left: `${((d.tmin - lo) / span) * 100}%`, right: `${((hi - d.tmax) / span) * 100}%`, background: `linear-gradient(90deg, ${rgb(d.tmin)}, ${rgb(d.tmax)})` }} />
              </span>
              <span className="tenday-t">{fmtNum(d.tmax, 0)}°</span>
            </li>
          );
        })}
      </ol>
      <p className="subtle tenday-note">
        {metFrom > 0
          ? th
            ? `${metFrom} วันแรกจากพยากรณ์ 2.2 กม. (โอกาสฝน %) · วันถัดไปจาก MET Norway (~9 กม., ปริมาณฝน มม.) หยาบกว่าและคลาดได้มากขึ้นตามระยะ`
            : `First ${metFrom} days from the 2.2 km forecast (chance of rain) · later days from MET Norway (~9 km, rain in mm), coarser and less certain further out`
          : th
            ? 'จากพยากรณ์ 2.2 กม.'
            : 'From the 2.2 km forecast'}
      </p>
    </section>
  );
}
