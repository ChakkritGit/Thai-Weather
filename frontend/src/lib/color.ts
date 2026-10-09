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
