/**
 * Pure helpers for radar playback (observed frames of the last ~hour, GET /api/v1/nowcast/frames).
 * Frame ids are the frame's unix time and never change, so the selection is kept by id across polls.
 */

export interface RadarFrameInfo {
  id: string;
  /** ISO time of the observed frame */
  time: string;
}

export interface RadarFrameList {
  frames: RadarFrameInfo[];
  latest: string | null;
  stale: boolean;
  age_min: number | null;
  reason?: 'disabled' | 'no_data';
}

/** The server list, sorted oldest → newest with duplicate ids dropped (defensive: it should already be). */
export function normaliseFrames(frames: RadarFrameInfo[]): RadarFrameInfo[] {
  const seen = new Set<string>();
  return [...frames]
    .sort((a, b) => Number(a.id) - Number(b.id))
    .filter((f) => (seen.has(f.id) ? false : (seen.add(f.id), true)));
}

/**
 * Which frame to show after the list changed.
 * - following the latest (or nothing chosen yet) → the new latest
 * - a past frame that is still listed → stays put (a poll never moves the user's choice)
 * - a past frame that aged out → the closest frame in time
 */
export function selectAfterUpdate(frames: RadarFrameInfo[], prevId: string | null, followLatest: boolean): string | null {
  if (frames.length === 0) return null;
  const last = frames[frames.length - 1].id;
  if (followLatest || prevId === null) return last;
  if (frames.some((f) => f.id === prevId)) return prevId;
  const t = Number(prevId);
  return frames.reduce((best, f) => (Math.abs(Number(f.id) - t) < Math.abs(Number(best.id) - t) ? f : best)).id;
}

/** Next frame id for playback (wraps from the latest back to the oldest). */
export function nextFrameId(frames: RadarFrameInfo[], id: string | null): string | null {
  if (frames.length === 0) return null;
  const i = frames.findIndex((f) => f.id === id);
  return frames[(i + 1) % frames.length].id;
}
