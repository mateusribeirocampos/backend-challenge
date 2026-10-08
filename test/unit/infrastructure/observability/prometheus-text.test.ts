import { describe, expect, test } from 'bun:test';
import { MetricName } from '../../../../src/application/ports/metrics.js';
import { InMemoryMetrics } from '../../../../src/infrastructure/observability/in-memory-metrics.js';
import { renderPrometheusText } from '../../../../src/infrastructure/observability/prometheus-text.js';

function render(metrics: InMemoryMetrics): string[] {
  return renderPrometheusText(metrics.snapshot()).split('\n');
}

describe('renderPrometheusText: the text exposition format of GET /metrics', () => {
  test('a counter: one TYPE line, then one line per label set', () => {
    const metrics = new InMemoryMetrics();
    metrics.increment(MetricName.HttpTransactions, { status: 'PROCESSED' });
    metrics.increment(MetricName.HttpTransactions, { status: 'PROCESSED' });
    metrics.increment(MetricName.HttpTransactions, { status: 'REJECTED' });

    expect(render(metrics)).toEqual([
      '# TYPE wager_http_transactions_total counter',
      'wager_http_transactions_total{status="PROCESSED"} 2',
      'wager_http_transactions_total{status="REJECTED"} 1',
      '',
    ]);
  });

  test('a gauge without labels', () => {
    const metrics = new InMemoryMetrics();
    metrics.setGauge(MetricName.OutboxLagSeconds, 1.5);

    expect(render(metrics)).toEqual(['# TYPE wager_outbox_lag_seconds gauge', 'wager_outbox_lag_seconds 1.5', '']);
  });

  test('a histogram: cumulative buckets up to +Inf, then sum and count', () => {
    const metrics = new InMemoryMetrics([0.01, 0.1, 1]);
    metrics.observe(MetricName.ProcessingDuration, 0.004, { source: 'http' });
    metrics.observe(MetricName.ProcessingDuration, 0.05, { source: 'http' });
    metrics.observe(MetricName.ProcessingDuration, 2, { source: 'http' });

    expect(render(metrics)).toEqual([
      '# TYPE wager_processing_duration_seconds histogram',
      'wager_processing_duration_seconds_bucket{source="http",le="0.01"} 1',
      'wager_processing_duration_seconds_bucket{source="http",le="0.1"} 2',
      'wager_processing_duration_seconds_bucket{source="http",le="1"} 2',
      'wager_processing_duration_seconds_bucket{source="http",le="+Inf"} 3',
      'wager_processing_duration_seconds_sum{source="http"} 2.054',
      'wager_processing_duration_seconds_count{source="http"} 3',
      '',
    ]);
  });

  test('label values are escaped: backslash, double quote and line break', () => {
    const metrics = new InMemoryMetrics();
    metrics.increment(MetricName.MessageRetries, { error_code: 'a\\b"c\nd' });

    expect(render(metrics)).toContain('wager_message_retries_total{error_code="a\\\\b\\"c\\nd"} 1');
  });

  test('nothing recorded yet: an empty body, still valid', () => {
    expect(renderPrometheusText(new InMemoryMetrics().snapshot())).toBe('');
  });
});
