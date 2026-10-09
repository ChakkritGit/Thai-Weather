import { describe, expect, it } from 'vitest';
import { buildLut, categorise, decode, scaleColor, scales } from './color';
import { gridBounds, gridLines, rasterFor, sampleGrid } from './render';
import { forecastSentence } from './forecastText';
import { fmtKm, thaiDate } from './format';
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

describe('grid lines', () => {
  const fineB = gridBounds(grid);
  const coarse: GridDesc = { lat0: 5.5, lat1: 20.5, lon0: 97.3, lon1: 105.8, dlat: 0.25, dlon: 0.25, ny: 61, nx: 35, resolution_km: 27.8 };

  it('derives bounds from nx/ny, not lon1/lat1', () => {
    expect(fineB.west).toBeCloseTo(97.29);
    expect(fineB.east).toBeCloseTo(105.71);
    expect(fineB.south).toBeCloseTo(5.49);
    expect(fineB.north).toBeCloseTo(20.51);
    // a stale (nominal) lon1 must not move the east edge
    const stale = gridBounds({ ...coarse, lon1: 105.7 });
    expect(stale.east).toBeCloseTo(105.925);
    expect(stale.east).toBeCloseTo(gridBounds(coarse).east);
  });

  it('keeps horizontal and vertical coarse lines inside the image and meeting', () => {
    const lines = gridLines(coarse, fineB);
    const horizontal = lines.filter((l) => l[0][1] === l[1][1]);
    const vertical = lines.filter((l) => l[0][0] === l[1][0]);
    expect(horizontal.length + vertical.length).toBe(lines.length);
    for (const l of horizontal) {
      expect(l[0][0]).toBeCloseTo(fineB.west);
      expect(l[1][0]).toBeCloseTo(fineB.east);
    }
    for (const l of vertical) {
      expect(l[0][1]).toBeCloseTo(fineB.south);
      expect(l[1][1]).toBeCloseTo(fineB.north);
    }
    for (const [x, y] of lines.flat()) {
      expect(x).toBeGreaterThanOrEqual(fineB.west - 1e-9);
      expect(x).toBeLessThanOrEqual(fineB.east + 1e-9);
      expect(y).toBeGreaterThanOrEqual(fineB.south - 1e-9);
      expect(y).toBeLessThanOrEqual(fineB.north + 1e-9);
    }
    // corners meet: the outermost vertical lines sit on the horizontal lines' ends and vice versa
    const xs = vertical.map((l) => l[0][0]);
    const ys = horizontal.map((l) => l[0][1]);
    expect(Math.min(...xs)).toBeCloseTo(Math.min(...horizontal.map((l) => l[0][0])));
    expect(Math.max(...xs)).toBeCloseTo(Math.max(...horizontal.map((l) => l[1][0])));
    expect(Math.min(...ys)).toBeCloseTo(Math.min(...vertical.map((l) => l[0][1])));
    expect(Math.max(...ys)).toBeCloseTo(Math.max(...vertical.map((l) => l[1][1])));
  });

  it('draws 422 + 752 lines for the fine grid', () => {
    const lines = gridLines(grid, fineB);
    expect(lines.filter((l) => l[0][0] === l[1][0])).toHaveLength(422);
    expect(lines.filter((l) => l[0][1] === l[1][1])).toHaveLength(752);
  });
});

describe('resolution label', () => {
  it('shows one decimal only when needed', () => {
    expect(fmtKm(27.8, 'th')).toBe('27.8');
    expect(fmtKm(2.2, 'en')).toBe('2.2');
    expect(fmtKm(22, 'en')).toBe('22');
    expect(fmtKm(2.0000001, 'th')).toBe('2');
  });
});
