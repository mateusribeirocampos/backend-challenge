import type { IntegrationEvent } from '../events/integration-event.js';
import { DomainInvariantError } from '../shared/domain-error.js';
import { backoffDelayMs, type BackoffPolicy } from '../shared/exponential-backoff.js';

export interface OutboxMessageState {
  /** Same as the event id, so the consumer can deduplicate a republished event. */
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
  readonly attempts: number;
  /** When the publisher may try (again). Set at enqueue, so the column is never null. */
  readonly nextAttemptAt: Date;
  readonly publishedAt: Date | undefined;
}

/**
 * How far apart publish retries are (see backoffDelayMs).
 * Retry n (1, 2, 3...) waits between half and all of min(maxDelayMs, baseDelayMs * 2^(n-1)).
 */
export type RetryPolicy = BackoffPolicy;

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  baseDelayMs: 1_000,
  maxDelayMs: 5 * 60_000,
  random: Math.random,
};

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * An integration event waiting to be published (spec 6.5). It is written in
 * the same SQL transaction as the change that produced the event, and a worker
 * publishes it after the commit. Publishing twice is possible (at-least-once); the
 * consumer deduplicates by id.
 */
export class OutboxMessage {
  private readonly state: Mutable<OutboxMessageState>;

  private constructor(state: OutboxMessageState) {
    this.state = { ...state };
  }

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const payload = event.toJSON() as unknown as Readonly<Record<string, unknown>>;
    return new OutboxMessage({
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload,
      occurredAt: event.occurredAt,
      attempts: 0,
      nextAttemptAt: event.occurredAt,
      publishedAt: undefined,
    });
  }

  /** Rebuilds a stored message as it is. No checks (spec 6.0). */
  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(state);
  }

  get id(): string { return this.state.id; }
  get aggregateId(): string { return this.state.aggregateId; }
  get eventType(): string { return this.state.eventType; }
  get payload(): Readonly<Record<string, unknown>> { return this.state.payload; }
  get occurredAt(): Date { return this.state.occurredAt; }
  get attempts(): number { return this.state.attempts; }
  get nextAttemptAt(): Date { return this.state.nextAttemptAt; }
  get publishedAt(): Date | undefined { return this.state.publishedAt; }

  isPending(): boolean {
    return this.state.publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && this.state.nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    this.assertPending('markPublished');
    this.state.publishedAt = at;
  }

  /** A publish attempt failed: count it and push the next attempt further away. */
  scheduleRetry(now: Date, policy: RetryPolicy = DEFAULT_RETRY_POLICY): void {
    this.assertPending('scheduleRetry');
    this.state.attempts += 1;
    this.state.nextAttemptAt = new Date(now.getTime() + backoffDelayMs(this.state.attempts, policy));
  }

  private assertPending(operation: string): void {
    if (!this.isPending()) {
      throw new DomainInvariantError(`Outbox message ${this.state.id} is already published; ${operation} is not allowed`);
    }
  }
}
