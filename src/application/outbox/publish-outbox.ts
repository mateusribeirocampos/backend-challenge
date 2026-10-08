import type { OutboxMessage, RetryPolicy } from '../../domain/outbox/outbox-message.js';
import { summarizeError } from '../error-summary.js';
import type { Clock } from '../ports/clock.js';
import type { EventPublisher } from '../ports/event-publisher.js';
import type { IdGenerator } from '../ports/id-generator.js';
import { type Metrics, MetricName } from '../ports/metrics.js';
import type { StructuredLogger } from '../ports/structured-logger.js';
import type { TransactionRunner } from '../ports/transaction-runner.js';

export interface OutboxPublisherSettings {
  /** Events claimed per batch. */
  readonly batchSize: number;
  /** How long a claim reserves its events. Another publisher takes them only after this. */
  readonly leaseMs: number;
  /** A send that takes longer is given up (and retried later). Must be shorter than leaseMs. */
  readonly sendTimeoutMs: number;
  /** Backoff of a failed send. */
  readonly retry: RetryPolicy;
}

export interface PublishBatchResult {
  readonly claimed: number;
  readonly published: number;
  readonly failed: number;
  /** Claimed but given back untouched: after a failure in the same wallet, on stop, or with the lease running out. */
  readonly released: number;
}

const NOTHING: PublishBatchResult = { claimed: 0, published: 0, failed: 0, released: 0 };

/**
 * From this many failed attempts of the oldest event of a wallet on, every new failure
 * logs outbox.wallet_stalled: that wallet publishes nothing until this event goes out.
 * With the backoff (1 s doubling, 5 min ceiling, jitter), the 10th failure comes about
 * 4.3 to 8.5 minutes after the first.
 */
export const STALLED_AFTER_ATTEMPTS = 10;

/**
 * The outbox publisher (spec 11). One batch, in three steps:
 *
 *   1. CLAIM, in a short SQL transaction: reserve due events with a lease (locked_until
 *      plus a token). FOR UPDATE SKIP LOCKED makes concurrent publishers take different
 *      wallets instead of waiting for each other. COMMIT.
 *   2. SEND each event to SQS, OUTSIDE any transaction: no row lock and no connection
 *      is held while SQS answers.
 *   3. RECORD each result in its own short transaction: published, or a retry with backoff.
 *
 * Order inside a wallet: the claim takes a wallet only from its oldest unpublished
 * event, so a later event of a wallet never goes out while an earlier one is pending.
 * Wallets are sent in parallel; the events of one wallet one after the other, and the
 * first failure stops that wallet (the rest is released and waits for the failed one).
 *
 * If the process dies after step 2 and before step 3, the lease expires and another
 * instance sends the event again: at-least-once. The SQS deduplication id is the event
 * id, and consumers deduplicate by eventId.
 */
