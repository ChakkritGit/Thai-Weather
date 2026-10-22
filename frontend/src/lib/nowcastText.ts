import type { Nowcast, NowcastCyclone, NowcastEta, NowcastSpell, RainClass } from './api';
import { compass, fmtHour, nearestStep } from './format';
import type { Lang } from '../i18n/dict';

/**
 * Plain-language sentences for the radar nowcast card.  Everything here is a radar-based
 * estimate, so arrivals say "likely" ("น่าจะ") rather than promise.  Pure functions, no I/O.
 */

export interface CycloneLine {
  id: string;
  text: string;
  severity: 0 | 1 | 2 | 3;
  category: NowcastCyclone['category'];
  url: string | null;
}

export interface NowcastText {
  headline: string;
  /** 0 calm … 3 severe – drives the card colour */
  severity: 0 | 1 | 2 | 3;
  icon: 'drop' | 'bolt' | 'cloud' | 'info';
  details: string[];
  cyclones: CycloneLine[];
}

/** The response stays tied to the point and receipt time, including a failed refresh. */
export interface NowcastSnapshot {
  lat: number;
  lon: number;
  status: 'loading' | 'ready' | 'error' | 'hidden';
  data: Nowcast | null;
  receivedAtMs: number | null;
}

// Keep in sync with backend/app/nowcast/service.py: STALE_AFTER_MIN.
const RADAR_STALE_AFTER_MIN = 30;
const CURRENT_STEP_WINDOW_MS = 30 * 60_000;

/** Reject old-point snapshots before the point-change effect has run. */
export function nowcastForPoint(snapshot: NowcastSnapshot, lat: number, lon: number): NowcastSnapshot {
  return snapshot.lat === lat && snapshot.lon === lon
    ? snapshot
    : { lat, lon, status: 'loading', data: null, receivedAtMs: null };
}

/** Conservatively age the frame using both its timestamp and the server's reported age. */
export function radarAgeMinutes(snapshot: NowcastSnapshot, nowMs: number): number | null {
  const n = snapshot.data;
  const frameMs = n?.frame_time ? Date.parse(n.frame_time) : NaN;
  if (
    !n ||
    !Number.isFinite(nowMs) ||
    !Number.isFinite(frameMs) ||
    frameMs > nowMs ||
    n.age_min === null ||
    !Number.isFinite(n.age_min) ||
    n.age_min < 0 ||
    snapshot.receivedAtMs === null ||
    !Number.isFinite(snapshot.receivedAtMs) ||
    snapshot.receivedAtMs > nowMs
  ) return null;
  return Math.max((nowMs - frameMs) / 60_000, n.age_min + Math.max(0, nowMs - snapshot.receivedAtMs) / 60_000);
}

export function isFreshRadar(snapshot: NowcastSnapshot, nowMs: number): boolean {
  const age = radarAgeMinutes(snapshot, nowMs);
  return snapshot.data?.available === true && snapshot.data.reason === null && age !== null && age <= RADAR_STALE_AFTER_MIN;
}

/** Uses the same nearest-hour convention as the timeline, but excludes expired runs. */
export function isCurrentForecastStep(times: string[], step: number, nowMs: number): boolean {
  const selectedMs = Date.parse(times[step] ?? '');
  return Number.isFinite(nowMs) && Number.isFinite(selectedMs)
    && step === nearestStep(times, nowMs)
    && Math.abs(selectedMs - nowMs) <= CURRENT_STEP_WINDOW_MS;
}

/** How the radar adjusted the current hour's rain chance. */
export type RadarPopBasis = 'rain-now' | 'arriving' | 'clear';

export interface RadarRainChance {
  /** the chance to show for the current hour, 0–100 */
  value: number;
  /** the 2.2 km model value it started from */
  model: number;
  basis: RadarPopBasis;
  /** rain class seen now / arriving */
  cls?: RainClass;
  /** minutes until it arrives ("arriving") */
  minutes?: number;
}

/** Rain at the spot now: the hour is (almost) certainly wet; radar can still over-read light echoes. */
const POP_RAINING: Record<RainClass, number> = { none: 0, light: 80, moderate: 90, heavy: 95, thunderstorm: 95, severe: 95 };
const ARRIVAL_WINDOW_MIN = 60;
/** No echo here and none moving in: new cells can still form, so pull towards a low value, not to zero. */
const POP_CLEAR = 5;
const CLEAR_WEIGHT = 0.5;

/**
 * Rain chance for the current hour, adjusted with the radar nowcast (fresh frame + current step only).
 * Observed rain beats the model: raining now or arriving within the hour raises the chance; a clear
 * radar with nothing approaching lowers it halfway towards 5%. Other hours stay pure model.
 */
