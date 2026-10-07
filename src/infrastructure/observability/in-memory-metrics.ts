import type { MetricLabels, MetricName, Metrics } from '../../application/ports/metrics.js';

/**
 * Counters kept in the process memory. Enough to count and to assert in tests; an
 * endpoint that exposes them is part of the observability work. Losing them on restart
 * is fine: they are statistics, not a guarantee of anything.
 */
export class InMemoryMetrics implements Metrics {
  private readonly counters = new Map<string, number>();

  increment(name: MetricName, labels: MetricLabels = {}): void {
    const key = InMemoryMetrics.keyOf(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  /** Current value of one counter with exactly these labels. */
  value(name: MetricName, labels: MetricLabels = {}): number {
    return this.counters.get(InMemoryMetrics.keyOf(name, labels)) ?? 0;
  }

  private static keyOf(name: MetricName, labels: MetricLabels): string {
    const sorted = Object.keys(labels)
      .sort()
      .map((label) => `${label}="${labels[label]}"`);
    return `${name}{${sorted.join(',')}}`;
  }
}
