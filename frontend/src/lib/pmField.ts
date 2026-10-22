import { api, type AirForecast, type GridDesc } from './api';

/** The PCD's PM2.5 bands (µg/m³, 24 h): the same colours as the station dots and the legend. */
export const PM_BANDS: [max: number, rgb: [number, number, number]][] = [
  [15, [0x3b, 0xcc, 0xff]],
  [25, [0x92, 0xd0, 0x50]],
  [37.5, [0xff, 0xff, 0x00]],
  [75, [0xff, 0xa2, 0x00]],
  [Infinity, [0xf0, 0x46, 0x46]],
];

/** Thailand's PM2.5 categories (Pollution Control Department, 24 h µg/m³), in PM_BANDS order. */
const PM_LABELS: [th: string, en: string][] = [
  ['ดีมาก', 'Very good'],
  ['ดี', 'Good'],
  ['ปานกลาง', 'Moderate'],
  ['เริ่มมีผลกระทบต่อสุขภาพ', 'Starting to affect health'],
  ['มีผลกระทบต่อสุขภาพ', 'Affects health'],
];

export function pmLabel(ug: number, th: boolean): string {
  const l = PM_LABELS[PM_BANDS.findIndex(([max]) => ug <= max)];
  return th ? l[0] : l[1];
}

export function pmColor(ug: number): [number, number, number] {
  return PM_BANDS.find(([max]) => ug <= max)![1];
}

export function decodeFrame(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The frame nearest to `iso`, within 90 minutes (the forecast is hourly); -1 outside its 72 hours. */
export function frameIndex(f: AirForecast, iso: string): number {
  const t = Date.parse(iso);
  let best = -1;
  let gap = 90 * 60_000;
  f.times.forEach((s, i) => {
    const d = Math.abs(Date.parse(s) - t);
    if (d <= gap) {
      gap = d;
      best = i;
    }
  });
  return best;
}

/**
 * The field bilinearly interpolated onto another grid (the map's 2.2 km grid), so it is drawn smooth
 * and clipped to the land like the weather layers. 255 = outside the field.
 */
export function resample(f: AirForecast, frame: Uint8Array, g: GridDesc): Uint8Array {
  const out = new Uint8Array(g.nx * g.ny).fill(255);
  for (let iy = 0; iy < g.ny; iy++) {
    const fy = (g.lat0 + iy * g.dlat - f.lat0) / f.dlat;
    if (fy < 0 || fy > f.ny - 1) continue;
    const y0 = Math.min(Math.floor(fy), f.ny - 2);
    const ty = fy - y0;
    for (let ix = 0; ix < g.nx; ix++) {
      const fx = (g.lon0 + ix * g.dlon - f.lon0) / f.dlon;
      if (fx < 0 || fx > f.nx - 1) continue;
      const x0 = Math.min(Math.floor(fx), f.nx - 2);
      const tx = fx - x0;
      const a = frame[y0 * f.nx + x0];
      const b = frame[y0 * f.nx + x0 + 1];
      const c = frame[(y0 + 1) * f.nx + x0];
      const d = frame[(y0 + 1) * f.nx + x0 + 1];
      const v = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
      out[iy * g.nx + ix] = Math.min(254, Math.round(v));
    }
  }
  return out;
}

/** Colour table for renderGrid: code = µg/m³ (0-254), 255 = no data (transparent). */
export function pmLut(alpha = 205): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 4);
  for (let v = 0; v < 255; v++) {
    const [r, g, b] = pmColor(v);
    lut.set([r, g, b, alpha], v * 4);
  }
  return lut;
}

/** The field's value at a point (bilinear, µg/m³), null outside it. */
export function samplePm(f: AirForecast, frame: Uint8Array, lat: number, lon: number): number | null {
  const fy = (lat - f.lat0) / f.dlat;
  const fx = (lon - f.lon0) / f.dlon;
  if (fy < 0 || fx < 0 || fy > f.ny - 1 || fx > f.nx - 1) return null;
  const y0 = Math.min(Math.floor(fy), f.ny - 2);
  const x0 = Math.min(Math.floor(fx), f.nx - 2);
  const ty = fy - y0;
  const tx = fx - x0;
  const at = (y: number, x: number) => frame[y * f.nx + x];
  return (at(y0, x0) * (1 - tx) + at(y0, x0 + 1) * tx) * (1 - ty) + (at(y0 + 1, x0) * (1 - tx) + at(y0 + 1, x0 + 1) * tx) * ty;
}

let cached: { at: number; p: Promise<AirForecast> } | null = null;
/** The forecast field, shared by the map's PM2.5 view and the point panel (refetched after 30 min). */
export function loadAirForecast(): Promise<AirForecast> {
  if (!cached || Date.now() - cached.at > 30 * 60_000) {
    const p = api.airForecast();
    cached = { at: Date.now(), p };
    p.catch(() => { if (cached?.p === p) cached = null; });
  }
  return cached.p;
}

/** The forecast PM2.5 at a point and hour, null outside the field or its 72 hours. */
export function pmAt(f: AirForecast, iso: string, lat: number, lon: number): number | null {
  const i = frameIndex(f, iso);
  return i < 0 ? null : samplePm(f, decodeFrame(f.frames[i]), lat, lon);
}
