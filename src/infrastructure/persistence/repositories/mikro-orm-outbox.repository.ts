import type { EntityManager } from '@mikro-orm/postgresql';
import type { OutboxRepository } from '../../../application/ports/repositories.js';
import type { OutboxMessage } from '../../../domain/outbox/outbox-message.js';
import { OutboxMessageEntity } from '../entities/outbox-message.entity.js';
import { toOutboxMessageRecord } from '../mappers/outbox-message.mapper.js';

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async add(messages: readonly OutboxMessage[]): Promise<void> {
    if (messages.length === 0) {
      return;
    }
    await this.em.insertMany(OutboxMessageEntity, messages.map(toOutboxMessageRecord));
  }
}
