import { Money } from '../../../domain/money/money.js';
import { Wallet } from '../../../domain/wallet/wallet.js';
import type { WalletRecord } from '../entities/wallet.entity.js';

/** Row -> domain. Uses rehydrate: what is stored is not validated again (spec 6.0). */
export function toWallet(record: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: record.id,
    playerId: record.playerId,
    currency: record.currency,
    balance: Money.from({ amount: record.balanceAmount, currency: record.currency }),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function toWalletRecord(wallet: Wallet): WalletRecord {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balanceAmount: wallet.balance.amount,
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}
