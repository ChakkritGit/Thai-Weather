import { describe, expect, it } from 'vitest';
import { buildRadarLut } from './color';
import { cycloneSentence, isCurrentForecastStep, isFreshRadar, nowcastForPoint, nowcastSentence, radarAgeMinutes, radarRainChance, rainClassPhrase, type NowcastSnapshot } from './nowcastText';
import type { Nowcast, NowcastCyclone, NowcastEta } from './api';
import { translate } from '../i18n/dict';

const eta = (minutes: number, range: [number, number], cls: NowcastEta['class'] = 'thunderstorm'): NowcastEta => ({
  minutes,
  minutes_range: range,
  class: cls,
  max_dbz: 50,
});

const nc = (over: Partial<Nowcast> = {}): Nowcast => ({
  available: true,
  reason: null,
  frame_time: '2026-10-09T06:20:00+00:00',
  age_min: 4,
  now: { class: 'none', max_dbz: null },
  eta_rain: null,
  eta_storm: null,
  nearest: null,
  motion: { speed_kmh: 0, heading_deg: null },
  cyclones: [],
  attribution: [],
  ...over,
});

const cyclone = (over: Partial<NowcastCyclone> = {}): NowcastCyclone => ({
  id: '1-1',
  name: 'Simon',
  source: 'JTWC',
  category: 'TS',
  peak_category: 'TS',
  max_wind_kmh: 90,
  report_url: 'https://www.gdacs.org/report',
  position: { lat: 14, lon: 112 },
  distance_now_km: 820,
  closest: { time: '2026-10-10T19:00:00+00:00', hours: 36, distance_km: 410 },
  in_wind_zone_kmh: null,
  ...over,
});

