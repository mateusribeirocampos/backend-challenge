import type { Money } from '../../../../src/domain/money/money.js';
import {
  applyWagerTransaction,
  type WagerOutcome,
} from '../../../../src/domain/wager/apply-wager-transaction.js';
import { isReversal } from '../../../../src/domain/wager/wager-transaction-kind.js';
import { WagerTransactionStatus } from '../../../../src/domain/wager/wager-transaction-status.js';
import type { WagerTransaction } from '../../../../src/domain/wager/wager-transaction.js';
import type { Wallet } from '../../../../src/domain/wallet/wallet.js';
import type { WalletLedgerEntry } from '../../../../src/domain/wallet/wallet-ledger-entry.js';
import { LATER, PROVIDER_ID, type SubmitOptions, submitted } from './domain-fixtures.js';

/**
 * Plays transactions against one wallet the way Slice 2 will: resolve the reference
 * by (provider, external id), ask whether it was already reversed, apply, keep the
 * result. The lookups are an in-memory stand-in for the SQL queries, so the tests
 * exercise only the domain rules.
 */
export class WalletScenario {
  readonly transactions: WagerTransaction[] = [];
  readonly ledger: WalletLedgerEntry[] = [];
  private readonly openingBalance: Money;

  constructor(readonly wallet: Wallet) {
    this.openingBalance = wallet.balance;
  }

  /** Submits and applies in one go, like a request that finds everything it needs. */
  play(options: SubmitOptions): { transaction: WagerTransaction; outcome: WagerOutcome } {
    const transaction = this.add(options);
    return { transaction, outcome: this.apply(transaction) };
  }

  /** Stores a transaction without applying it (it stays PENDING). */
  add(options: SubmitOptions): WagerTransaction {
    const transaction = submitted(options);
    this.transactions.push(transaction);
    return transaction;
  }

  /**
   * Applies a stored transaction, e.g. a PENDING_REFERENCE one after its reference arrived.
   * lastReferenceCheck: the PENDING_REFERENCE worker's final check (ADR-008).
   */
  apply(transaction: WagerTransaction, options: { lastReferenceCheck?: boolean } = {}): WagerOutcome {
    const reference = this.find(transaction.referenceExternalTransactionId);
    const outcome = applyWagerTransaction({
      wallet: this.wallet,
      transaction,
      reference,
      referenceAlreadyReversed: reference !== undefined && this.isReversed(reference),
      ledgerEntryId: `entry-${this.ledger.length + 1}`,
      at: LATER,
      lastReferenceCheck: options.lastReferenceCheck ?? false,
    });
    if (outcome.status === WagerTransactionStatus.Processed && outcome.ledgerEntry !== undefined) {
      this.ledger.push(outcome.ledgerEntry);
    }
    return outcome;
  }

  /**
   * The invariant every test ends with (spec 13): the stored balance equals the
   * balance rebuilt from the ledger, and the entries form an unbroken chain.
   */
  assertBalanceMatchesLedger(): void {
    let rebuilt = this.openingBalance;
    for (const entry of this.ledger) {
      if (!entry.balanceBefore.equals(rebuilt) || !entry.isBalanced()) {
        throw new Error(`Ledger chain broken at ${entry.id}`);
      }
      rebuilt = rebuilt.add(entry.signedAmount());
    }
    if (!rebuilt.equals(this.wallet.balance)) {
      throw new Error(`Wallet has ${this.wallet.balance.toString()} but the ledger rebuilds ${rebuilt.toString()}`);
    }
  }

  private find(externalTransactionId: string | undefined): WagerTransaction | undefined {
    return this.transactions.find(
      (candidate) => candidate.providerId === PROVIDER_ID && candidate.externalTransactionId === externalTransactionId,
    );
  }

  private isReversed(reference: WagerTransaction): boolean {
    return this.transactions.some(
      (candidate) =>
        isReversal(candidate.kind) &&
        candidate.status === WagerTransactionStatus.Processed &&
        candidate.referenceTransactionId === reference.id,
    );
  }
}
