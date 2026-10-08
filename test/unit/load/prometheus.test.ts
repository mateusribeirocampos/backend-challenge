import { describe, expect, test } from 'bun:test';
import { MetricName } from '../../../src/application/ports/metrics.js';
import { InMemoryMetrics } from '../../../src/infrastructure/observability/in-memory-metrics.js';
import { renderPrometheusText } from '../../../src/infrastructure/observability/prometheus-text.js';
import {
  counterDelta,
  histogramBuckets,
  histogramDelta,
  histogramQuantile,
  maxOf,
  parsePrometheusText,
  sumOf,
} from '../../../load/prometheus.js';

describe('parsePrometheusText', () => {
  test('reads name, labels and value of each sample, ignoring TYPE lines and blank lines', () => {
    const text = [
      '# TYPE wager_http_transactions_total counter',
      'wager_http_transactions_total{status="PROCESSED"} 12',
      'wager_http_transactions_total{status="REJECTED"} 3',
      '',
      '# TYPE wager_outbox_lag_seconds gauge',
      'wager_outbox_lag_seconds 0.25',
    ].join('\n');

    expect(parsePrometheusText(text)).toEqual([
      { name: 'wager_http_transactions_total', labels: { status: 'PROCESSED' }, value: 12 },
      { name: 'wager_http_transactions_total', labels: { status: 'REJECTED' }, value: 3 },
      { name: 'wager_outbox_lag_seconds', labels: {}, value: 0.25 },
    ]);
  });

  test('label values with an escaped quote, backslash and line feed, and the +Inf bucket', () => {
    const text = 'm_bucket{reason="a \\"b\\" c\\\\d\\ne",le="+Inf"} 7';
    expect(parsePrometheusText(text)).toEqual([
      { name: 'm_bucket', labels: { reason: 'a "b" c\\d\ne', le: '+Inf' }, value: 7 },
    ]);
  });

  test('reads back exactly what the app renders on GET /metrics', () => {
    const metrics = new InMemoryMetrics([0.01, 0.1]);
    metrics.increment(MetricName.LockConflicts, { source: 'http' });
    metrics.observe(MetricName.ProcessingDuration, 0.05, { source: 'http' });
    const samples = parsePrometheusText(renderPrometheusText(metrics.snapshot()));

    expect(sumOf(samples, MetricName.LockConflicts, { source: 'http' })).toBe(1);
    expect(histogramBuckets(samples, MetricName.ProcessingDuration, { source: 'http' })).toEqual([
      { le: 0.01, count: 0 },
      { le: 0.1, count: 1 },
      { le: Number.POSITIVE_INFINITY, count: 1 },
    ]);
  });

  test('a malformed line is an error, not a silent zero', () => {
    expect(() => parsePrometheusText('wager_total{status="x" 1')).toThrow();
    expect(() => parsePrometheusText('wager_total abc')).toThrow();
  });
});

describe('sums across instances', () => {
  // Two instances scraped: the same series appears once per instance.
  const instanceA = parsePrometheusText('c{source="http"} 2\nc{source="sqs"} 5\ng 0.5');
  const instanceB = parsePrometheusText('c{source="http"} 3\ng 1.5');
  const both = [...instanceA, ...instanceB];

  test('sumOf adds every series whose labels contain the filter', () => {
    expect(sumOf(both, 'c', { source: 'http' })).toBe(5);
    expect(sumOf(both, 'c')).toBe(10);
    expect(sumOf(both, 'missing')).toBe(0);
  });

  test('maxOf: the largest gauge among the instances (the outbox lag is a per-instance view)', () => {
    expect(maxOf(both, 'g')).toBe(1.5);
    expect(maxOf(both, 'missing')).toBeUndefined();
  });

  test('counterDelta: what happened between two scrapes', () => {
    const later = parsePrometheusText('c{source="http"} 9\nc{source="sqs"} 5\nc{source="http"} 4');
    expect(counterDelta(both, later, 'c', { source: 'http' })).toBe(8);
  });
});

describe('histogram quantile (the server-side cross-check)', () => {
  const before = [
    { le: 0.005, count: 10 },
    { le: 0.01, count: 10 },
    { le: 0.025, count: 10 },
    { le: Number.POSITIVE_INFINITY, count: 10 },
  ];
  const after = [
    { le: 0.005, count: 10 },
    { le: 0.01, count: 60 },
    { le: 0.025, count: 110 },
    { le: Number.POSITIVE_INFINITY, count: 110 },
  ];

  test('histogramDelta subtracts bucket by bucket', () => {
    expect(histogramDelta(before, after).map((bucket) => bucket.count)).toEqual([0, 50, 100, 100]);
  });

  test('interpolates linearly inside the bucket, as Prometheus histogram_quantile does', () => {
    const delta = histogramDelta(before, after);
    // 50 observations in (5 ms, 10 ms], 50 in (10 ms, 25 ms]. The 50th is the top of the first.
    expect(histogramQuantile(delta, 0.5)).toBeCloseTo(0.01, 10);
    // The 75th is half way through (10 ms, 25 ms].
    expect(histogramQuantile(delta, 0.75)).toBeCloseTo(0.0175, 10);
  });

  test('a quantile in the +Inf bucket answers the largest finite bound: the real value is only known to be above it', () => {
    const buckets = [
      { le: 1, count: 1 },
      { le: 5, count: 1 },
      { le: Number.POSITIVE_INFINITY, count: 3 },
    ];
    expect(histogramQuantile(buckets, 0.99)).toBe(5);
  });

  test('no observations: undefined', () => {
    expect(histogramQuantile([{ le: Number.POSITIVE_INFINITY, count: 0 }], 0.5)).toBeUndefined();
  });
});
