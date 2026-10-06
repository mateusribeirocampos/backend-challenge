import type { MoneyProps } from '../../domain/money/money.js';
import type { Wallet } from '../../domain/wallet/wallet.js';

/** What the API answers for a wallet (spec 9). */
export interface WalletView {
  readonly id: string;
  readonly playerId: string;
  readonly balance: MoneyProps;
  readonly version: number;
}

export function toWalletView(wallet: Wallet): WalletView {
  return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
}
