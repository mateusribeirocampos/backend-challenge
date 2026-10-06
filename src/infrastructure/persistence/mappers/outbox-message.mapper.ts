import type { OutboxMessage } from '../../../domain/outbox/outbox-message.js';
import type { OutboxMessageRecord } from '../entities/outbox-message.entity.js';

/** Domain -> row. Reading the outbox back (rehydrate) comes with the publisher worker. */
export function toOutboxMessageRecord(message: OutboxMessage): OutboxMessageRecord {
  return {
    id: message.id,
    aggregateId: message.aggregateId,
    eventType: message.eventType,
    payload: { ...message.payload },
    occurredAt: message.occurredAt,
    attempts: message.attempts,
    nextAttemptAt: message.nextAttemptAt,
    publishedAt: message.publishedAt ?? null,
  };
}
