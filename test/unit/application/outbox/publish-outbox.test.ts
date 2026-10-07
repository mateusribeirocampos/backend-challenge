import { describe, expect, test } from 'bun:test';
import type { Clock } from '../../../../src/application/ports/clock.js';
import type { EventPublisher } from '../../../../src/application/ports/event-publisher.js';
import { MetricName } from '../../../../src/application/ports/metrics.js';
import type { OutboxClaim, Repositories } from '../../../../src/application/ports/repositories.js';
import type { TransactionRunner } from '../../../../src/application/ports/transaction-runner.js';
import { PublishOutbox, type OutboxPublisherSettings } from '../../../../src/application/outbox/publish-outbox.js';
import { OutboxMessage } from '../../../../src/domain/outbox/outbox-message.js';
import { InMemoryMetrics } from '../../../../src/infrastructure/observability/in-memory-metrics.js';
import { CapturingLogger } from '../../../integration/support/capturing-logger.js';

/**
 * The publish loop of one batch, with the outbox and SQS replaced by small fakes. The
 * claim itself is SQL (FOR UPDATE SKIP LOCKED); it is proven against PostgreSQL in
 * test/integration/messaging/outbox-publisher.test.ts.
 */
const START = new Date('2026-10-07T12:00:00.000Z');
const WALLET_A = '0192f291-27dd-7d3f-8071-5f8685dee0aa';
const WALLET_B = '0192f291-27dd-7d3f-8071-5f8685dee0bb';

const SETTINGS: OutboxPublisherSettings = {
  batchSize: 10,
  leaseMs: 30_000,
  sendTimeoutMs: 5_000,
  // random 1: the delay is exactly the exponential step (1 s for the first retry).
  retry: { baseDelayMs: 1_000, maxDelayMs: 60_000, random: () => 1 },
};

function event(id: string, aggregateId: string, attempts = 0): OutboxMessage {
  return OutboxMessage.rehydrate({
    id,
    aggregateId,
    eventType: 'WagerTransactionProcessed',
    payload: { eventId: id, correlationId: `corr-${id}` },
    occurredAt: new Date('2026-10-07T11:59:50.000Z'),
    attempts,
    nextAttemptAt: new Date('2026-10-07T11:59:50.000Z'),
    publishedAt: undefined,
  });
}

class FakeClock implements Clock {
  current = START.getTime();
  now(): Date {
    return new Date(this.current);
  }
}

/** The outbox as the publisher sees it, recording every call. */
class FakeOutbox {
  readonly claims: OutboxClaim[] = [];
  readonly published: string[] = [];
  readonly retried: { id: string; attempts: number; nextAttemptAt: Date; leaseToken: string }[] = [];
  readonly released: { ids: string[]; leaseToken: string }[] = [];
  /** Ids another publisher marked published first. */
  readonly publishedElsewhere = new Set<string>();
  oldestPending: Date | undefined = undefined;

  constructor(private readonly batch: OutboxMessage[]) {}

  repositories(): Repositories {
    return {
      outbox: {
        add: async () => {},
        claimBatch: async (claim: OutboxClaim) => {
          this.claims.push(claim);
          return this.batch;
        },
        markPublished: async (message: OutboxMessage) => {
          this.published.push(message.id);
          return !this.publishedElsewhere.has(message.id);
        },
        saveRetry: async (message: OutboxMessage, leaseToken: string) => {
          this.retried.push({ id: message.id, attempts: message.attempts, nextAttemptAt: message.nextAttemptAt, leaseToken });
          return true;
        },
        releaseLease: async (ids: readonly string[], leaseToken: string) => {
          this.released.push({ ids: [...ids], leaseToken });
          return ids.length;
        },
        oldestPendingOccurredAt: async () => this.oldestPending,
      },
    } as unknown as Repositories;
  }
}

/** Records the order of sends; can fail chosen events or run a hook on a send. */
class FakeSqs implements EventPublisher {
  readonly sent: string[] = [];
  readonly failing = new Set<string>();
  onSend: (message: OutboxMessage) => void = () => {};

  async publish(message: OutboxMessage): Promise<void> {
    this.onSend(message);
    if (this.failing.has(message.id)) {
      throw new Error('SQS is unavailable');
    }
    this.sent.push(message.id);
  }
}

