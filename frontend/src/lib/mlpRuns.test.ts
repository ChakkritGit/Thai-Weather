import { describe, expect, it } from 'vitest';
import { mlpState, needed, niceTicks, runsOf, seriesOf, tickDigits, type MlpRun, type MlpStatus } from './mlpRuns';

const run = (over: Partial<MlpRun>): MlpRun => ({
  fitted_at: '2026-11-06T02:46+00:00',
  active: false,
  reason: null,
  pairs: null,
  days: null,
  events: null,
  metrics: null,
  ...over,
});

describe('mlpState', () => {
  it('maps a run to in use, on standby or waiting', () => {
    expect(mlpState(run({ active: true }))).toBe('on');
    expect(mlpState(run({ reason: 'waiting for data' }))).toBe('wait');
    expect(mlpState(run({ reason: 'does not beat the hourly bias yet' }))).toBe('off');
    expect(mlpState(null)).toBe('wait');
  });
});

describe('runsOf', () => {
  it('sorts history oldest first', () => {
    const h = { history: [run({ fitted_at: '2026-11-12T00:00+00:00' }), run({ fitted_at: '2026-11-06T00:00+00:00' })], curve: null };
    expect(runsOf(h, null).map((r) => r.fitted_at.slice(0, 10))).toEqual(['2026-11-06', '2026-11-12']);
  });
  it('falls back to the latest status for a report without history', () => {
    const s: MlpStatus = { fitted_at: 'x', active: false, reason: 'waiting for data', pairs: 5, days: 3, required_days: 90, test_days: 14, metrics: null };
    const rows = runsOf(undefined, s);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pairs: 5, days: 3, events: null });
    expect(runsOf(undefined, null)).toEqual([]);
  });
});

describe('seriesOf', () => {
  it('keeps only runs with metrics and aligns the values', () => {
    const rows = [run({}), run({ fitted_at: '2026-11-11T03:44+00:00', metrics: { brier_raw: 0.1, brier_mlp: 0.2 } })];
    const s = seriesOf(rows, ['brier_raw', 'brier_logistic', 'brier_mlp']);
    expect(s.xs).toHaveLength(1);
    expect(s.values).toEqual([[0.1], [null], [0.2]]);
  });
});

describe('needed', () => {
  it('requires the relative margin for rain', () => {
    expect(needed('rain', 0.0974, 0.0799)).toBeCloseTo(0.0799 * 0.98, 6);
  });
  it('requires the larger of the absolute and relative gain for temperature', () => {
    expect(needed('temp', 1.5, 1.4)).toBeCloseTo(1.35, 6);
    expect(needed('temp', 3, 2.8)).toBeCloseTo(2.716, 6);
  });
});

describe('niceTicks', () => {
  it('covers the range with round steps', () => {
    const t = niceTicks(0.079, 0.152, 4);
    expect(t[0]).toBeLessThanOrEqual(0.079);
    expect(t[t.length - 1]).toBeGreaterThanOrEqual(0.152);
    expect(t.slice(1).map((v, i) => Number((v - t[i]).toFixed(6)))).toSatisfy((d: number[]) => new Set(d).size === 1);
  });
  it('widens a flat range instead of dividing by zero', () => {
    const t = niceTicks(1, 1);
    expect(t.length).toBeGreaterThan(1);
    expect(t[0]).toBeLessThan(1);
  });
  it('picks decimals matching the step', () => {
    expect(tickDigits([0.02, 0.04])).toBe(2);
    expect(tickDigits([0.5, 1])).toBe(1);
    expect(tickDigits([0, 5])).toBe(0);
  });
});
