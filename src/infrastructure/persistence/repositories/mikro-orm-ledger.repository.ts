import type { EntityManager } from '@mikro-orm/postgresql';
import type { LedgerRepository } from '../../../application/ports/repositories.js';
import type { WalletLedgerEntry } from '../../../domain/wallet/wallet-ledger-entry.js';
import { WalletLedgerEntryEntity } from '../entities/wallet-ledger-entry.entity.js';
import { toLedgerEntryRecord } from '../mappers/wallet-ledger-entry.mapper.js';

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    // em.insert runs the INSERT now (no unit of work flush): the order of the calls in
    // the use case is the order the database sees, which the foreign keys need.
    await this.em.insert(WalletLedgerEntryEntity, toLedgerEntryRecord(entry));
  }
}
