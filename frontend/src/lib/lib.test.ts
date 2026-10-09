import { describe, expect, it } from 'vitest';
import { buildLut, categorise, categories, decode, scaleColor, scales } from './color';
import {
  alertTitle,
  alertValueText,
  coverageNote,
  hazardLevelText,
  isPartialDay,
  maxSeverity,
  sourceLabel,
  tierCounts,
  tierInfo,
} from './alertText';
import { gridBounds, rasterFor, sampleGrid } from './render';
import { forecastSentence } from './forecastText';
import { thaiDate } from './format';
import type { DaySummary, GridDesc, LayerMeta } from './api';

const grid: GridDesc = { lat0: 5.5, lat1: 20.5, lon0: 97.3, lon1: 105.7, dlat: 0.02, dlon: 0.02, ny: 751, nx: 421, resolution_km: 2.2 };

describe('colour scales', () => {
  it('decodes the backend 8-bit encodings', () => {
    expect(decode({ kind: 'linear', min: 0, max: 51 }, 255)).toBeCloseTo(51);
    expect(decode({ kind: 'sqrt', min: 0, max: 150 }, 255)).toBeCloseTo(150);
    expect(decode({ kind: 'sqrt', min: 0, max: 150 }, 0)).toBe(0);
  });

  it('keeps very light rain transparent', () => {
    expect(scaleColor(scales.rainRate, 0.05)[3]).toBe(0);
    expect(scaleColor(scales.rainRate, 20)[3]).toBe(255);
  });

  it('builds a 256-entry RGBA LUT', () => {
    const layer: LayerMeta = { id: 'temp', unit: '°C', encoding: { kind: 'linear', min: 0, max: 51 }, name_th: '', name_en: '', scale: 'temperature', daily: false };
    expect(buildLut(layer)).toHaveLength(1024);
  });

  it('uses the same TMD / DoH thresholds as the backend', () => {
    expect(categorise('rainDaily', 35.1)?.id).toBe('heavy');
    expect(categorise('heatIndex', 41)?.id).toBe('danger');
    expect(categorise('tempMin', 7)?.id).toBe('veryCold');
  });
});

describe('mercator raster', () => {
  it('maps canvas rows back to true latitude', () => {
    const r = rasterFor(gridBounds(grid), 421);
    expect(r.lats[0]).toBeGreaterThan(20.4);
    expect(r.lats[r.height - 1]).toBeLessThan(5.6);
    // Mercator stretches the north: the middle row is north of the mid-latitude
    expect(r.lats[Math.floor(r.height / 2)]).toBeGreaterThan(13.0);
  });

  it('samples the nearest grid cell', () => {
    const codes = new Uint8Array(grid.nx * grid.ny);
    codes[(375 * grid.nx) + 160] = 42;
    expect(sampleGrid(codes, grid, 5.5 + 375 * 0.02, 97.3 + 160 * 0.02)).toBe(42);
    expect(sampleGrid(codes, grid, 30, 100)).toBeNull();
  });
});

describe('text', () => {
  it('writes a TMD-style Thai forecast sentence', () => {
    const d: DaySummary = {
      date: '2026-10-10', hours: 24, tmax: 33.2, tmin: 24.6, tmax_high: 34, tmin_low: 23, heat_max: 42,
      rain_mean: 8, rain_p95: 40, rain_coverage: 42, storm_max: 60, wind_max: 4,
      rain_coverage_level: 'fairlyWidespread', rain_level: 'heavy', alerts: [],
    };
    const s = forecastSentence(d, 'th');
    expect(s).toContain('มีฝนฟ้าคะนองร้อยละ 40 ของพื้นที่');
    expect(s).toContain('ฝนหนัก');
    expect(s).toContain('อันตราย');
  });

  it('converts UTC to the Thai calendar date', () => {
    expect(thaiDate('2026-10-09T18:00:00Z')).toBe('2026-10-10');
  });
});

const fullDay: DaySummary = {
  date: '2026-10-10', hours: 24, tmax: 33.2, tmin: 24.6, tmax_high: 34, tmin_low: 23, heat_max: 37,
  rain_mean: 2, rain_p95: 5, rain_coverage: 20, storm_max: 30, wind_max: 4,
  rain_coverage_level: 'scattered', rain_level: 'light', alerts: [],
};