export class PublishOutbox {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly metrics: Metrics,
    private readonly logger: StructuredLogger,
    private readonly settings: OutboxPublisherSettings,
  ) {}

  /** shouldStop: checked before each send; once true, what was not started is released. */
  async publishBatch(shouldStop: () => boolean = () => false): Promise<PublishBatchResult> {
    // Taken BEFORE the claim, so this deadline always ends before the lease the
    // database gives (which starts a moment later).
    const lastSendStart = this.clock.now().getTime() + this.settings.leaseMs - this.settings.sendTimeoutMs;
    const leaseToken = this.ids.newId();
    const claimed = await this.runner.run((repositories) =>
      repositories.outbox.claimBatch({ leaseToken, leaseMs: this.settings.leaseMs, limit: this.settings.batchSize }),
    );

    const lease: Lease = {
      token: leaseToken,
      // A send only starts if it can end (sendTimeoutMs) while the lease still holds.
      canStartSend: () => !shouldStop() && this.clock.now().getTime() <= lastSendStart,
    };
    // allSettled, not all: if one wallet fails (database down while recording), the
    // other wallets still finish the send they started before the error goes up.
    const settled = await Promise.allSettled(groupByWallet(claimed).map((events) => this.publishInOrder(events, lease)));
    const results = settled.map(valueOrThrow);
    await this.recordLag();
    return results.reduce(sum, NOTHING);
  }

  /** The events of ONE wallet, oldest first. Stops at the first failure. */
  private async publishInOrder(events: readonly OutboxMessage[], lease: Lease): Promise<PublishBatchResult> {
    let published = 0;
    for (const [index, event] of events.entries()) {
      if (!lease.canStartSend()) {
        return { claimed: events.length, published, failed: 0, released: await this.release(events.slice(index), lease) };
      }
      const sent = await this.send(event);
      if (!sent) {
        await this.scheduleRetry(event, lease);
        const rest = events.slice(index + 1);
        return { claimed: events.length, published, failed: 1, released: await this.release(rest, lease) };
      }
      await this.markPublished(event);
      published += 1;
    }
    return { claimed: events.length, published, failed: 0, released: 0 };
  }

  private async send(event: OutboxMessage): Promise<boolean> {
    if (event.attempts > 0) {
      this.metrics.increment(MetricName.OutboxPublishRetries);
    }
    try {
      await this.publisher.publish(event);
      return true;
    } catch (error) {
      this.metrics.increment(MetricName.OutboxPublishFailures);
      this.logger.warn('outbox.publish_failed', { ...fieldsOf(event), attempts: event.attempts + 1, ...summarizeError(error) });
      return false;
    }
  }

  private async markPublished(event: OutboxMessage): Promise<void> {
    event.markPublished(this.clock.now());
    const first = await this.runner.run((repositories) => repositories.outbox.markPublished(event));
    this.metrics.increment(MetricName.OutboxPublished, { event_type: event.eventType });
    if (!first) {
      // Another publisher took over after our lease ran out and marked it first.
      this.metrics.increment(MetricName.OutboxDuplicatePublishes);
      this.logger.warn('outbox.duplicate_publish', fieldsOf(event));
    }
  }

  private async scheduleRetry(event: OutboxMessage, lease: Lease): Promise<void> {
    event.scheduleRetry(this.clock.now(), this.settings.retry);
    await this.runner.run((repositories) => repositories.outbox.saveRetry(event, lease.token));
    if (event.attempts >= STALLED_AFTER_ATTEMPTS) {
      // Head-of-line blocking made visible: the later events of this wallet wait for this one.
      this.logger.warn('outbox.wallet_stalled', {
        ...fieldsOf(event),
        attempts: event.attempts,
        nextAttemptAt: event.nextAttemptAt.toISOString(),
      });
    }
  }

  private async release(events: readonly OutboxMessage[], lease: Lease): Promise<number> {
    if (events.length === 0) {
      return 0;
    }
    const ids = events.map((event) => event.id);
    await this.runner.run((repositories) => repositories.outbox.releaseLease(ids, lease.token));
    this.logger.info('outbox.lease_released', {
      walletId: events[0]?.aggregateId,
      count: ids.length,
      correlationIds: events.map(correlationIdOf).join(','),
    });
    return ids.length;
  }

  /** Spec 12 "outbox lag": how old the oldest event still waiting to be published is. */
  private async recordLag(): Promise<void> {
    const oldest = await this.runner.run((repositories) => repositories.outbox.oldestPendingOccurredAt());
    const lagMs = oldest === undefined ? 0 : Math.max(0, this.clock.now().getTime() - oldest.getTime());
    this.metrics.setGauge(MetricName.OutboxLagSeconds, lagMs / 1000);
  }
}

interface Lease {
  readonly token: string;
  readonly canStartSend: () => boolean;
}

/** Keeps the claim order inside each wallet (Map keeps insertion order). */
function groupByWallet(events: readonly OutboxMessage[]): OutboxMessage[][] {
  const groups = new Map<string, OutboxMessage[]>();
  for (const event of events) {
    const group = groups.get(event.aggregateId) ?? [];
    group.push(event);
    groups.set(event.aggregateId, group);
  }
  return [...groups.values()];
}

function valueOrThrow<T>(result: PromiseSettledResult<T>): T {
  if (result.status === 'rejected') {
    throw result.reason;
  }
  return result.value;
}

function sum(total: PublishBatchResult, part: PublishBatchResult): PublishBatchResult {
  return {
    claimed: total.claimed + part.claimed,
    published: total.published + part.published,
    failed: total.failed + part.failed,
    released: total.released + part.released,
  };
}

/** Ids for the logs (spec 12). Never the payload: it carries amounts. */
/** Identifiers only (spec 12): the event's data also has amounts and balances, which stay out of the logs. */
function fieldsOf(event: OutboxMessage) {
  const { causationId, data } = event.payload;
  const eventData = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
  return {
    walletId: event.aggregateId,
    eventId: event.id,
    eventType: event.eventType,
    correlationId: correlationIdOf(event),
    messageId: textOrUndefined(causationId),
    transactionId: textOrUndefined(eventData.transactionId),
    providerId: textOrUndefined(eventData.providerId),
  };
}

function textOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** The correlationId of the request or message that caused the event, from its envelope. */
function correlationIdOf(event: OutboxMessage): string {
  const { correlationId } = event.payload;
  return typeof correlationId === 'string' ? correlationId : '';
}
