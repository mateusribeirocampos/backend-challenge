import type { EntityManager } from '@mikro-orm/postgresql';
import type { WagerTransactionRepository } from '../../../application/ports/repositories.js';
import { WagerTransactionKind } from '../../../domain/wager/wager-transaction-kind.js';
import { WagerTransactionStatus } from '../../../domain/wager/wager-transaction-status.js';
import type { WagerTransaction } from '../../../domain/wager/wager-transaction.js';
import { WagerTransactionEntity } from '../entities/wager-transaction.entity.js';
import {
  toOutcomeColumns,
  toWagerTransaction,
  toWagerTransactionRecord,
} from '../mappers/wager-transaction.mapper.js';

const FRESH = { disableIdentityMap: true } as const;

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async insertIfAbsent(transaction: WagerTransaction): Promise<boolean> {
    const record = toWagerTransactionRecord(transaction);
    // Insert-first (ADR-003), in one statement:
    //   - ON CONFLICT DO NOTHING (no target) covers both unique keys: idempotency_key
    //     and (provider_id, external_transaction_id). If another transaction is inserting
    //     the same key right now, this statement waits for it to commit or roll back.
    //   - WHERE EXISTS skips the insert when the wallet does not exist, instead of a
    //     foreign key error that would abort the SQL transaction.
    // INSERT ... SELECT does not infer parameter types from the target columns, hence the casts.
    const rows = await this.em.execute(
      `insert into wager_transactions (
         id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
         round_id, game_id, kind, amount, currency, reference_external_transaction_id, status,
         created_at, updated_at)
       select ?::uuid, ?, ?, ?, ?, ?::uuid, ?::uuid, ?, ?, ?, ?::numeric, ?, ?, ?, ?::timestamptz, ?::timestamptz
        where exists (select 1 from wallets where id = ?::uuid)
       on conflict do nothing
       returning id`,
      [
        record.id,
        record.providerId,
        record.externalTransactionId,
        record.idempotencyKey,
        record.payloadHash,
        record.walletId,
        record.playerId,
        record.roundId,
        record.gameId,
        record.kind,
        record.amount,
        record.currency,
        record.referenceExternalTransactionId,
        record.status,
        record.createdAt.toISOString(),
        record.updatedAt.toISOString(),
        record.walletId,
      ],
    );
    return rows.length === 1;
  }

  async insert(transaction: WagerTransaction): Promise<void> {
    await this.em.insert(WagerTransactionEntity, toWagerTransactionRecord(transaction));
  }

  async findById(transactionId: string): Promise<WagerTransaction | undefined> {
    return this.findOneBy({ id: transactionId });
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
    return this.findOneBy({ idempotencyKey });
  }

  async findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    return this.findOneBy({ providerId, externalTransactionId });
  }

  async hasProcessedReversal(transactionId: string): Promise<boolean> {
    const reversals = await this.em.count(WagerTransactionEntity, {
      referenceTransactionId: transactionId,
      status: WagerTransactionStatus.Processed,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
    });
    return reversals > 0;
  }

  async saveOutcome(
    transaction: WagerTransaction,
    options: { readonly nextReferenceCheckAt?: Date | undefined },
  ): Promise<void> {
    const updated = await this.em.nativeUpdate(
      WagerTransactionEntity,
      { id: transaction.id },
      { ...toOutcomeColumns(transaction), nextReferenceCheckAt: options.nextReferenceCheckAt ?? null },
    );
    if (updated !== 1) {
      throw new Error(`Transaction ${transaction.id} was not found to save its outcome`);
    }
  }

  private async findOneBy(
    where: { id: string } | { idempotencyKey: string } | { providerId: string; externalTransactionId: string },
  ): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionEntity, where, FRESH);
    return record === null ? undefined : toWagerTransaction(record);
  }
}
