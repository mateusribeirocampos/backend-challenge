import { Money } from '../../../domain/money/money.js';
import { type LedgerDirection, WalletLedgerEntry } from '../../../domain/wallet/wallet-ledger-entry.js';
import type { WalletLedgerEntryRecord } from '../entities/wallet-ledger-entry.entity.js';

/** Domain -> row. The ledger is append-only: this is only ever inserted. */
export function toLedgerEntryRecord(entry: WalletLedgerEntry): WalletLedgerEntryRecord {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    direction: entry.direction,
    amount: entry.money.amount,
    currency: entry.money.currency,
    balanceBefore: entry.balanceBefore.amount,
    balanceAfter: entry.balanceAfter.amount,
    walletVersion: entry.walletVersion,
    createdAt: entry.createdAt,
  };
}

/**
 * Row -> domain, with rehydrate: the database checked the entry on insert (CHECK on the
 * arithmetic, chain trigger), so it is not validated again (spec 6.0). direction comes
 * from a column restricted by a CHECK, hence the cast.
 */
export function toLedgerEntry(record: WalletLedgerEntryRecord): WalletLedgerEntry {
  const money = (amount: string) => Money.from({ amount, currency: record.currency });
  return WalletLedgerEntry.rehydrate({
    id: record.id,
    walletId: record.walletId,
    transactionId: record.transactionId,
    direction: record.direction as LedgerDirection,
    money: money(record.amount),
    balanceBefore: money(record.balanceBefore),
    balanceAfter: money(record.balanceAfter),
    walletVersion: record.walletVersion,
    createdAt: record.createdAt,
  });
}