describe('alert vocabulary', () => {
  it('uses colour tiers that never reuse a hazard-level name', () => {
    expect(tierInfo(1, 'th').label).toBe('เหลือง · ควรติดตาม');
    expect(tierInfo(2, 'th').label).toBe('ส้ม · เตรียมพร้อม');
    expect(tierInfo(3, 'th').label).toBe('แดง · อันตราย');
    expect(tierInfo(1, 'en').label).toBe('Yellow · Be aware');
    expect(tierInfo(2, 'en').name).toBe('Orange');
    expect(tierInfo(3, 'en').label).toBe('Red · Take action');
    const hazardWords = new Set(Object.values(categories).flatMap((c) => c.levels.map((l) => l.label_th)));
    for (const s of [1, 2, 3]) expect(hazardWords.has(tierInfo(s, 'th').label)).toBe(false);
  });

  it('keeps the heat-index levels informational until DoH "danger"', () => {
    expect(categorise('heatIndex', 38)).toMatchObject({ id: 'extremeCaution', label_th: 'เตือนภัย', severity: 0 });
    expect(categorise('heatIndex', 41)?.severity).toBe(2);
    expect(categorise('heatIndex', 54)?.severity).toBe(3);
    expect(categorise('rainDaily', 60)?.severity).toBe(0);
    expect(categorise('rainDaily', 95)?.severity).toBe(1);
  });

  it('counts each province once at its highest tier', () => {
    const a = (severity: number) => ({ severity });
    expect(tierCounts([[a(1)], [a(1), a(3)], [], [a(2)], [a(2), a(1)]])).toEqual([1, 2, 1]);
    expect(maxSeverity([])).toBe(0);
  });

  it('formats hazard levels with their hazard name', () => {
    const alert = { hazard: 'heat' as const, level: 'danger', severity: 2 as const, value: 42.6, label_th: 'อันตราย', label_en: 'Danger' };
    expect(hazardLevelText(alert, 'th')).toBe('ดัชนีความร้อน: อันตราย');
    expect(alertValueText(alert, 'en')).toBe('43°');
    expect(alertTitle(alert, 'th')).toContain('ส้ม · เตรียมพร้อม');
    expect(alertTitle(alert, 'th')).toContain('กรมอนามัย');
  });
});

describe('partial days', () => {
  it('flags days with fewer than 18 hours (or the backend flag)', () => {
    expect(isPartialDay({ hours: 12 })).toBe(true);
    expect(isPartialDay({ hours: 17 })).toBe(true);
    expect(isPartialDay({ hours: 18 })).toBe(false);
    expect(isPartialDay({ hours: 24 })).toBe(false);
    expect(isPartialDay({ hours: 24, partial: true })).toBe(true);
  });

  it('says how far the data goes', () => {
    expect(coverageNote({ hours: 12, until: '23:00' }, 'th')).toBe('ข้อมูลถึง 23:00 น.');
    expect(coverageNote({ hours: 12, until: '23:00' }, 'en')).toBe('Data until 23:00');
    expect(coverageNote({ hours: 12 }, 'th')).toBe('มีข้อมูล 12 ชั่วโมง');
    expect(coverageNote({ hours: 24 }, 'th')).toBeNull();
  });

  it('never presents partial extremes as the full-day max/min', () => {
    const s = forecastSentence({ ...fullDay, hours: 12, until: '23:00' }, 'th');
    expect(s).toContain('ข้อมูลถึง 23:00 น.');
    expect(s).toContain('สูงสุดเท่าที่มีข้อมูล 33 องศาเซลเซียส');
    expect(s).not.toMatch(/สูงสุด 33–34/);
    expect(forecastSentence({ ...fullDay, hours: 12 }, 'en')).toContain('highest so far 33');
  });

  it('keeps the ± range for complete days', () => {
    expect(forecastSentence(fullDay, 'th')).toContain('ต่ำสุด 24–25 องศาเซลเซียส สูงสุด 33–34 องศาเซลเซียส');
    expect(forecastSentence(fullDay, 'en')).toContain('Low 24–25 °C, high 33–34 °C.');
  });

  it('introduces the heat-index level with its source', () => {
    expect(forecastSentence(fullDay, 'th')).toContain('(เกณฑ์กรมอนามัย: ระดับเตือนภัย)');
    expect(forecastSentence(fullDay, 'en')).toContain('Dept. of Health level: extreme caution');
  });
});

describe('source wording', () => {
  it('names the forecast source for non-experts', () => {
    const run = { source: 'open-meteo', model: 'gfs_seamless', demo: false };
    expect(sourceLabel(run, 'th')).toBe('GFS (NOAA) ผ่าน Open-Meteo');
    expect(sourceLabel(run, 'en')).toBe('GFS (NOAA) via Open-Meteo');
    expect(sourceLabel({ source: 'synthetic', model: 'TH-DEMO', demo: true }, 'th')).toBe('ข้อมูลจำลองเพื่อสาธิต');
  });
});
