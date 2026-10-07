import { OutboxMessage } from '../../../domain/outbox/outbox-message.js';
import type { OutboxMessageRecord } from '../entities/outbox-message.entity.js';

/** Domain -> row. sequence_number and the lease columns are filled by the database and the publisher's SQL. */
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

/** Row -> domain, with rehydrate: no checks on what is already stored (spec 6.0). */
export function toOutboxMessage(record: OutboxMessageRecord): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: record.id,
    aggregateId: record.aggregateId,
    eventType: record.eventType,
    payload: record.payload,
    occurredAt: record.occurredAt,
    attempts: record.attempts,
    nextAttemptAt: record.nextAttemptAt,
    publishedAt: record.publishedAt ?? undefined,
  });
}
