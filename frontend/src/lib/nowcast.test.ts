import { describe, expect, it } from 'vitest';
import { buildRadarLut } from './color';
import { cycloneSentence, nowcastSentence } from './nowcastText';
import type { Nowcast, NowcastCyclone, NowcastEta } from './api';

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
    expect(th.headline).toBe('ไม่มีฝนเข้าพื้นที่ใน 1 ชม. ข้างหน้า');
    expect(th.details).toEqual(['ไม่พบกลุ่มฝนหนักในรัศมี 100 กม.']);
    expect(th.severity).toBe(0);
    expect(nowcastSentence(nc(), 'en').headline).toBe('No rain expected here in the next hour');
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
