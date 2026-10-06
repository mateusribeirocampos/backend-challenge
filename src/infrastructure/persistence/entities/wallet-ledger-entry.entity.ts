import { defineEntity, type InferEntity, p } from '@mikro-orm/core';

/** Mapping of wallet_ledger_entries (append-only: only ever inserted). */
export const WalletLedgerEntryEntity = defineEntity({
  name: 'WalletLedgerEntryRecord',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: p.uuid().primary(),
    walletId: p.uuid(),
    transactionId: p.uuid(),
    direction: p.text(),
    amount: p.decimal('string'),
    currency: p.string(),
    balanceBefore: p.decimal('string'),
    balanceAfter: p.decimal('string'),
    walletVersion: p.integer(),
    createdAt: p.datetime(),
  },
});

export type WalletLedgerEntryRecord = InferEntity<typeof WalletLedgerEntryEntity>;
