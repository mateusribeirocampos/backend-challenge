import type { EntityManager } from '@mikro-orm/postgresql';
import type { OutboxClaim, OutboxRepository } from '../../../application/ports/repositories.js';
import type { OutboxMessage } from '../../../domain/outbox/outbox-message.js';
import { OutboxMessageEntity, type OutboxMessageRecord } from '../entities/outbox-message.entity.js';
import { toOutboxMessage, toOutboxMessageRecord } from '../mappers/outbox-message.mapper.js';

const EVENT_COLUMNS = 'id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at';

/**
 * The claim of the outbox publisher, in one statement:
 *
 *   heads: wallets whose OLDEST unpublished event is due and not leased. That event is
 *          locked with FOR UPDATE SKIP LOCKED: two publishers claiming at the same time
 *          skip each other's rows instead of waiting, so they end up with different
 *          wallets. A wallet whose oldest event is leased, locked or waiting for a retry
 *          is left alone as a whole, which keeps its events in order.
 *   batch: those wallets' unpublished events, oldest first, up to the batch size.
 *   update: the lease (who: lease_token, until when: locked_until, database clock).
 *
 * sequence_number is the order the events were written (for one wallet, the commit
 * order, because they are written under the wallet lock).
 */
const CLAIM_SQL = `
  with heads as (
    select head.aggregate_id
      from outbox_messages head
     where head.published_at is null
       and head.next_attempt_at <= now()
       and (head.locked_until is null or head.locked_until < now())
       and not exists (
             select 1
               from outbox_messages earlier
              where earlier.aggregate_id = head.aggregate_id
                and earlier.published_at is null
                and earlier.sequence_number < head.sequence_number)
     order by head.sequence_number
     limit ?
     for update of head skip locked
  ),
  batch as (
    select event.id
      from outbox_messages event
      join heads on heads.aggregate_id = event.aggregate_id
     where event.published_at is null
     order by event.sequence_number
     limit ?
     for update of event
  )
  update outbox_messages
     set lease_token = ?::uuid,
         locked_until = now() + ?::int * interval '1 millisecond'
   where id in (select id from batch)
  returning ${EVENT_COLUMNS}, sequence_number::text as sequence_number`;

interface ClaimedRow extends Record<string, unknown> {
  readonly sequence_number: string;
}

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async add(messages: readonly OutboxMessage[]): Promise<void> {
    if (messages.length === 0) {
      return;
    }
    // One statement, in array order: the identity column numbers the events in the order the use case created them.
    await this.em.insertMany(OutboxMessageEntity, messages.map(toOutboxMessageRecord));
  }

  async claimBatch(claim: OutboxClaim): Promise<OutboxMessage[]> {
    const rows = await this.em.execute<ClaimedRow[]>(CLAIM_SQL, [claim.limit, claim.limit, claim.leaseToken, claim.leaseMs]);
    // RETURNING does not keep any order; the publisher needs the write order.
    const ordered = [...rows].sort((a, b) => compareSequence(a.sequence_number, b.sequence_number));
    return ordered.map((row) => toOutboxMessage(this.em.map(OutboxMessageEntity, row) as OutboxMessageRecord));
  }

  async markPublished(message: OutboxMessage): Promise<boolean> {
    // Not tied to the lease: the event went out, so it is published, whoever holds the lease now.
    const rows = await this.em.execute(
      `update outbox_messages
          set published_at = ?, locked_until = null, lease_token = null
        where id = ? and published_at is null
       returning id`,
      [message.publishedAt?.toISOString() ?? null, message.id],
    );
    return rows.length === 1;
  }

  async saveRetry(message: OutboxMessage, leaseToken: string): Promise<boolean> {
    // Only with our lease: if it ran out and another publisher took the event, that one decides.
    const rows = await this.em.execute(
      `update outbox_messages
          set attempts = ?, next_attempt_at = ?, locked_until = null, lease_token = null
        where id = ? and lease_token = ? and published_at is null
       returning id`,
      [message.attempts, message.nextAttemptAt.toISOString(), message.id, leaseToken],
    );
    return rows.length === 1;
  }

  async releaseLease(messageIds: readonly string[], leaseToken: string): Promise<number> {
    if (messageIds.length === 0) {
      return 0;
    }
    const placeholders = messageIds.map(() => '?').join(', ');
    const rows = await this.em.execute(
      `update outbox_messages
          set locked_until = null, lease_token = null
        where id in (${placeholders}) and lease_token = ? and published_at is null
       returning id`,
      [...messageIds, leaseToken],
    );
    return rows.length;
  }

  async oldestPendingOccurredAt(): Promise<Date | undefined> {
    const [row] = await this.em.execute<{ occurred_at: Date | string }[]>(
      'select occurred_at from outbox_messages where published_at is null order by sequence_number limit 1',
    );
    if (row === undefined) {
      return undefined;
    }
    return row.occurred_at instanceof Date ? row.occurred_at : new Date(row.occurred_at);
  }
}

/** bigint values as text: a shorter number is smaller; same length compares as text (no conversion to number). */
function compareSequence(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}
