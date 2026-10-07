import { InboxMessage } from '../../../domain/inbox/inbox-message.js';
import type { InboxMessageRecord } from '../entities/inbox-message.entity.js';

/** Row -> domain, with rehydrate: no checks on what is already stored (spec 6.0). */
export function toInboxMessage(record: InboxMessageRecord): InboxMessage {
  return InboxMessage.rehydrate({
    consumerName: record.consumerName,
    messageId: record.messageId,
    payloadHash: record.payloadHash,
    receivedAt: record.receivedAt,
    processedAt: record.processedAt ?? undefined,
  });
}