function harness(batch: OutboxMessage[]) {
  const outbox = new FakeOutbox(batch);
  const sqs = new FakeSqs();
  const clock = new FakeClock();
  const metrics = new InMemoryMetrics();
  const logs = new CapturingLogger();
  const runner: TransactionRunner = { run: (work) => work(outbox.repositories()) };
  let nextToken = 0;
  const ids = { newId: () => `lease-${++nextToken}` };
  const publisher = new PublishOutbox(runner, sqs, clock, ids, metrics, logs, SETTINGS);
  return { outbox, sqs, clock, metrics, logs, publisher };
}

describe('PublishOutbox.publishBatch', () => {
  test('claims with a new lease token, the configured lease and batch size', async () => {
    const { outbox, publisher } = harness([]);

    await publisher.publishBatch();
    await publisher.publishBatch();

    expect(outbox.claims).toEqual([
      { leaseToken: 'lease-1', leaseMs: 30_000, limit: 10 },
      { leaseToken: 'lease-2', leaseMs: 30_000, limit: 10 },
    ]);
  });

  test('sends every claimed event and marks each one published, in the claimed order', async () => {
    const { outbox, sqs, metrics, publisher } = harness([event('a1', WALLET_A), event('a2', WALLET_A), event('b1', WALLET_B)]);

    const result = await publisher.publishBatch();

    expect(result).toEqual({ claimed: 3, published: 3, failed: 0, released: 0 });
    expect(sqs.sent.filter((id) => id.startsWith('a'))).toEqual(['a1', 'a2']);
    expect([...outbox.published].sort()).toEqual(['a1', 'a2', 'b1']);
    expect(metrics.value(MetricName.OutboxPublished, { event_type: 'WagerTransactionProcessed' })).toBe(3);
  });

  test('a failed send: that event gets a retry with backoff, the later events of the SAME wallet are released, other wallets go on', async () => {
    const { outbox, sqs, metrics, publisher } = harness([
      event('a1', WALLET_A),
      event('a2', WALLET_A),
      event('a3', WALLET_A),
      event('b1', WALLET_B),
    ]);
    sqs.failing.add('a2');

    const result = await publisher.publishBatch();

    expect(result).toEqual({ claimed: 4, published: 2, failed: 1, released: 1 });
    expect(sqs.sent).not.toContain('a3'); // a3 never goes out before a2
    expect(sqs.sent).toContain('b1');
    expect(outbox.retried).toEqual([
      { id: 'a2', attempts: 1, nextAttemptAt: new Date(START.getTime() + 1_000), leaseToken: 'lease-1' },
    ]);
    expect(outbox.released).toEqual([{ ids: ['a3'], leaseToken: 'lease-1' }]);
    expect(metrics.value(MetricName.OutboxPublishFailures)).toBe(1);
  });

  test('stop requested: the event being sent finishes, the ones not started are released', async () => {
    const { outbox, sqs, publisher } = harness([event('a1', WALLET_A), event('a2', WALLET_A), event('a3', WALLET_A)]);
    let stopping = false;
    sqs.onSend = () => {
      stopping = true; // SIGTERM arrives while a1 is being sent
    };

    const result = await publisher.publishBatch(() => stopping);

    expect(sqs.sent).toEqual(['a1']);
    expect(outbox.published).toEqual(['a1']);
    expect(outbox.released).toEqual([{ ids: ['a2', 'a3'], leaseToken: 'lease-1' }]);
    expect(result).toEqual({ claimed: 3, published: 1, failed: 0, released: 2 });
  });

  test('a send only starts if the lease still covers it: past the deadline the rest is released', async () => {
    const { outbox, sqs, clock, publisher } = harness([event('a1', WALLET_A), event('a2', WALLET_A)]);
    // The first send is slow: it ends 26 s after the claim. 26 + 5 (send timeout) > 30 (lease).
    sqs.onSend = () => {
      clock.current = START.getTime() + 26_000;
    };

    const result = await publisher.publishBatch();

    expect(sqs.sent).toEqual(['a1']);
    expect(outbox.released).toEqual([{ ids: ['a2'], leaseToken: 'lease-1' }]);
    expect(result.released).toBe(1);
  });

  test('wallets are published in parallel: a slow wallet does not hold the others', async () => {
    const { sqs, publisher } = harness([event('a1', WALLET_A), event('b1', WALLET_B)]);
    let releaseA: () => void = () => {};
    const aIsStuck = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const original = sqs.publish.bind(sqs);
    sqs.publish = async (message) => {
      if (message.id === 'a1') {
        await aIsStuck;
      }
      return original(message);
    };

    const batch = publisher.publishBatch();
    await waitFor(() => sqs.sent.includes('b1'));
    expect(sqs.sent).toEqual(['b1']); // b1 went out while a1 was still being sent
    releaseA();
    await batch;
    expect(sqs.sent).toEqual(['b1', 'a1']);
  });

  test('a failure to record a result ends the batch only after the other wallets finished their sends', async () => {
    const { outbox, sqs, publisher } = harness([event('a1', WALLET_A), event('b1', WALLET_B), event('b2', WALLET_B)]);
    const repositories = outbox.repositories();
    const markPublished = repositories.outbox.markPublished.bind(repositories.outbox);
    outbox.repositories = () => ({
      ...repositories,
      outbox: {
        ...repositories.outbox,
        markPublished: async (message: OutboxMessage) => {
          if (message.id === 'a1') throw new Error('database down');
          return markPublished(message);
        },
      },
    });

    // Wallet B's sends are slower than wallet A's failure.
    const original = sqs.publish.bind(sqs);
    sqs.publish = async (message) => {
      if (message.aggregateId === WALLET_B) await Bun.sleep(10);
      return original(message);
    };

    await expect(publisher.publishBatch()).rejects.toThrow('database down');
    expect(sqs.sent).toEqual(['a1', 'b1', 'b2']); // wallet B was not abandoned half way
  });

  test('logs carry the correlationId of the event (spec 12), and no amount', async () => {
    const { sqs, logs, publisher } = harness([event('a1', WALLET_A), event('a2', WALLET_A)]);
    sqs.failing.add('a1');

    await publisher.publishBatch();

    expect(logs.events('outbox.publish_failed')[0]?.fields).toEqual(
      expect.objectContaining({ eventId: 'a1', walletId: WALLET_A, correlationId: 'corr-a1', attempts: 1 }),
    );
    expect(logs.events('outbox.lease_released')[0]?.fields).toEqual(
      expect.objectContaining({ walletId: WALLET_A, count: 1, correlationIds: 'corr-a2' }),
    );
  });

  test('a head event reaching 10 attempts logs outbox.wallet_stalled: its wallet publishes nothing until it goes out', async () => {
    const { sqs, logs, publisher } = harness([event('a1', WALLET_A, 9), event('b1', WALLET_B, 3)]);
    sqs.failing.add('a1');
    sqs.failing.add('b1');

    await publisher.publishBatch();

    expect(logs.events('outbox.wallet_stalled').map((line) => line.fields)).toEqual([
      {
        walletId: WALLET_A,
        eventId: 'a1',
        eventType: 'WagerTransactionProcessed',
        correlationId: 'corr-a1',
        attempts: 10,
        nextAttemptAt: expect.any(String),
      },
    ]);
  });

  test('an event that failed before counts as a retry when it is sent', async () => {
    const { metrics, publisher } = harness([event('a1', WALLET_A, 2)]);

    await publisher.publishBatch();

    expect(metrics.value(MetricName.OutboxPublishRetries)).toBe(1);
  });

  test('another publisher marked it first: counted and logged as a duplicate publish, not an error', async () => {
    const { outbox, metrics, logs, publisher } = harness([event('a1', WALLET_A)]);
    outbox.publishedElsewhere.add('a1');

    const result = await publisher.publishBatch();

    expect(result.published).toBe(1);
    expect(metrics.value(MetricName.OutboxDuplicatePublishes)).toBe(1);
    expect(logs.events('outbox.duplicate_publish')[0]?.fields).toEqual(
      expect.objectContaining({ eventId: 'a1', walletId: WALLET_A }),
    );
  });

  test('records the outbox lag: age of the oldest unpublished event, 0 when there is none', async () => {
    const { outbox, metrics, publisher } = harness([]);
    outbox.oldestPending = new Date(START.getTime() - 42_500);

    await publisher.publishBatch();
    expect(metrics.gauge(MetricName.OutboxLagSeconds)).toBe(42.5);

    outbox.oldestPending = undefined;
    await publisher.publishBatch();
    expect(metrics.gauge(MetricName.OutboxLagSeconds)).toBe(0);
  });
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i++) {
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(condition()).toBe(true);
}
