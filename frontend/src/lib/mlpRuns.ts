// Shaping of the daily MLP runs (verify's mlp_runs history) for the /verification/mlp page.

export type MlpKind = 'temp' | 'rain';
export type MlpState = 'on' | 'off' | 'wait';

export interface MlpRun {
  fitted_at: string;
  active: boolean;
  reason: string | null;
  pairs: number | null;
  days: number | null;
  events: number | null;
  metrics: Record<string, number> | null;
}

export interface MlpCurve {
  fitted_at: string;
  metric: 'mae' | 'brier';
  train: number[];
  val: number[];
  best_epoch: number;
}

export interface MlpHistory {
  history: MlpRun[];
  curve: MlpCurve | null;
}

/** The latest-status shape the report has always carried (temp_mlp / rain_mlp). */
export interface MlpStatus {
  fitted_at: string;
  active: boolean;
  reason: string | null;
  pairs: number;
  events?: number;
  days: number;
  required_pairs?: number;
  required_events?: number;
  required_days: number;
  test_days: number;
  metrics: Record<string, number> | null;
}

/** The margin by which the network must beat the best other method (mirrors verify.mlp / verify.rainmlp). */
export const GAIN = { temp: { abs: 0.05, rel: 0.03 }, rain: { abs: 0, rel: 0.02 } } as const;

/** Metric keys per kind: [raw, existing method, network], in the order they are drawn and listed. */
export const KEYS = {
  temp: ['mae_raw', 'mae_hourly_bias', 'mae_mlp'],
  rain: ['brier_raw', 'brier_logistic', 'brier_mlp'],
} as const;

export function mlpState(r: Pick<MlpRun, 'active' | 'reason'> | null | undefined): MlpState {
  if (!r) return 'wait';
  if (r.active) return 'on';
  return r.reason === 'waiting for data' ? 'wait' : 'off';
}

export function runFromStatus(s: MlpStatus): MlpRun {
  return {
    fitted_at: s.fitted_at,
    active: s.active,
    reason: s.reason,
    pairs: s.pairs ?? null,
    days: s.days ?? null,
    events: s.events ?? null,
    metrics: s.metrics,
  };
}

/** Oldest first. Falls back to the single latest status when the report has no history (older report). */
export function runsOf(h: MlpHistory | null | undefined, status: MlpStatus | null | undefined): MlpRun[] {
  const rows = h?.history?.length ? [...h.history] : status ? [runFromStatus(status)] : [];
  return rows.sort((a, b) => Date.parse(a.fitted_at) - Date.parse(b.fitted_at));
}

/** The score the network must stay at or below to be switched on, given the raw and existing-method scores. */
export function needed(kind: MlpKind, raw: number, other: number): number {
  const best = Math.min(raw, other);
  const g = GAIN[kind];
  return Math.min(best - g.abs, best * (1 - g.rel));
}

/** One value per run for a metric key (null where the run has none), with the run times in ms. */
export function seriesOf(runs: MlpRun[], keys: readonly string[]) {
  const rows = runs.filter((r) => r.metrics);
  return {
    xs: rows.map((r) => Date.parse(r.fitted_at)),
    runs: rows,
    values: keys.map((k) => rows.map((r) => r.metrics?.[k] ?? null)),
  };
}

/** Round axis ticks covering [lo, hi]: a 1/2/5 x 10^n step, about `count` of them. */
export function niceTicks(lo: number, hi: number, count = 4): number[] {
  if (!(hi > lo)) {
    const pad = Math.abs(lo) * 0.1 || 1;
    lo -= pad;
    hi += pad;
  }
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
  const out: number[] = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  if (out[out.length - 1] < hi) out.push(Number((out[out.length - 1] + step).toPrecision(12)));
  return out;
}

/** Decimals that show a tick step without noise (0.02 -> 2, 0.5 -> 1, 5 -> 0). */
export function tickDigits(ticks: number[]): number {
  if (ticks.length < 2) return 2;
  const step = Math.abs(ticks[1] - ticks[0]);
  return Math.min(5, Math.max(0, Math.ceil(-Math.log10(step) - 1e-9)));
}

export function shortDate(ms: number, th: boolean): string {
  return new Date(ms).toLocaleDateString(th ? 'th-TH' : 'en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Bangkok' });
}
