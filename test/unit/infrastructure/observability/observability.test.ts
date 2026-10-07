import { describe, expect, test } from 'bun:test';
import { MetricName } from '../../../../src/application/ports/metrics.js';
import { InMemoryMetrics } from '../../../../src/infrastructure/observability/in-memory-metrics.js';
import { JsonLineLogger } from '../../../../src/infrastructure/observability/json-line-logger.js';

describe('InMemoryMetrics', () => {
  test('counts per name and per exact set of labels, in any label order', () => {
    const metrics = new InMemoryMetrics();

    metrics.increment(MetricName.MessagesProcessed, { status: 'PROCESSED' });
    metrics.increment(MetricName.MessagesProcessed, { status: 'PROCESSED' });
    metrics.increment(MetricName.MessagesProcessed, { status: 'REJECTED' });
    metrics.increment(MetricName.ConsumerSqsErrors, { operation: 'receive', queue: 'a' });

    expect(metrics.value(MetricName.MessagesProcessed, { status: 'PROCESSED' })).toBe(2);
    expect(metrics.value(MetricName.MessagesProcessed, { status: 'REJECTED' })).toBe(1);
    expect(metrics.value(MetricName.ConsumerSqsErrors, { queue: 'a', operation: 'receive' })).toBe(1);
    expect(metrics.value(MetricName.MessageRetries)).toBe(0);
  });
});

describe('JsonLineLogger', () => {
  test('writes one JSON object per line: time, level, event, then the fields', () => {
    const lines: string[] = [];
    const logger = new JsonLineLogger((line) => lines.push(line));

    logger.warn('wager_message.conflict', { messageId: 'msg-1', receiveCount: 2, failureCode: undefined });

    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(parsed).toEqual({
      time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      level: 'warn',
      event: 'wager_message.conflict',
      messageId: 'msg-1',
      receiveCount: 2,
    });
  });
});
