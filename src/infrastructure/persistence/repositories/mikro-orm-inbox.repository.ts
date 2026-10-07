import type { EntityManager } from '@mikro-orm/postgresql';
import type { InboxRepository } from '../../../application/ports/repositories.js';
import type { InboxMessage } from '../../../domain/inbox/inbox-message.js';
import { InboxMessageEntity } from '../entities/inbox-message.entity.js';
import { toInboxMessage } from '../mappers/inbox-message.mapper.js';

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async insertIfAbsent(message: InboxMessage): Promise<boolean> {
    // Same idea as the insert-first of wager_transactions: the primary key decides.
    // If another transaction is inserting the same (consumer, message) right now, this
    // statement waits for it to commit or roll back, then inserts or does nothing.
    const rows = await this.em.execute(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       values (?, ?, ?, ?, ?)
       on conflict (consumer_name, message_id) do nothing
       returning message_id`,
      [
        message.consumerName,
        message.messageId,
        message.payloadHash,
        message.receivedAt.toISOString(),
        message.processedAt?.toISOString() ?? null,
      ],
    );
    return rows.length === 1;
  }

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const record = await this.em.findOne(InboxMessageEntity, { consumerName, messageId }, { disableIdentityMap: true });
    return record === null ? undefined : toInboxMessage(record);
  }

  async saveProcessed(message: InboxMessage): Promise<void> {
    const updated = await this.em.nativeUpdate(
      InboxMessageEntity,
      { consumerName: message.consumerName, messageId: message.messageId, processedAt: null },
      { processedAt: message.processedAt ?? null },
    );
    if (updated !== 1) {
      throw new Error(`Inbox message ${message.messageId} was not found unprocessed to mark it processed`);
    }
  }
}
