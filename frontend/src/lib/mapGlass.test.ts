import { describe, expect, it } from 'vitest';
import { clusterRects, cropRect, DEFAULT_LOOK, intersectRect, unionRect } from './mapGlass';

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

describe('intersectRect', () => {
  it('is the shared part', () => {
    expect(intersectRect({ x: 0, y: 0, w: 100, h: 50 }, { x: 60, y: 10, w: 100, h: 100 })).toEqual({ x: 60, y: 10, w: 40, h: 40 });
  });

  it('is null for rects that only touch or miss', () => {
    expect(intersectRect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 })).toBeNull();
    expect(intersectRect({ x: 0, y: 0, w: 10, h: 10 }, { x: 30, y: 30, w: 5, h: 5 })).toBeNull();
  });
});

describe('clusterRects', () => {
  it('joins rects that overlap, also through a third one', () => {
    const rects = [
      { x: 0, y: 0, w: 50, h: 20 },
      { x: 40, y: 0, w: 50, h: 20 },
      { x: 80, y: 0, w: 50, h: 20 },
      { x: 0, y: 400, w: 30, h: 30 },
    ];
    expect(clusterRects(rects)).toEqual([[0, 1, 2], [3]]);
  });

  it('keeps every rect in exactly one group', () => {
    const rects = Array.from({ length: 12 }, (_, i) => ({ x: (i % 4) * 30, y: Math.floor(i / 4) * 200, w: 40, h: 40 }));
    const groups = clusterRects(rects);
    expect(groups.flat().sort((a, b) => a - b)).toEqual(rects.map((_, i) => i));
  });
});

describe('look', () => {
  it('defaults to the documented bend and dispersion', () => {
    expect(DEFAULT_LOOK.bend).toBe(1);
    expect(DEFAULT_LOOK.dispersion).toBe(1.5);
  });
});