export function radarRainChance({
  snapshot, lat, lon, times, step, modelPop, nowMs,
}: {
  snapshot: NowcastSnapshot;
  lat: number;
  lon: number;
  times: string[];
  step: number;
  modelPop: number;
  nowMs: number;
}): RadarRainChance | null {
  const current = nowcastForPoint(snapshot, lat, lon);
  if (
    current.status !== 'ready' ||
    !isFreshRadar(current, nowMs) ||
    !isCurrentForecastStep(times, step, nowMs) ||
    !Number.isFinite(modelPop) || modelPop < 0 || modelPop > 100
  ) return null;
  const n = current.data!;
  const model = Math.round(modelPop);
  const here = presentRainClass(n);
  if (here !== 'none') return { value: Math.max(model, POP_RAINING[here]), model, basis: 'rain-now', cls: here };
  const isRain = (cls: RainClass | undefined) => cls !== undefined && cls !== 'none' && cls in SEVERITY;
  const eta = [n.eta_rain, n.eta_storm]
    .filter((e): e is NowcastEta => !!e && isRain(e.class) && e.minutes > 0 && e.minutes <= ARRIVAL_WINDOW_MIN)
    .sort((a, b) => a.minutes - b.minutes)[0];
  if (eta) {
    const arriving = Math.min(90, Math.max(40, Math.round(95 - eta.minutes * 0.9)));
    return { value: Math.max(model, arriving), model, basis: 'arriving', cls: eta.class, minutes: eta.minutes };
  }
  const value = model <= POP_CLEAR ? model : Math.round(model + (POP_CLEAR - model) * CLEAR_WEIGHT);
  return { value, model, basis: 'clear' };
}

/** Rain class as a phrase inside a sentence ("ฝนเล็กน้อย" / "light rain"). */
export function rainClassPhrase(cls: RainClass, lang: Lang): string {
  return lang === 'th' ? TH_CLASS[cls] : EN_CLASS[cls].toLowerCase();
}

const TH_CLASS: Record<RainClass, string> = {
  none: '',
  light: 'ฝนเล็กน้อย',
  moderate: 'ฝนปานกลาง',
  heavy: 'ฝนหนัก',
  thunderstorm: 'พายุฝนฟ้าคะนอง',
  severe: 'พายุฝนฟ้าคะนองรุนแรง',
};
const EN_CLASS: Record<RainClass, string> = {
  none: '',
  light: 'Light rain',
  moderate: 'Moderate rain',
  heavy: 'Heavy rain',
  thunderstorm: 'Thunderstorm',
  severe: 'Severe thunderstorm',
};
const TH_CELL: Partial<Record<RainClass, string>> = {
  heavy: 'กลุ่มฝนหนัก',
  thunderstorm: 'กลุ่มพายุฝนฟ้าคะนอง',
  severe: 'กลุ่มพายุฝนฟ้าคะนองรุนแรง',
};
const EN_CELL: Partial<Record<RainClass, string>> = {
  heavy: 'Heavy rain cell',
  thunderstorm: 'Thunderstorm cell',
  severe: 'Severe thunderstorm cell',
};
const TH_CAT = { TD: 'พายุดีเปรสชัน', TS: 'พายุโซนร้อน', TY: 'พายุไต้ฝุ่น' } as const;
const EN_CAT = { TD: 'Tropical depression', TS: 'Tropical storm', TY: 'Typhoon' } as const;

const CAT_RANK = { TD: 0, TS: 1, TY: 2 } as const;

const SEVERITY: Record<RainClass, 0 | 1 | 2 | 3> = { none: 0, light: 0, moderate: 1, heavy: 2, thunderstorm: 2, severe: 3 };
const ICON: Record<RainClass, NowcastText['icon']> = {
  none: 'cloud',
  light: 'drop',
  moderate: 'drop',
  heavy: 'drop',
  thunderstorm: 'bolt',
  severe: 'bolt',
};

/** A nearby cell or a positive arrival time does not imply rain at this point now. */
function presentRainClass(n: Nowcast): RainClass {
  const isRain = (cls: RainClass | undefined) => cls !== undefined && cls !== 'none' && cls in SEVERITY;
  if (isRain(n.now?.class)) return n.now!.class;
  return [n.eta_storm, n.eta_rain].find((e) => e?.minutes === 0 && isRain(e.class))?.class ?? 'none';
}

