import { defineEntity, type InferEntity, p } from '@mikro-orm/core';

/** Mapping of outbox_messages. sequence_number and the lease columns are used only by the publisher SQL. */
export const OutboxMessageEntity = defineEntity({
  name: 'OutboxMessageRecord',
  tableName: 'outbox_messages',
  properties: {
    id: p.uuid().primary(),
    aggregateId: p.uuid(),
    eventType: p.text(),
    payload: p.json<Record<string, unknown>>(),
    occurredAt: p.datetime(),
    attempts: p.integer(),
    nextAttemptAt: p.datetime(),
    publishedAt: p.datetime().nullable(),
  },
});

export type OutboxMessageRecord = InferEntity<typeof OutboxMessageEntity>;
