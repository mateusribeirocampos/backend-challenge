/**
 * Latency statistics of the load test. Latencies are durations in milliseconds, never
 * money, so `number` is the right type here.
 */

export interface LatencySummary {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  readonly mean: number;
}

/**
 * Nearest-rank percentile: the smallest measured value with at least p% of the values
 * at or below it. Always a value that was really measured (no interpolation), so a p99
 * in the report is the latency of an actual request.
 */
export function percentile(values: readonly number[], p: number): number | undefined {
  if (p < 0 || p > 100) {
    throw new RangeError(`percentile must be between 0 and 100, got ${p}`);
  }
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((left, right) => left - right);
  // The epsilon absorbs float noise: 0.999 * 1000 is 999.0000000000001, and its ceil
  // would wrongly pick the 1000th value for p99.9.
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length - 1e-9));
  return sorted[rank - 1];
}

/** undefined when nothing was measured: the report shows "n/d", never an invented zero. */
export function summarize(values: readonly number[]): LatencySummary | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const at = (p: number) => percentile(sorted, p) ?? 0;
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    p50: at(50),
    p95: at(95),
    p99: at(99),
    max: sorted[sorted.length - 1] ?? 0,
    mean: total / sorted.length,
  };
}