function nearestText(near: NonNullable<Nowcast['nearest']>, lang: Lang): string {
  const th = lang === 'th';
  const cell = (th ? TH_CELL : EN_CELL)[near.class] ?? (th ? TH_CLASS : EN_CLASS)[near.class];
  const dir = compass(near.bearing_deg, lang);
  const km = Math.round(near.distance_km);
  const closing = Math.round(near.closing_kmh);
  if (km === 0) return th ? `${cell}อยู่ตรงบริเวณนี้` : `${cell} right over this spot`;
  const track = near.track ?? (near.approaching ? 'toward' : undefined);
  const where = th ? `${cell}ห่าง ${km} กม. ทาง${dir}` : `${cell} ${km} km ${dir}`;
  const motion = {
    toward: th ? `เคลื่อนเข้ามา ${closing} กม./ชม.` : `moving toward you at ${closing} km/h`,
    passing: th ? 'กำลังเคลื่อนผ่านไป ไม่ตรงมาที่นี่' : 'passing by, not heading here',
    away: th ? 'กำลังเคลื่อนออกห่าง' : 'moving away',
    stationary: th ? 'แทบไม่เคลื่อนที่' : 'barely moving',
  };
  const tail = track ? motion[track] : th ? 'ไม่ได้เคลื่อนเข้าหาคุณ' : 'not moving toward you';
  return th ? `${where} ${tail}` : `${where}, ${tail}`;
}

/** Cyclones farther than this (now and at closest approach) are not worth mentioning for a point. */
export const MAX_CYCLONE_KM = 2000;

const dash = '–';

/** "20–35" for a real range, "15" when the estimate is sharp. */
function minutesText(eta: NowcastEta): string {
  const [lo, hi] = eta.minutes_range;
  return hi - lo < 5 ? String(eta.minutes) : `${lo}${dash}${hi}`;
}

function leadText(hours: number, lang: Lang): string {
  if (hours < 1) return lang === 'th' ? '<1 ชม.' : '<1 h';
  if (hours < 48) return `${Math.round(hours)} ${lang === 'th' ? 'ชม.' : 'h'}`;
  return `${Math.round(hours / 24)} ${lang === 'th' ? 'วัน' : 'days'}`;
}

function unavailable(n: Nowcast, lang: Lang): string {
  const th: Record<string, string> = {
    stale: `ข้อมูลเรดาร์ไม่ทันสมัย (เก่า ${n.age_min ?? '?'} นาที) จึงยังประเมินฝนระยะสั้นไม่ได้`,
    no_coverage: 'จุดนี้อยู่นอกพื้นที่ตรวจจับของเรดาร์ จึงประเมินฝนระยะสั้นไม่ได้',
    disabled: 'ระบบประเมินฝนจากเรดาร์ถูกปิดใช้งาน',
    no_data: 'กำลังรอข้อมูลเรดาร์ชุดแรก',
  };
  const en: Record<string, string> = {
    stale: `Radar data is out of date (${n.age_min ?? '?'} min old), so the short-range rain outlook is unavailable`,
    no_coverage: 'This spot is outside radar coverage, so the short-range rain outlook is unavailable',
    disabled: 'The radar rain outlook is switched off',
    no_data: 'Waiting for the first radar frame',
  };
  const key = n.reason ?? 'no_data';
  return (lang === 'th' ? th : en)[key] ?? (lang === 'th' ? th.no_data : en.no_data);
}

export function cycloneSentence(c: NowcastCyclone, lang: Lang): CycloneLine {
  const dNow = Math.round(c.distance_now_km);
  const dMin = Math.round(c.closest.distance_km);
  const staying = c.closest.hours < 1 && dNow - dMin < 25; // moving away, or already as close as it gets
  const zone = c.in_wind_zone_kmh;
  let text: string;
  if (lang === 'th') {
    const base = `${TH_CAT[c.category]} ${c.name} ห่าง ${dNow} กม.`;
    if (zone) text = `${base} จุดนี้อยู่ในเขตลมแรงตั้งแต่ ${zone} กม./ชม. ตามแนวพยากรณ์`;
    else if (staying) text = `${base} ไม่เข้าใกล้ไปกว่านี้`;
    else text = `${base} เข้าใกล้สุด ~${dMin} กม. ในอีก ${leadText(c.closest.hours, lang)}`;
  } else {
    const base = `${EN_CAT[c.category]} ${c.name} is ${dNow} km away`;
    if (zone) text = `${base}; this spot lies inside its forecast ${zone}+ km/h wind swath`;
    else if (staying) text = `${base} and will not get any closer`;
    else text = `${base}; closest approach ~${dMin} km in ${leadText(c.closest.hours, lang)}`;
  }
  const nearest = Math.min(dNow, dMin);
  if (CAT_RANK[c.peak_category] > CAT_RANK[c.category]) {
    text += lang === 'th' ? ` (คาดว่าอาจทวีกำลังเป็น${TH_CAT[c.peak_category]})` : ` (may strengthen to a ${EN_CAT[c.peak_category].toLowerCase()})`;
  }
  const severity: 0 | 1 | 2 | 3 = zone ? (zone >= 120 ? 3 : 2) : nearest < 300 ? 2 : nearest < 600 ? 1 : 0;
  return { id: c.id, text, severity, category: c.category, url: c.report_url };
}

