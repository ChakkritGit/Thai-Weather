import { weatherScales } from '../design/generated/tokens';
import type { Lang } from '../i18n/dict';
import type { Alert, DayCoverage, RunMeta } from './api';

/**
 * One alert vocabulary for the whole site.
 *
 * Alert *tiers* (1 yellow · 2 orange · 3 red) are the only thing shown as a
 * coloured alert.  Hazard *levels* (e.g. the Dept. of Health heat-index level
 * "เตือนภัย") keep their official names but are only ever shown together with
 * their hazard name, as plain text.
 */

interface TierToken {
  name_th: string;
  name_en: string;
  advice_th: string;
  advice_en: string;
  label_th: string;
  label_en: string;
}

const tierTokens = weatherScales.severity as unknown as Record<string, TierToken>;

export interface Tier {
  severity: number;
  /** "เหลือง" / "Yellow" */
  name: string;
  /** "ควรติดตาม" / "Be aware" */
  advice: string;
  /** "เหลือง · ควรติดตาม" / "Yellow · Be aware" */
  label: string;
}

export function tierInfo(severity: number, lang: Lang): Tier {
  const t = tierTokens[String(severity)];
  if (!t) return { severity, name: '', advice: '', label: '' };
  const th = lang === 'th';
  return {
    severity,
    name: th ? t.name_th : t.name_en,
    advice: th ? t.advice_th : t.advice_en,
    label: th ? t.label_th : t.label_en,
  };
}

export const maxSeverity = (alerts: readonly { severity: number }[]): number =>
  alerts.reduce((m, a) => Math.max(m, a.severity), 0);

/** Provinces per tier, counting each province once at its highest tier. Index 0 = tier 1. */
export function tierCounts(perProvince: readonly (readonly { severity: number }[])[]): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  for (const alerts of perProvince) {
    const s = maxSeverity(alerts);
    if (s >= 1 && s <= 3) out[s - 1] += 1;
  }
  return out;
}

const HAZARDS: Record<string, { th: string; en: string; src_th: string; src_en: string; unit_th: string; unit_en: string }> = {
  heat: { th: 'ดัชนีความร้อน', en: 'Heat index', src_th: 'กรมอนามัย', src_en: 'Dept. of Health', unit_th: '°', unit_en: '°' },
  rain: { th: 'ฝน', en: 'Rain', src_th: 'กรมอุตุนิยมวิทยา', src_en: 'TMD', unit_th: ' มม.', unit_en: ' mm' },
  storm: { th: 'พายุฝนฟ้าคะนอง', en: 'Thunderstorms', src_th: '', src_en: '', unit_th: '%', unit_en: '%' },
  wind: { th: 'ลม', en: 'Wind', src_th: 'มาตราโบฟอร์ต', src_en: 'Beaufort scale', unit_th: ' ม./วินาที', unit_en: ' m/s' },
  hot: { th: 'อุณหภูมิสูง', en: 'High temperature', src_th: 'กรมอุตุนิยมวิทยา', src_en: 'TMD', unit_th: '°', unit_en: '°' },
  cold: { th: 'อุณหภูมิต่ำ', en: 'Low temperature', src_th: 'กรมอุตุนิยมวิทยา', src_en: 'TMD', unit_th: '°', unit_en: '°' },
};

export function hazardName(hazard: string, lang: Lang): string {
  const h = HAZARDS[hazard];
  return h ? h[lang] : hazard;
}

export function hazardSource(hazard: string, lang: Lang): string {
  const h = HAZARDS[hazard];
  return h ? (lang === 'th' ? h.src_th : h.src_en) : '';
}

/** "ดัชนีความร้อน: อันตราย" – the hazard level, always introduced by its hazard name. */
export function hazardLevelText(alert: Pick<Alert, 'hazard' | 'label_th' | 'label_en'>, lang: Lang): string {
  return `${hazardName(alert.hazard, lang)}: ${lang === 'th' ? alert.label_th : alert.label_en}`;
}

export function alertValueText(alert: Pick<Alert, 'hazard' | 'value'>, lang: Lang): string {
  const h = HAZARDS[alert.hazard];
  const unit = h ? (lang === 'th' ? h.unit_th : h.unit_en) : '';
  return `${Math.round(alert.value)}${unit}`;
}

/** Long form for tooltips: tier, hazard level, source and value. */
export function alertTitle(alert: Alert, lang: Lang): string {
  const src = hazardSource(alert.hazard, lang);
  return `${tierInfo(alert.severity, lang).label} – ${hazardLevelText(alert, lang)}${src ? ` (${src})` : ''} ${alertValueText(alert, lang)}`;
}

/** A forecast day with fewer than 18 hourly steps only covers part of the day. */
export const PARTIAL_HOURS = 18;

export function isPartialDay(d: Pick<DayCoverage, 'hours' | 'partial'>): boolean {
  return d.partial ?? d.hours < PARTIAL_HOURS;
}

/** "ข้อมูลถึง 23:00 น." – null for complete days. */
export function coverageNote(d: Pick<DayCoverage, 'hours' | 'partial' | 'until'>, lang: Lang): string | null {
  if (!isPartialDay(d)) return null;
  if (lang === 'th') return d.until ? `ข้อมูลถึง ${d.until} น.` : `มีข้อมูล ${d.hours} ชั่วโมง`;
  return d.until ? `Data until ${d.until}` : `${d.hours} h of data`;
}

/** Forecast-source wording for non-experts, e.g. "GFS (NOAA) ผ่าน Open-Meteo". */
export function sourceLabel(run: Pick<RunMeta, 'source' | 'model' | 'demo'>, lang: Lang): string {
  if (run.demo || run.source !== 'open-meteo') return lang === 'th' ? 'ข้อมูลจำลองเพื่อสาธิต' : 'Synthetic demo data';
  const m = run.model.toLowerCase();
  const model = m.startsWith('gfs')
    ? 'GFS (NOAA)'
    : m.startsWith('ecmwf')
      ? 'ECMWF IFS'
      : m.startsWith('icon')
        ? 'ICON (DWD)'
        : run.model;
  return lang === 'th' ? `${model} ผ่าน Open-Meteo` : `${model} via Open-Meteo`;
}
