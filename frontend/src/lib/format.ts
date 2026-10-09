import type { Lang } from '../i18n/dict';

const TZ = 'Asia/Bangkok';
const locale = (lang: Lang) => (lang === 'th' ? 'th-TH' : 'en-GB');

export function fmtStep(iso: string, lang: Lang): string {
  return new Intl.DateTimeFormat(locale(lang), {
    timeZone: TZ,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

export function fmtHour(iso: string, lang: Lang): string {
  return new Intl.DateTimeFormat(locale(lang), { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(
    new Date(iso),
  );
}

export function fmtDay(date: string, lang: Lang, long = false): string {
  return new Intl.DateTimeFormat(locale(lang), {
    timeZone: TZ,
    weekday: long ? 'long' : 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(`${date}T12:00:00+07:00`));
}

export function fmtDateTime(iso: string, lang: Lang): string {
  return new Intl.DateTimeFormat(locale(lang), {
    timeZone: TZ,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

/** Local Thai hour (0–23) for a timestamp. */
export function thaiHour(iso: string): number {
  return (new Date(iso).getUTCHours() + 7) % 24;
}

export function nearestStep(times: string[], now = Date.now()): number {
  let best = 0;
  let bestDiff = Infinity;
  times.forEach((t, i) => {
    const d = Math.abs(new Date(t).getTime() - now);
    if (d < bestDiff) {
      best = i;
      bestDiff = d;
    }
  });
  return best;
}

export const fmtNum = (v: number, digits = 0) =>
  Number.isFinite(v) ? v.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits }) : '–';

export const DIRS_TH = ['เหนือ', 'ตะวันออกเฉียงเหนือ', 'ตะวันออก', 'ตะวันออกเฉียงใต้', 'ใต้', 'ตะวันตกเฉียงใต้', 'ตะวันตก', 'ตะวันตกเฉียงเหนือ'];
export const DIRS_EN = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export function compass(deg: number, lang: Lang): string {
  const i = Math.round((((deg % 360) + 360) % 360) / 45) % 8;
  return (lang === 'th' ? DIRS_TH : DIRS_EN)[i];
}

/** Thai local calendar date (YYYY-MM-DD) of a UTC timestamp. */
export const thaiDate = (iso: string) => new Date(new Date(iso).getTime() + 7 * 3600_000).toISOString().slice(0, 10);