/** Keep in sync with backend/app/nowcast/nowcast.py: RADIUS_KM — the radar speaks only for rain this close. */
export const RADAR_RADIUS_KM = 4;
/** The 2.2 km model's hourly series, used when the radar sees no rain within RADAR_RADIUS_KM. */
export interface ModelOutlook {
  times: string[];
  pop: number[];
  /** "2.2 km" in the reader's language */
  km: string;
  nowMs: number;
}
/** Model hours with at least this rain chance count as "rain expected". */
export const MODEL_RAIN_POP = 40;
const MODEL_LOOKAHEAD_H = 6;
const MODEL_SPELL_CAP_H = 12;

function hoursText(minutes: number, lang: Lang): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (lang === 'th') return m < 15 ? `${h} ชม.` : `${h} ชม. ${m} นาที`;
  return m < 15 ? `${h} h` : `${h} h ${m} min`;
}

/** How long the radar expects the rain over the point to last ("" when unknown). */
export function spellText(spell: NowcastSpell | null | undefined, lang: Lang): string {
  if (!spell) return '';
  const th = lang === 'th';
  if (spell.open_ended) {
    const h = Math.floor(spell.horizon_min / 60);
    return th ? `น่าจะตกต่อเนื่องอย่างน้อย ${h} ชม.` : `Likely to keep raining for at least ${h} h`;
  }
  const lasts = spell.lasts_min ?? 0;
  if (spell.start_min === 0) {
    if (lasts < 60) return th ? `น่าจะหยุดในอีกราว ${lasts} นาที` : `Likely to stop in about ${lasts} min`;
    return th ? `น่าจะตกอีกราว ${hoursText(lasts, lang)}` : `Likely to last about ${hoursText(lasts, lang)} more`;
  }
  const len = lasts < 60 ? (th ? `${lasts} นาที` : `${lasts} min`) : hoursText(lasts, lang);
  return th ? `น่าจะตกราว ${len}` : `Likely to last about ${len}`;
}

/** The model's outlook for the next hours: when rain may start, its chance and how long it lasts. */
export function modelOutlook(m: ModelOutlook, lang: Lang): { headline: string; details: string[]; severity: 0 | 1 } {
  const th = lang === 'th';
  const now = nearestStep(m.times, m.nowMs);
  const ahead = m.pop.slice(now, now + MODEL_LOOKAHEAD_H + 1);
  const start = ahead.findIndex((p) => Number.isFinite(p) && p >= MODEL_RAIN_POP);
  const src = th ? `โมเดล ${m.km}` : `${m.km} model`;
  if (start < 0) {
    const peak = Math.round(Math.max(0, ...ahead.filter(Number.isFinite)));
    return {
      headline: th ? `ไม่มีฝนในรัศมี ${RADAR_RADIUS_KM} กม. และไม่น่ามีฝนใน ${MODEL_LOOKAHEAD_H} ชม. ข้างหน้า` : `No rain within ${RADAR_RADIUS_KM} km, and none likely in the next ${MODEL_LOOKAHEAD_H} h`,
      details: [th ? `${src}: โอกาสฝนสูงสุด ${peak}%` : `${src}: rain chance at most ${peak}%`],
      severity: 0,
    };
  }
  const k = now + start;
  let end = k;
  while (end + 1 < m.pop.length && end - k + 1 < MODEL_SPELL_CAP_H && m.pop[end + 1] >= MODEL_RAIN_POP) end++;
  const hours = end - k + 1;
  const peak = Math.round(Math.max(...m.pop.slice(k, end + 1)));
  const when = start === 0
    ? (th ? 'ชั่วโมงนี้' : 'this hour')
    : th ? `ราว ${fmtHour(m.times[k], lang)} น.` : `around ${fmtHour(m.times[k], lang)}`;
  const capped = hours >= MODEL_SPELL_CAP_H;
  const length = th
    ? `${capped ? 'อย่างน้อย ' : 'ราว '}${hours} ชม.`
    : `${capped ? 'at least ' : 'about '}${hours} h`;
  return {
    headline: th ? `${src}: อาจมีฝน${when} (โอกาส ${peak}%)` : `${src}: rain possible ${when} (${peak}% chance)`,
    details: [
      th ? `ช่วงที่มีโอกาสฝน ${length}` : `Rain chance stays up for ${length}`,
      th ? `เรดาร์ยังไม่พบฝนในรัศมี ${RADAR_RADIUS_KM} กม.` : `Radar shows no rain within ${RADAR_RADIUS_KM} km yet`,
    ],
    severity: peak >= 70 ? 1 : 0,
  };
}

