import { describe, expect, it } from 'vitest';
import { cropRect, DEFAULT_LOOK, unionRect } from './mapGlass';

describe('unionRect', () => {
  it('holds every rect and grows by the pad', () => {
    const r = unionRect(
      [
        { x: 338, y: 112, w: 40, h: 40 },
        { x: 338, y: 160, w: 40, h: 40 },
        { x: 300, y: 304, w: 78, h: 40 },
      ],
      4,
    );
    expect(r).toEqual({ x: 296, y: 108, w: 86, h: 240 });
  });
});

describe('cropRect', () => {
  it('rounds out to whole device pixels', () => {
    // 3 px per CSS px: 10.2 -> 30.6 floors to 30, 50.1 -> 150.3 ceils to 151
    expect(cropRect({ x: 10.2, y: 20, w: 39.9, h: 10 }, 3, 1170, 2532)).toEqual({ sx: 30, sy: 60, sw: 121, sh: 30 });
  });

  it('clamps to the canvas', () => {
    expect(cropRect({ x: -5, y: 790, w: 20, h: 40 }, 2, 780, 1600)).toEqual({ sx: 0, sy: 1580, sw: 30, sh: 20 });
  });

  it('is null when nothing of the box is on the canvas', () => {
    expect(cropRect({ x: 500, y: 0, w: 20, h: 20 }, 1, 390, 844)).toBeNull();
  });
});

describe('look', () => {
  it('defaults to the documented bend and dispersion', () => {
    expect(DEFAULT_LOOK.bend).toBe(0.75);
    expect(DEFAULT_LOOK.dispersion).toBe(1.05);
  });
});
