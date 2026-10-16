import type { AirForecast } from './api';

/** The PCD's PM2.5 bands (µg/m³, 24 h): the same colours as the station dots and the legend. */
export const PM_BANDS: [max: number, rgb: [number, number, number]][] = [
  [15, [0x3b, 0xcc, 0xff]],
  [25, [0x92, 0xd0, 0x50]],
  [37.5, [0xff, 0xff, 0x00]],
  [75, [0xff, 0xa2, 0x00]],
  [Infinity, [0xf0, 0x46, 0x46]],
];

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

/** One RGBA pixel per grid cell, north row first (rows arrive from the south). */
export function frameImage(f: AirForecast, frame: Uint8Array, alpha = 170): ImageData {
  const img = new ImageData(f.nx, f.ny);
  for (let y = 0; y < f.ny; y++) {
    const src = (f.ny - 1 - y) * f.nx;
    for (let x = 0; x < f.nx; x++) {
      const [r, g, b] = pmColor(frame[src + x]);
      const o = (y * f.nx + x) * 4;
      img.data[o] = r;
      img.data[o + 1] = g;
      img.data[o + 2] = b;
      img.data[o + 3] = alpha;
    }
  }
  return img;
}

/** Corners of the field for an image source (cell edges, not centres). */
export function fieldCoordinates(f: AirForecast): [[number, number], [number, number], [number, number], [number, number]] {
  const west = f.lon0 - f.dlon / 2;
  const east = f.lon0 + (f.nx - 1) * f.dlon + f.dlon / 2;
  const south = f.lat0 - f.dlat / 2;
  const north = f.lat0 + (f.ny - 1) * f.dlat + f.dlat / 2;
  return [
    [west, north],
    [east, north],
    [east, south],
    [west, south],
  ];
}
