import { weatherScales } from '../design/generated/tokens';
import type { Encoding, LayerMeta } from './api';

export interface Stop {
  value: number;
  color: string;
  alpha?: number;
}
export interface Scale {
  unit: string;
  mode: 'continuous' | 'stepped';
  stops: readonly Stop[];
}
export interface CategoryLevel {
  id: string;
  min?: number;
  max?: number;
  severity: number;
  label_th: string;
  label_en: string;
  color?: string;
}

export const scales = weatherScales.scales as unknown as Record<string, Scale>;
export const categories = weatherScales.categories as unknown as Record<
  string,
  { unit: string; source: string; levels: CategoryLevel[] }
>;

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/./g, (c) => c + c) : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function decode(enc: Encoding, code: number): number {
  const x = code / 255;
  return enc.kind === 'sqrt' ? x * x * enc.max : enc.min + x * (enc.max - enc.min);
}

/** RGBA (0–255) for a value on a scale. */
export function scaleColor(scale: Scale, value: number): [number, number, number, number] {
  const s = scale.stops;
  if (scale.mode === 'stepped') {
    let pick = s[0];
    for (const stop of s) if (value >= stop.value) pick = stop;
    return [...hexToRgb(pick.color), Math.round((pick.alpha ?? 1) * 255)];
  }
  if (value <= s[0].value) return [...hexToRgb(s[0].color), Math.round((s[0].alpha ?? 1) * 255)];
  for (let i = 1; i < s.length; i++) {
    if (value <= s[i].value) {
      const a = s[i - 1];
      const b = s[i];
      const t = (value - a.value) / (b.value - a.value);
      const ca = hexToRgb(a.color);
      const cb = hexToRgb(b.color);
      const alpha = (a.alpha ?? 1) + ((b.alpha ?? 1) - (a.alpha ?? 1)) * t;
      return [
        Math.round(ca[0] + (cb[0] - ca[0]) * t),
        Math.round(ca[1] + (cb[1] - ca[1]) * t),
        Math.round(ca[2] + (cb[2] - ca[2]) * t),
        Math.round(alpha * 255),
      ];
    }
  }
  const last = s[s.length - 1];
  return [...hexToRgb(last.color), Math.round((last.alpha ?? 1) * 255)];
}

/** 256-entry RGBA lookup table mapping 8-bit layer codes straight to colours. */
export function buildLut(layer: LayerMeta): Uint8ClampedArray {
  const scale = scales[layer.scale];
  const lut = new Uint8ClampedArray(256 * 4);
  for (let c = 0; c < 256; c++) {
    const rgba = scale ? scaleColor(scale, decode(layer.encoding, c)) : [0, 0, 0, 0];
    lut.set(rgba, c * 4);
  }
  return lut;
}

export function cssGradient(scale: Scale, min: number, max: number): string {
  const parts = scale.stops
    .filter((s) => s.value >= min && s.value <= max)
    .map((s) => {
      const [r, g, b] = hexToRgb(s.color);
      const pct = ((s.value - min) / (max - min)) * 100;
      return `rgba(${r},${g},${b},${Math.max(s.alpha ?? 1, 0.15)}) ${pct.toFixed(1)}%`;
    });
  return `linear-gradient(90deg, ${parts.join(', ')})`;
}

export function categorise(category: string, value: number): CategoryLevel | null {
  let best: CategoryLevel | null = null;
  for (const lvl of categories[category]?.levels ?? []) {
    if ((lvl.min ?? -Infinity) <= value && value <= (lvl.max ?? Infinity)) best = lvl;
  }
  return best;
}

/** Radar layer from `/api/v1/nowcast/layer`: uint8 code 0..255 ↔ −10..75 dBZ (0 = no echo). */
export const RADAR_ENCODING: Encoding = { kind: 'linear', min: -10, max: 75 };

/** Reflectivity colours (dBZ): pale blue drizzle → green → yellow → orange → red → magenta for hail-sized cores. */
export const radarScale: Scale = {
  unit: 'dBZ',
  mode: 'continuous',
  stops: [
    { value: 12, color: '#7dd3fc', alpha: 0 },
    { value: 20, color: '#7dd3fc', alpha: 0.6 },
    { value: 25, color: '#38bdf8', alpha: 0.75 },
    { value: 30, color: '#22c55e', alpha: 0.85 },
    { value: 35, color: '#a3e635', alpha: 0.9 },
    { value: 40, color: '#facc15', alpha: 0.95 },
    { value: 45, color: '#f97316', alpha: 1 },
    { value: 50, color: '#dc2626', alpha: 1 },
    { value: 55, color: '#be185d', alpha: 1 },
    { value: 60, color: '#a21caf', alpha: 1 },
    { value: 70, color: '#f5d0fe', alpha: 1 },
  ],
};

/** 256-entry RGBA lookup table for radar codes. */
export function buildRadarLut(): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 4);
  for (let c = 0; c < 256; c++) lut.set(scaleColor(radarScale, decode(RADAR_ENCODING, c)), c * 4);
  return lut;
}
