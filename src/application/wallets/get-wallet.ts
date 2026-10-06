import { WalletNotFoundError } from '../errors.js';
import type { TransactionRunner } from '../ports/transaction-runner.js';
import { toWalletView, type WalletView } from './wallet-view.js';

/** GET /wallets/:walletId. A plain read: no lock, it returns the last committed balance. */
export class GetWallet {
  constructor(private readonly runner: TransactionRunner) {}

  async execute(walletId: string): Promise<WalletView> {
    const wallet = await this.runner.run((repositories) => repositories.wallets.findById(walletId));
    if (wallet === undefined) {
      throw new WalletNotFoundError(walletId);
    }
    return toWalletView(wallet);
  }
}
