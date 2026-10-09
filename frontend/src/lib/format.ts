import type { Lang } from '../i18n/dict';

const TZ = 'Asia/Bangkok';
const locale = (lang: Lang) => (lang === 'th' ? 'th-TH' : 'en-GB');

// ICU versions disagree on punctuation and Thai short weekdays (ศุกร์ vs ศ.).
// Shared labels and explicit separators keep server and browser text identical.
const WEEKDAYS = {
  th: {
    short: ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'],
    long: ['วันอาทิตย์', 'วันจันทร์', 'วันอังคาร', 'วันพุธ', 'วันพฤหัสบดี', 'วันศุกร์', 'วันเสาร์'],
  },
  en: {
    short: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    long: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  },
} as const;
const MONTHS = {
  th: ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'],
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'],
} as const;

function bangkokParts(date: Date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, calendar: 'gregory', numberingSystem: 'latn', hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  const year = Number(value('year'));
  const month = Number(value('month'));
  const day = Number(value('day'));
  return {
    year, month, day,
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
    clock: `${value('hour').padStart(2, '0')}:${value('minute').padStart(2, '0')}`,
  };
}

export function fmtStep(iso: string, lang: Lang): string {
  const p = bangkokParts(new Date(iso));
  const date = `${WEEKDAYS[lang].short[p.weekday]} ${p.day} ${MONTHS[lang][p.month - 1]}`;
  return `${date}${lang === 'th' ? ' ' : ', '}${p.clock}`;
}

export function fmtHour(iso: string, _lang: Lang): string {
  return bangkokParts(new Date(iso)).clock;
}

export function fmtDay(date: string, lang: Lang, long = false): string {
  const p = bangkokParts(new Date(`${date}T12:00:00+07:00`));
  const weekday = WEEKDAYS[lang][long ? 'long' : 'short'][p.weekday];
  return `${weekday}${lang === 'th' && long ? 'ที่ ' : ' '}${p.day} ${MONTHS[lang][p.month - 1]}`;
}

export function fmtDateTime(iso: string, lang: Lang): string {
  const p = bangkokParts(new Date(iso));
  const year = p.year + (lang === 'th' ? 543 : 0);
  return `${p.day} ${MONTHS[lang][p.month - 1]} ${year}${lang === 'th' ? ' ' : ', '}${p.clock}`;
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

/** Grid resolution in km: one decimal only when needed (27.8 -> "27.8", 22 -> "22"). */
export function fmtKm(km: number, lang: Lang): string {
  if (!Number.isFinite(km)) return '–';
  const r = Math.round(km * 10) / 10;
  return r.toLocaleString(locale(lang) === 'th-TH' ? 'en-US' : 'en-GB', { maximumFractionDigits: 1, minimumFractionDigits: Number.isInteger(r) ? 0 : 1 });
}
