import type { MetricLabels, MetricName, Metrics } from '../../application/ports/metrics.js';
import type { HistogramSample, MetricFamily, Sample } from './prometheus-text.js';

/**
 * Upper bounds, in seconds, of the latency histogram. One transaction is a handful of SQL
 * statements: a few milliseconds, so the low end is fine-grained (5 ms to 100 ms). The
 * lock_timeout is 2 s: a request that waited for a busy wallet and gave up lands between
 * 1 and 2.5. The SQS path retries contention up to 3 times, so two timeouts land under 5
 * and three in +Inf. These are the Prometheus client defaults without the 10 s bucket.
 */
export const DURATION_BUCKETS_SECONDS: readonly number[] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

interface HistogramState {
  readonly labels: MetricLabels;
  readonly cumulativeCounts: number[];
  sum: number;
  count: number;
}

/**
 * Counters, gauges and histograms kept in the process memory, exposed by GET /metrics.
 * Losing them on restart is fine: they are statistics, not a guarantee of anything
 * (Prometheus handles a counter that goes back to zero). Each instance exposes its own.
 */
export class InMemoryMetrics implements Metrics {
  private readonly counters = new Map<MetricName, Map<string, Sample>>();
  private readonly gauges = new Map<MetricName, Map<string, Sample>>();
  private readonly histograms = new Map<MetricName, Map<string, HistogramState>>();

  constructor(private readonly buckets: readonly number[] = DURATION_BUCKETS_SECONDS) {}

  increment(name: MetricName, labels: MetricLabels = {}): void {
    const series = seriesOf(this.counters, name);
    const key = keyOf(labels);
    series.set(key, { labels: sorted(labels), value: (series.get(key)?.value ?? 0) + 1 });
  }

  setGauge(name: MetricName, value: number, labels: MetricLabels = {}): void {
    seriesOf(this.gauges, name).set(keyOf(labels), { labels: sorted(labels), value });
  }

  observe(name: MetricName, value: number, labels: MetricLabels = {}): void {
    const series = seriesOf(this.histograms, name);
    const key = keyOf(labels);
    const state = series.get(key) ?? this.emptyHistogram(labels);
    this.buckets.forEach((bound, index) => {
      if (value <= bound) {
        state.cumulativeCounts[index] = (state.cumulativeCounts[index] ?? 0) + 1;
      }
    });
    state.sum += value;
    state.count += 1;
    series.set(key, state);
  }

  /** Current value of one counter with exactly these labels. */
  value(name: MetricName, labels: MetricLabels = {}): number {
    return this.counters.get(name)?.get(keyOf(labels))?.value ?? 0;
  }

  /** Last value set for one gauge; undefined if it was never set. */
  gauge(name: MetricName, labels: MetricLabels = {}): number | undefined {
    return this.gauges.get(name)?.get(keyOf(labels))?.value;
  }

  /** Everything recorded so far, grouped by metric, for the Prometheus text format. */
  snapshot(): MetricFamily[] {
    const counters = [...this.counters].map(([name, series]) => ({
      name,
      type: 'counter' as const,
      samples: [...series.values()],
    }));
    const gauges = [...this.gauges].map(([name, series]) => ({ name, type: 'gauge' as const, samples: [...series.values()] }));
    const histograms = [...this.histograms].map(([name, series]) => ({
      name,
      type: 'histogram' as const,
      buckets: this.buckets,
      samples: [...series.values()].map(
        (state): HistogramSample => ({ ...state, cumulativeCounts: [...state.cumulativeCounts] }),
      ),
    }));
    return [...counters, ...gauges, ...histograms];
  }

  private emptyHistogram(labels: MetricLabels): HistogramState {
    return { labels: sorted(labels), cumulativeCounts: this.buckets.map(() => 0), sum: 0, count: 0 };
  }
}

function seriesOf<T>(store: Map<MetricName, Map<string, T>>, name: MetricName): Map<string, T> {
  const existing = store.get(name);
  if (existing !== undefined) {
    return existing;
  }
  const created = new Map<string, T>();
  store.set(name, created);
  return created;
}

/** Labels sorted by name: { b, a } and { a, b } are the same series. */
function sorted(labels: MetricLabels): MetricLabels {
  return Object.fromEntries(Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)));
}

function keyOf(labels: MetricLabels): string {
  return JSON.stringify(sorted(labels));
}