describe('nowcast text', () => {
  it('says what is happening now (TH/EN)', () => {
    const n = nc({ now: { class: 'heavy', max_dbz: 42 } });
    expect(nowcastSentence(n, 'th').headline).toBe('กำลังมีฝนหนักบริเวณนี้');
    expect(nowcastSentence(n, 'en').headline).toBe('Heavy rain here now');
    expect(nowcastSentence(n, 'th').severity).toBe(2);
    expect(nowcastSentence(nc({ now: { class: 'severe', max_dbz: 58 } }), 'th').severity).toBe(3);
  });

  it('treats an ETA of 0 minutes as already happening', () => {
    const n = nc({ eta_rain: eta(0, [0, 0], 'moderate') });
    expect(nowcastSentence(n, 'th').headline).toBe('กำลังมีฝนปานกลางบริเวณนี้');
  });

  it('gives the arrival time as a range, or a single number when sharp', () => {
    const range = nc({ eta_storm: eta(25, [20, 35]), eta_rain: eta(25, [20, 35], 'heavy') });
    expect(nowcastSentence(range, 'th').headline).toBe('พายุฝนฟ้าคะนองน่าจะถึงในอีก 20–35 นาที');
    expect(nowcastSentence(range, 'en').headline).toBe('Thunderstorm likely in 20–35 min');
    const sharp = nc({ eta_rain: eta(15, [15, 15], 'light') });
    expect(nowcastSentence(sharp, 'th').headline).toBe('ฝนเล็กน้อยน่าจะถึงในอีก 15 นาที');
    expect(nowcastSentence(sharp, 'en').headline).toBe('Light rain likely in 15 min');
  });

  it('mentions earlier rain ahead of a later storm, and a storm following current rain', () => {
    const both = nowcastSentence(nc({ eta_rain: eta(10, [5, 15], 'light'), eta_storm: eta(40, [30, 50]) }), 'th');
    expect(both.headline).toContain('30–50');
    expect(both.details).toContain('ฝนเริ่มตกก่อนในอีก 5–15 นาที');
    const later = nowcastSentence(nc({ now: { class: 'light', max_dbz: 24 }, eta_storm: eta(20, [15, 25]) }), 'en');
    expect(later.headline).toBe('Light rain here now');
    expect(later.details[0]).toBe('Thunderstorm likely in 15–25 min');
  });

  it('describes the nearest strong cell and its motion', () => {
    const n = nc({
      eta_storm: eta(30, [25, 40]),
      nearest: { distance_km: 18.2, bearing_deg: 225, class: 'heavy', max_dbz: 43, approaching: true, closing_kmh: 24.7 },
      motion: { speed_kmh: 32, heading_deg: 45 },
    });
    expect(nowcastSentence(n, 'th').details).toEqual([
      'กลุ่มฝนหนักห่าง 18 กม. ทางตะวันตกเฉียงใต้ เคลื่อนเข้ามา 25 กม./ชม.',
      'ฝนเคลื่อนไปทางตะวันออกเฉียงเหนือ ความเร็ว 32 กม./ชม.',
    ]);
    expect(nowcastSentence(n, 'en').details[0]).toBe('Heavy rain cell 18 km SW, moving toward you at 25 km/h');
    const away = nc({
      nearest: { distance_km: 40, bearing_deg: 90, class: 'thunderstorm', max_dbz: 48, approaching: false, closing_kmh: -20 },
    });
    expect(nowcastSentence(away, 'th').details[0]).toBe('กลุ่มพายุฝนฟ้าคะนองห่าง 40 กม. ทางตะวันออก ไม่ได้เคลื่อนเข้าหาคุณ');
  });

  it('reports a clear hour', () => {
    const th = nowcastSentence(nc(), 'th');
    expect(th.headline).toBe('ไม่มีฝนในรัศมี 4 กม. ใน 1 ชม. ข้างหน้า');
    expect(th.details).toEqual(['ไม่พบกลุ่มฝนหนักในรัศมี 100 กม.']);
    expect(th.severity).toBe(0);
    expect(nowcastSentence(nc(), 'en').headline).toBe('No rain within 4 km in the next hour');
  });

  const hours = (n: number) => Array.from({ length: n }, (_, k) => new Date(Date.UTC(2026, 9, 9, 6 + k)).toISOString());
  const model = (pop: number[]) => ({ times: hours(pop.length), pop, km: '2.2 กม.', nowMs: Date.UTC(2026, 9, 9, 6, 10) });

  it('uses the 2.2 km model when the radar sees no rain within 4 km', () => {
    const later = nowcastSentence(nc(), 'th', model([10, 20, 55, 70, 60, 30, 10, 0]));
    expect(later.headline).toBe('โมเดล 2.2 กม.: อาจมีฝนราว 15:00 น. (โอกาส 70%)');
    expect(later.details[0]).toBe('ช่วงที่มีโอกาสฝน ราว 3 ชม.');
    expect(later.severity).toBe(1);
    const dry = nowcastSentence(nc(), 'en', model([5, 10, 20, 10, 0, 0, 0, 0]));
    expect(dry.headline).toBe('No rain within 4 km, and none likely in the next 6 h');
    expect(dry.details).toEqual(['2.2 กม. model: rain chance at most 20%']);
  });

  it('keeps the radar when rain is here or arriving, and says how long it lasts', () => {
    const here = nowcastSentence(
      nc({ now: { class: 'heavy', max_dbz: 42 }, rain_spell: { start_min: 0, end_min: 40, lasts_min: 40, open_ended: false, horizon_min: 120 } }),
      'th',
      model([90, 90]),
    );
    expect(here.headline).toBe('กำลังมีฝนหนักบริเวณนี้');
    expect(here.details[0]).toBe('น่าจะหยุดในอีกราว 40 นาที');
    const coming = nowcastSentence(
      nc({ eta_rain: eta(15, [10, 20], 'moderate'), rain_spell: { start_min: 15, end_min: null, lasts_min: null, open_ended: true, horizon_min: 120 } }),
      'en',
      model([0, 0]),
    );
    expect(coming.headline).toBe('Moderate rain likely in 10–20 min');
    expect(coming.details).toContain('Likely to keep raining for at least 2 h');
  });

  it('explains why the nowcast is unavailable', () => {
    const th = (reason: Nowcast['reason'], age: number | null = null) =>
      nowcastSentence(nc({ available: false, reason, age_min: age }), 'th').headline;
    expect(th('stale', 45)).toContain('เก่า 45 นาที');
    expect(th('no_coverage')).toContain('นอกพื้นที่ตรวจจับ');
    expect(th('disabled')).toContain('ปิดใช้งาน');
    expect(th('no_data')).toContain('รอข้อมูลเรดาร์');
    expect(nowcastSentence(nc({ available: false, reason: 'no_coverage' }), 'en').headline).toContain('outside radar coverage');
    expect(nowcastSentence(nc({ available: false, reason: 'stale', age_min: 50 }), 'en').headline).toContain('50 min old');
  });

  it('still lists cyclones when the radar is unavailable, dropping far ones', () => {
    const n = nc({
      available: false,
      reason: 'disabled',
      cyclones: [
        cyclone({ id: 'far', distance_now_km: 3200, closest: { time: '', hours: 20, distance_km: 2900 } }),
        cyclone({ id: 'near' }),
      ],
    });
    expect(nowcastSentence(n, 'th').cyclones.map((c) => c.id)).toEqual(['near']);
  });
});

