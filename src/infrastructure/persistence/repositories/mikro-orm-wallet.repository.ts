import type { EntityManager } from '@mikro-orm/postgresql';
import { MetricName, type Metrics } from '../../../application/ports/metrics.js';
import type { WalletRepository } from '../../../application/ports/repositories.js';
import type { Wallet } from '../../../domain/wallet/wallet.js';
import { WalletEntity, type WalletRecord } from '../entities/wallet.entity.js';
import { toWallet, toWalletRecord } from '../mappers/wallet.mapper.js';

/** Reads never use the identity map: inside a transaction they must see the database, not a cached copy. */
const FRESH = { disableIdentityMap: true } as const;

export class MikroOrmWalletRepository implements WalletRepository {
  constructor(
    private readonly em: EntityManager,
    private readonly metrics: Metrics,
  ) {}

  async insertIfAbsent(wallet: Wallet): Promise<boolean> {
    const record = toWalletRecord(wallet);
    // Raw SQL because the ORM insert has no "do nothing on conflict". A concurrent
    // insert for the same player and currency waits on the unique index here and,
    // once the other one commits, returns no row instead of failing.
    const rows = await this.em.execute(
      `insert into wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?)
       on conflict (player_id, currency) do nothing
       returning id`,
      [
        record.id,
        record.playerId,
        record.currency,
        record.balanceAmount,
        record.version,
        record.createdAt.toISOString(),
        record.updatedAt.toISOString(),
      ],
    );
    return rows.length === 1;
  }

  async findById(walletId: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletEntity, { id: walletId }, FRESH);
    return record === null ? undefined : toWallet(record);
  }

  async lockById(walletId: string): Promise<Wallet | undefined> {
    // FOR NO KEY UPDATE, not FOR UPDATE (ADR-002). The INSERT of the transaction
    // already holds FOR KEY SHARE on this row through the foreign key; FOR UPDATE
    // conflicts with KEY SHARE and two different BETs on the same wallet would
    // deadlock. MikroORM's LockMode.PESSIMISTIC_WRITE emits FOR UPDATE, hence raw SQL.
    const rows = await this.timingLockWait(() =>
      this.em.execute(
        `select id, player_id, currency, balance_amount, version, created_at, updated_at
           from wallets
          where id = ?
            for no key update`,
        [walletId],
      ),
    );
    const [row] = rows;
    if (row === undefined) {
      return undefined;
    }
    return toWallet(this.em.map(WalletEntity, row, FRESH) as WalletRecord);
  }

  /** Observed on a lock timeout too: a 2 s wait that ended in 55P03 is still a wait. */
  private async timingLockWait<T>(lock: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    try {
      return await lock();
    } finally {
      this.metrics.observe(MetricName.WalletLockWait, (performance.now() - startedAt) / 1000);
    }
  }

  async saveBalance(wallet: Wallet, expectedVersion: number): Promise<void> {
    // "where version = expectedVersion" is a second guard: under the lock it always
    // matches. If it ever does not, something wrote the row without the lock, and
    // failing here (rollback) is better than a lost update.
    const updated = await this.em.nativeUpdate(
      WalletEntity,
      { id: wallet.id, version: expectedVersion },
      { balanceAmount: wallet.balance.amount, version: wallet.version, updatedAt: wallet.updatedAt },
    );
    if (updated !== 1) {
      throw new Error(`Wallet ${wallet.id} was not at version ${expectedVersion}; refusing a lost update`);
    }
  }
}
