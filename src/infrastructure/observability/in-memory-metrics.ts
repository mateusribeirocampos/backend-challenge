import type { MetricLabels, MetricName, Metrics } from '../../application/ports/metrics.js';

/**
 * Counters and gauges kept in the process memory. Enough to count and to assert in tests; an
 * endpoint that exposes them is part of the observability work. Losing them on restart
 * is fine: they are statistics, not a guarantee of anything.
 */
export class InMemoryMetrics implements Metrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();

  increment(name: MetricName, labels: MetricLabels = {}): void {
    const key = InMemoryMetrics.keyOf(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  setGauge(name: MetricName, value: number, labels: MetricLabels = {}): void {
    this.gauges.set(InMemoryMetrics.keyOf(name, labels), value);
  }

  /** Current value of one counter with exactly these labels. */
  value(name: MetricName, labels: MetricLabels = {}): number {
    return this.counters.get(InMemoryMetrics.keyOf(name, labels)) ?? 0;
  }

  /** Last value set for one gauge; undefined if it was never set. */
  gauge(name: MetricName, labels: MetricLabels = {}): number | undefined {
    return this.gauges.get(InMemoryMetrics.keyOf(name, labels));
  }

  private static keyOf(name: MetricName, labels: MetricLabels): string {
    const sorted = Object.keys(labels)
      .sort()
      .map((label) => `${label}="${labels[label]}"`);
    return `${name}{${sorted.join(',')}}`;
  }
}