describe('radar and model comparison', () => {
  const nowMs = Date.parse('2026-10-09T06:24:00Z');
  const point = { lat: 13.84, lon: 100.56 };
  const times = ['2026-10-09T05:00:00Z', '2026-10-09T06:00:00Z', '2026-10-09T07:00:00Z'];
  const snapshot = (over: Partial<NowcastSnapshot> = {}): NowcastSnapshot => ({
    ...point,
    status: 'ready',
    data: nc({ now: { class: 'moderate', max_dbz: 32 } }),
    receivedAtMs: nowMs,
    ...over,
  });
  const pop = (over: Partial<Parameters<typeof radarRainChance>[0]> = {}) =>
    radarRainChance({ snapshot: snapshot(), ...point, times, step: 1, modelPop: 0, nowMs, ...over });
  const note = pop;

  it('raises the current hour when the radar sees rain at the spot', () => {
    expect(pop()).toEqual({ value: 90, model: 0, basis: 'rain-now', cls: 'moderate' });
    expect(pop({ snapshot: snapshot({ data: nc({ now: { class: 'light', max_dbz: 20 } }) }) })?.value).toBe(80);
    expect(pop({ snapshot: snapshot({ data: nc({ now: { class: 'severe', max_dbz: 58 } }) }) })?.value).toBe(95);
    expect(pop({ modelPop: 97 })?.value).toBe(97); // never lowers a higher model value while it rains
    const n = snapshot();
    const original = JSON.stringify(n);
    pop({ snapshot: n });
    expect(JSON.stringify(n)).toBe(original);
  });

  it('counts ETA zero as rain now and raises for rain arriving within the hour, sooner = higher', () => {
    for (const key of ['eta_rain', 'eta_storm'] as const) {
      expect(pop({ snapshot: snapshot({ data: nc({ [key]: eta(0, [0, 0], 'heavy') }) }) })?.basis).toBe('rain-now');
    }
    const at = (min: number) => pop({ snapshot: snapshot({ data: nc({ eta_rain: eta(min, [min - 5, min + 5], 'moderate') }) }) });
    expect(at(10)).toEqual({ value: 86, model: 0, basis: 'arriving', cls: 'moderate', minutes: 10 });
    expect(at(30)!.value).toBeGreaterThan(at(50)!.value);
    expect(at(55)!.value).toBeGreaterThanOrEqual(40);
    expect(at(75)?.basis).toBe('clear'); // beyond the hour
    // the sooner of rain / storm arrivals wins
    const both = pop({ snapshot: snapshot({ data: nc({ eta_rain: eta(40, [35, 45], 'light'), eta_storm: eta(20, [15, 25], 'thunderstorm') }) }) });
    expect(both).toMatchObject({ basis: 'arriving', cls: 'thunderstorm', minutes: 20 });
  });

  it('lowers the model halfway towards 5% when the radar is clear and nothing moves in', () => {
    const clear = (modelPop: number) => pop({ snapshot: snapshot({ data: nc() }), modelPop });
    expect(clear(60)).toEqual({ value: 33, model: 60, basis: 'clear' });
    expect(clear(4)!.value).toBe(4); // already low: unchanged
    expect(clear(0)!.value).toBe(0);
    // a nearby cell that is not forecast to arrive does not count as rain here
    expect(pop({ snapshot: snapshot({ data: nc({
      nearest: { distance_km: 10, bearing_deg: 90, class: 'heavy', max_dbz: 43, approaching: true, closing_kmh: 25 },
    }) }), modelPop: 20 })?.basis).toBe('clear');
  });

  it('rejects invalid model values', () => {
    for (const modelPop of [NaN, Infinity, -1, 101]) expect(pop({ modelPop })).toBeNull();
  });

  it('excludes unavailable responses and snapshots retained after a failed refresh', () => {
    for (const reason of ['stale', 'disabled', 'no_data', 'no_coverage'] as const) {
      expect(note({ snapshot: snapshot({ data: nc({ available: false, reason }) }) })).toBeNull();
    }
    for (const status of ['loading', 'error', 'hidden'] as const) {
      expect(note({ snapshot: snapshot({ status }) })).toBeNull();
    }
    expect(note({ snapshot: snapshot({ data: null }) })).toBeNull();
  });

  it('ages a cached frame locally even if no request has finished', () => {
    const cached = snapshot();
    expect(radarAgeMinutes(cached, nowMs)).toBe(4);
    expect(isFreshRadar(cached, nowMs + 26 * 60_000)).toBe(true);
    expect(isFreshRadar(cached, nowMs + 26 * 60_000 + 1)).toBe(false);
    expect(note({ snapshot: cached, nowMs: nowMs + 27 * 60_000 })).toBeNull();
    // Reported age can be older than the browser clock suggests; use the older one.
    expect(isFreshRadar(snapshot({ data: nc({ age_min: 29 }) }), nowMs + 2 * 60_000)).toBe(false);
  });

  it('requires valid freshness metadata', () => {
    for (const over of [
      { frame_time: null }, { frame_time: 'invalid' }, { frame_time: '2026-10-09T06:25:00Z' },
      { age_min: null }, { age_min: NaN }, { age_min: -1 }, { age_min: 31 },
      { available: true, reason: 'stale' as const },
    ]) expect(note({ snapshot: snapshot({ data: nc({ now: { class: 'light', max_dbz: 22 }, ...over }) }) })).toBeNull();
    expect(note({ snapshot: snapshot({ receivedAtMs: null }) })).toBeNull();
    expect(note({ snapshot: snapshot({ receivedAtMs: nowMs + 1 }) })).toBeNull();
  });

  it('drops old-point data immediately, including before the new effect runs', () => {
    const old = snapshot();
    expect(note({ lon: point.lon + 1 })).toBeNull();
    expect(note({ lat: point.lat + 1 })).toBeNull();
    expect(nowcastForPoint(old, point.lat + 1, point.lon)).toEqual({
      lat: point.lat + 1, lon: point.lon, status: 'loading', data: null, receivedAtMs: null,
    });
    expect(nowcastForPoint(old, point.lat, point.lon)).toBe(old);
  });

  it('excludes past/future selections and rechecks the current hour as time advances', () => {
    expect(note({ step: 0 })).toBeNull();
    expect(note({ step: 2 })).toBeNull();
    expect(isCurrentForecastStep(times, 1, nowMs)).toBe(true);
    expect(isCurrentForecastStep(times, 1, Date.parse('2026-10-09T06:31:00Z'))).toBe(false);
    expect(isCurrentForecastStep(times, 2, Date.parse('2026-10-09T06:31:00Z'))).toBe(true);
    expect(isCurrentForecastStep(times, 2, Date.parse('2026-10-09T08:00:00Z'))).toBe(false);
    expect(isCurrentForecastStep(times, 0, Date.parse('2026-10-09T04:00:00Z'))).toBe(false);
    expect(isCurrentForecastStep([], 0, nowMs)).toBe(false);
    expect(isCurrentForecastStep(['invalid'], 0, nowMs)).toBe(false);
    // The response itself is still fresh; the selected 06:00 hour has expired.
    expect(note({ nowMs: Date.parse('2026-10-09T06:31:00Z') })).toBeNull();
  });

  it('words the adjustment in both languages with the model value', () => {
    for (const lang of ['th', 'en'] as const) {
      const { t } = translate(lang);
      expect(t('radarPopSource', { km: '2.2' })).toContain('2.2');
      expect(t('radarPopNow', { cls: rainClassPhrase('light', lang), model: 0 })).toContain('0%');
      expect(t('radarPopArriving', { cls: rainClassPhrase('heavy', lang), min: 15, model: 10 })).toContain('15');
      expect(t('radarPopClear', { model: 60 })).toContain('60%');
    }
    expect(rainClassPhrase('light', 'th')).toBe('ฝนเล็กน้อย');
    expect(rainClassPhrase('heavy', 'en')).toBe('heavy rain');
    expect(translate('th').t('nowcastTitle')).toBe('ตอนนี้ (เรดาร์)');
    expect(translate('en').t('modelForecastTitle')).toBe('Model forecast');
  });
});

