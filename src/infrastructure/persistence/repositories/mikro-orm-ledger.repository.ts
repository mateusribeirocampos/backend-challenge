import type { EntityManager } from '@mikro-orm/postgresql';
import type { LedgerRepository, ReconciliationTotals } from '../../../application/ports/repositories.js';
import { Money } from '../../../domain/money/money.js';
import type { WalletLedgerEntry } from '../../../domain/wallet/wallet-ledger-entry.js';
import { WalletLedgerEntryEntity } from '../entities/wallet-ledger-entry.entity.js';
import { toLedgerEntry, toLedgerEntryRecord } from '../mappers/wallet-ledger-entry.mapper.js';

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    // em.insert runs the INSERT now (no unit of work flush): the order of the calls in
    // the use case is the order the database sees, which the foreign keys need.
    await this.em.insert(WalletLedgerEntryEntity, toLedgerEntryRecord(entry));
  }

  async listAfterVersion(walletId: string, afterVersion: number, limit: number): Promise<WalletLedgerEntry[]> {
    // Served by the unique index (wallet_id, wallet_version): a range scan, not an OFFSET.
    const records = await this.em.find(
      WalletLedgerEntryEntity,
      { walletId, walletVersion: { $gt: afterVersion } },
      { orderBy: { walletVersion: 'asc' }, limit, disableIdentityMap: true },
    );
    return records.map(toLedgerEntry);
  }

  async reconciliationTotals(walletId: string): Promise<ReconciliationTotals | undefined> {
    // Sums in numeric (exact), returned as text: no float on the way. LEFT JOIN, so a
    // wallet with no entry still answers (0 and 0). A single statement sees a single
    // snapshot in READ COMMITTED, so no lock is needed and writers are never blocked.
    const rows = await this.em.execute<
      { stored: string; currency: string; credits: string; debits: string; entries: number }[]
    >(
      `select w.balance_amount::text as stored,
              w.currency,
              coalesce(sum(l.amount) filter (where l.direction = 'CREDIT'), 0)::text as credits,
              coalesce(sum(l.amount) filter (where l.direction = 'DEBIT'), 0)::text as debits,
              count(l.id)::int as entries
         from wallets w
         left join wallet_ledger_entries l on l.wallet_id = w.id
        where w.id = ?
        group by w.id`,
      [walletId],
    );
    const [row] = rows;
    if (row === undefined) {
      return undefined;
    }
    const money = (amount: string) => Money.from({ amount, currency: row.currency });
    return {
      storedBalance: money(row.stored),
      totalCredits: money(row.credits),
      totalDebits: money(row.debits),
      entries: row.entries,
    };
  }
}
