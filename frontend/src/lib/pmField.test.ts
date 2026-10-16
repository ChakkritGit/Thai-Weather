import { describe, expect, it } from 'vitest';
import type { AirForecast } from './api';
import { decodeFrame, fieldCoordinates, frameIndex, pmColor } from './pmField';

const f: AirForecast = {
  updated: null, lat0: 5.4, lon0: 97, dlat: 0.2, dlon: 0.2, nx: 2, ny: 2, units: 'µg/m³',
  times: ['2026-10-16T16:00:00+00:00', '2026-10-16T17:00:00+00:00'], frames: [], attribution: { name: 'FMI SILAM', url: '' },
};

describe('PM2.5 field', () => {
  it('uses the PCD bands', () => {
    expect(pmColor(10)).toEqual([0x3b, 0xcc, 0xff]);
    expect(pmColor(37.5)).toEqual([0xff, 0xff, 0x00]);
    expect(pmColor(76)).toEqual([0xf0, 0x46, 0x46]);
  });
  it('decodes base64 bytes', () => {
    expect([...decodeFrame(btoa(String.fromCharCode(1, 200, 255)))]).toEqual([1, 200, 255]);
  });
  it('picks the nearest hour, and none outside the forecast', () => {
    expect(frameIndex(f, '2026-10-16T17:20:00Z')).toBe(1);
    expect(frameIndex(f, '2026-10-16T19:00:00Z')).toBe(-1);
  });
  it('places cell edges, not centres', () => {
    expect(fieldCoordinates(f)[0]).toEqual([96.9, 5.4 + 0.2 + 0.1]);
  });
});
