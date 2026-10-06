import type { WalletLedgerEntry } from '../../../domain/wallet/wallet-ledger-entry.js';
import type { WalletLedgerEntryRecord } from '../entities/wallet-ledger-entry.entity.js';

/** Domain -> row. The ledger is append-only, so there is no row -> domain path in this slice. */
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
