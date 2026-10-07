import { defineEntity, type InferEntity, p } from '@mikro-orm/core';

/**
 * Mapping of inbox_messages. The primary key (consumer_name, message_id) is the
 * deduplication of SQS deliveries (ADR-005); the migration created it.
 */
export const InboxMessageEntity = defineEntity({
  name: 'InboxMessageRecord',
  tableName: 'inbox_messages',
  properties: {
    consumerName: p.text().primary(),
    messageId: p.text().primary(),
    payloadHash: p.text(),
    receivedAt: p.datetime(),
    processedAt: p.datetime().nullable(),
  },
});

export type InboxMessageRecord = InferEntity<typeof InboxMessageEntity>;