/**
 * Headline, detail lines and cyclone lines for a nowcast response. The radar speaks when it sees
 * rain within RADAR_RADIUS_KM of the point (now or arriving within the hour); otherwise the 2.2 km
 * model's outlook (when given) takes the headline.
 */
export function nowcastSentence(n: Nowcast, lang: Lang, model?: ModelOutlook): NowcastText {
  const th = lang === 'th';
  const cyclones = [...n.cyclones]
    .filter((c) => Math.min(c.distance_now_km, c.closest.distance_km) <= MAX_CYCLONE_KM)
    .sort((a, b) => a.distance_now_km - b.distance_now_km)
    .slice(0, 3)
    .map((c) => cycloneSentence(c, lang));

  if (!n.available) {
    return { headline: unavailable(n, lang), severity: 0, icon: 'info', details: [], cyclones };
  }

  const names = th ? TH_CLASS : EN_CLASS;
  const details: string[] = [];
  // an ETA of 0 minutes means it is already happening here
  const presentClass = presentRainClass(n);
  const stormLater = n.eta_storm && n.eta_storm.minutes > 0 ? n.eta_storm : null;
  const rainLater = n.eta_rain && n.eta_rain.minutes > 0 ? n.eta_rain : null;

  const arrival = (eta: NowcastEta) =>
    th
      ? `${names[eta.class]}น่าจะถึงในอีก ${minutesText(eta)} นาที`
      : `${names[eta.class]} likely in ${minutesText(eta)} min`;

  let headline: string;
  let cls: RainClass;
  if (presentClass !== 'none') {
    cls = presentClass;
    headline = th ? `กำลังมี${names[cls]}บริเวณนี้` : `${names[cls]} here now`;
    const lasts = spellText(n.rain_spell, lang);
    if (lasts) details.push(lasts);
    if (stormLater && SEVERITY[stormLater.class] > SEVERITY[presentClass]) details.push(arrival(stormLater));
  } else if (stormLater || rainLater) {
    const lead = stormLater ?? (rainLater as NowcastEta);
    cls = lead.class;
    headline = arrival(lead);
    if (stormLater && rainLater && stormLater.minutes - rainLater.minutes >= 10) {
      details.push(th ? `ฝนเริ่มตกก่อนในอีก ${minutesText(rainLater)} นาที` : `Rain starts in ${minutesText(rainLater)} min`);
    }
    const lasts = n.rain_spell && n.rain_spell.start_min > 0 ? spellText(n.rain_spell, lang) : '';
    if (lasts) details.push(lasts);
  } else if (model) {
    const m = modelOutlook(model, lang);
    cls = 'none';
    headline = m.headline;
    details.push(...m.details);
    const near = n.nearest;
    if (near) details.push(nearestText(near, lang));
    return { headline, severity: m.severity, icon: m.severity ? 'drop' : 'cloud', details, cyclones };
  } else {
    cls = 'none';
    headline = th ? `ไม่มีฝนในรัศมี ${RADAR_RADIUS_KM} กม. ใน 1 ชม. ข้างหน้า` : `No rain within ${RADAR_RADIUS_KM} km in the next hour`;
  }

  const near = n.nearest;
  if (near) {
    details.push(nearestText(near, lang));
  } else if (cls === 'none') {
    details.push(th ? 'ไม่พบกลุ่มฝนหนักในรัศมี 100 กม.' : 'No heavy rain cells within 100 km');
  }

  const m = n.motion;
  if (m && m.heading_deg !== null && m.speed_kmh >= 5 && (near || cls !== 'none')) {
    const dir = compass(m.heading_deg, lang);
    details.push(
      th
        ? `ฝนเคลื่อนไปทาง${dir} ความเร็ว ${Math.round(m.speed_kmh)} กม./ชม.`
        : `Rain is moving ${dir} at ${Math.round(m.speed_kmh)} km/h`,
    );
  }

  return { headline, severity: SEVERITY[cls], icon: ICON[cls], details, cyclones };
}
