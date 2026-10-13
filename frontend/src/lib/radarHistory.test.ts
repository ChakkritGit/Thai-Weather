import { describe, expect, it } from 'vitest';
import { nextFrameId, normaliseFrames, selectAfterUpdate, type RadarFrameInfo } from './radarHistory';

const f = (min: number): RadarFrameInfo => {
  const t = Date.UTC(2026, 9, 14, 6, 0) / 1000 + min * 60;
  return { id: String(t), time: new Date(t * 1000).toISOString() };
};
const hour = [0, 10, 20, 30, 40, 50, 60].map(f);

describe('radar playback list', () => {
  it('sorts and drops duplicate frames', () => {
    expect(normaliseFrames([hour[2], hour[0], hour[2], hour[1]]).map((x) => x.id)).toEqual([hour[0], hour[1], hour[2]].map((x) => x.id));
  });

  it('follows the latest frame when the user is on it', () => {
    const next = [...hour.slice(1), f(70)];
    expect(selectAfterUpdate(next, hour[6].id, true)).toBe(f(70).id);
    expect(selectAfterUpdate(hour, null, false)).toBe(hour[6].id);
  });

  it('keeps a chosen past frame when a new frame arrives', () => {
    const next = [...hour.slice(1), f(70)];
    expect(selectAfterUpdate(next, hour[3].id, false)).toBe(hour[3].id);
  });

  it('moves to the closest frame when the chosen one aged out', () => {
    const next = [...hour.slice(2), f(70), f(80)];
    expect(selectAfterUpdate(next, hour[0].id, false)).toBe(hour[2].id);
    expect(selectAfterUpdate([], hour[0].id, false)).toBeNull();
  });

  it('plays forward and wraps to the oldest', () => {
    expect(nextFrameId(hour, hour[2].id)).toBe(hour[3].id);
    expect(nextFrameId(hour, hour[6].id)).toBe(hour[0].id);
    expect(nextFrameId([], null)).toBeNull();
  });
});