describe('cyclone sentences', () => {
  it('says when a storm may strengthen', () => {
    const c = cyclone({ peak_category: 'TY' });
    expect(cycloneSentence(c, 'th').text).toContain('(คาดว่าอาจทวีกำลังเป็นพายุไต้ฝุ่น)');
    expect(cycloneSentence(c, 'en').text).toContain('(may strengthen to a typhoon)');
    expect(cycloneSentence(cyclone(), 'th').text).not.toContain('ทวีกำลัง');
  });

  it('describes distance and closest approach', () => {
    expect(cycloneSentence(cyclone(), 'th').text).toBe('พายุโซนร้อน Simon ห่าง 820 กม. เข้าใกล้สุด ~410 กม. ในอีก 36 ชม.');
    expect(cycloneSentence(cyclone(), 'en').text).toBe('Tropical storm Simon is 820 km away; closest approach ~410 km in 36 h');
    expect(cycloneSentence(cyclone({ category: 'TY' }), 'th').text).toContain('พายุไต้ฝุ่น');
    expect(cycloneSentence(cyclone({ category: 'TD' }), 'th').text).toContain('พายุดีเปรสชัน');
    const days = cyclone({ closest: { time: '', hours: 96, distance_km: 500 } });
    expect(cycloneSentence(days, 'th').text).toContain('ในอีก 4 วัน');
  });

  it('flags a point inside a forecast wind zone', () => {
    const c = cyclone({ in_wind_zone_kmh: 90 });
    expect(cycloneSentence(c, 'th').severity).toBe(2);
    expect(cycloneSentence(c, 'th').text).toContain('อยู่ในเขตลมแรงตั้งแต่ 90 กม./ชม.');
    expect(cycloneSentence(cyclone({ in_wind_zone_kmh: 120 }), 'en').severity).toBe(3);
    expect(cycloneSentence(c, 'en').text).toContain('inside its forecast 90+ km/h wind swath');
  });

  it('notes a storm that will not get closer', () => {
    const c = cyclone({ distance_now_km: 700, closest: { time: '', hours: 0, distance_km: 700 } });
    expect(cycloneSentence(c, 'th').text).toBe('พายุโซนร้อน Simon ห่าง 700 กม. ไม่เข้าใกล้ไปกว่านี้');
    expect(cycloneSentence(c, 'en').text).toBe('Tropical storm Simon is 700 km away and will not get any closer');
    expect(cycloneSentence(c, 'th').severity).toBe(0);
    const near = cyclone({ distance_now_km: 250, closest: { time: '', hours: 0, distance_km: 250 } });
    expect(cycloneSentence(near, 'th').severity).toBe(2);
  });
});

describe('radar colours', () => {
  it('keeps no-echo and drizzle transparent and strong echo opaque', () => {
    const lut = buildRadarLut();
    expect(lut).toHaveLength(1024);
    expect(lut[3]).toBe(0); // code 0 = no echo
    const code = (dbz: number) => Math.round(((dbz + 10) / 85) * 255);
    expect(lut[code(5) * 4 + 3]).toBe(0);
    expect(lut[code(45) * 4 + 3]).toBeGreaterThan(240);
    expect(lut[code(60) * 4 + 3]).toBe(255);
  });
});
