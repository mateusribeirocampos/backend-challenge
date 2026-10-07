import type { MoneyProps } from '../../domain/money/money.js';
import type { LedgerDirection, WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry.js';
import { WalletNotFoundError } from '../errors.js';
import type { TransactionRunner } from '../ports/transaction-runner.js';

export interface LedgerPageQuery {
  readonly walletId: string;
  /** Continue after this wallet_version; undefined = from the first entry. */
  readonly afterVersion: number | undefined;
  readonly limit: number;
}

/** One line of the ledger as the API shows it (spec 9). Money as MoneyProps strings. */
export interface LedgerEntryView {
  readonly id: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: MoneyProps;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
  readonly walletVersion: number;
  readonly createdAt: string;
}

export interface LedgerPage {
  readonly walletId: string;
  readonly entries: readonly LedgerEntryView[];
  /** wallet_version to continue after; undefined when this page reached the end. */
  readonly nextAfterVersion: number | undefined;
}

/**
 * GET /wallets/:walletId/ledger. Keyset pagination on wallet_version: each page is "the
 * entries after version n", which never changes for entries already written (the ledger
 * is append-only and the versions have no gap), so pages concatenate with no gap and no
 * duplicate even while new entries arrive.
 */
export class GetWalletLedger {
  constructor(private readonly runner: TransactionRunner) {}

  async execute(query: LedgerPageQuery): Promise<LedgerPage> {
    const { walletExists, entries } = await this.runner.run(async (repositories) => {
      const wallet = await repositories.wallets.findById(query.walletId);
      if (wallet === undefined) {
        return { walletExists: false, entries: [] };
      }
      // One more than asked: if it comes back, there is a next page.
      const found = await repositories.ledger.listAfterVersion(query.walletId, query.afterVersion ?? 0, query.limit + 1);
      return { walletExists: true, entries: found };
    });
    if (!walletExists) {
      throw new WalletNotFoundError(query.walletId);
    }
    const page = entries.slice(0, query.limit);
    const hasMore = entries.length > query.limit;
    return {
      walletId: query.walletId,
      entries: page.map(toLedgerEntryView),
      nextAfterVersion: hasMore ? page.at(-1)?.walletVersion : undefined,
    };
  }
}

function toLedgerEntryView(entry: WalletLedgerEntry): LedgerEntryView {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    walletVersion: entry.walletVersion,
    createdAt: entry.createdAt.toISOString(),
  };
}
