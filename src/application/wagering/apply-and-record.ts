import type { EventContext } from '../../domain/events/integration-event.js';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../domain/events/wagering-events.js';
import { OutboxMessage } from '../../domain/outbox/outbox-message.js';
import { DomainInvariantError } from '../../domain/shared/domain-error.js';
import { applyWagerTransaction, type WagerOutcome } from '../../domain/wager/apply-wager-transaction.js';
import { WagerTransactionStatus } from '../../domain/wager/wager-transaction-status.js';
import type { WagerTransaction } from '../../domain/wager/wager-transaction.js';
import type { Wallet } from '../../domain/wallet/wallet.js';
import type { Clock } from '../ports/clock.js';
import type { IdGenerator } from '../ports/id-generator.js';
import type { Repositories } from '../ports/repositories.js';

export interface ApplyOptions {
  /** Goes into every event this run writes. */
  readonly correlationId: string;
  readonly causationId?: string | undefined;
  /** PENDING_REFERENCE worker only: this is the last check, a reference still missing is final. */
  readonly lastReferenceCheck: boolean;
  /** Stored as reference_attempts: how many times the worker has checked (0 for a new submission). */
  readonly referenceAttempts: number;
  /** When the worker should check again, used only if the outcome is (still) PENDING_REFERENCE. */
  readonly nextReferenceCheckAt: (at: Date) => Date;
}

/**
 * The decision path every wager transaction goes through, wherever it comes from (HTTP,
 * SQS, or the PENDING_REFERENCE worker). Runs inside the SQL transaction the caller
 * opened, after the transaction row exists:
 *
 *   1. lock the wallet row: SELECT ... FOR NO KEY UPDATE (lock_timeout 2s);
 *   2. resolve the reference and whether it was already reversed;
 *   3. applyWagerTransaction (pure domain rules);
 *   4. write wallet, transaction outcome, ledger entry and outbox events.
 *
 * Having one copy of this path is what guarantees that a REFUND resolved by the worker
 * follows exactly the rules of a REFUND submitted after its BET.
 */
export class ApplyAndRecord {
  constructor(
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async run(repositories: Repositories, transaction: WagerTransaction, options: ApplyOptions): Promise<WagerOutcome> {
    const statusBefore = transaction.status;
    // wallet_id is a foreign key, so the wallet exists. From here on, every other
    // operation on this wallet waits for this transaction.
    const wallet = await repositories.wallets.lockById(transaction.walletId);
    if (wallet === undefined) {
      throw new DomainInvariantError(`Wallet ${transaction.walletId} vanished after the insert`);
    }
    const versionBeforeApply = wallet.version;
    // Read after the lock: a request that waited for the lock gets a time after the one it waited for.
    const at = this.clock.now();
    const { reference, referenceAlreadyReversed } = await this.resolveReference(repositories, transaction);

    const outcome = applyWagerTransaction({
      wallet,
      transaction,
      reference,
      referenceAlreadyReversed,
      ledgerEntryId: this.ids.newId(),
      at,
      lastReferenceCheck: options.lastReferenceCheck,
    });

    // Write order follows the foreign keys: wallet, transaction, ledger entry, outbox.
    const ledgerEntry = outcome.status === WagerTransactionStatus.Processed ? outcome.ledgerEntry : undefined;
    if (ledgerEntry !== undefined) {
      await repositories.wallets.saveBalance(wallet, versionBeforeApply);
    }
    await repositories.transactions.saveOutcome(transaction, {
      referenceAttempts: options.referenceAttempts,
      nextReferenceCheckAt:
        outcome.status === WagerTransactionStatus.PendingReference ? options.nextReferenceCheckAt(at) : undefined,
    });
    if (ledgerEntry !== undefined) {
      await repositories.ledger.append(ledgerEntry);
    }
    const context = (eventId: string): EventContext => ({
      eventId,
      correlationId: options.correlationId,
      causationId: options.causationId,
      occurredAt: at,
    });
    const events = this.eventsFor(outcome, { transaction, wallet, statusBefore, context });
    await repositories.outbox.add(events.map(OutboxMessage.enqueue));
    return outcome;
  }

  /**
   * Spec 7 rule 2: the reference is looked up by (providerId, referenceExternalTransactionId).
   * Read under the wallet lock, so "already reversed?" cannot change before the commit
   * for references of this wallet (a reference of another wallet is rejected anyway).
   */
  private async resolveReference(
    repositories: Repositories,
    transaction: WagerTransaction,
  ): Promise<{ reference: WagerTransaction | undefined; referenceAlreadyReversed: boolean }> {
    const referenceExternalId = transaction.referenceExternalTransactionId;
    if (referenceExternalId === undefined) {
      return { reference: undefined, referenceAlreadyReversed: false };
    }
    const reference = await repositories.transactions.findByProviderAndExternalId(transaction.providerId, referenceExternalId);
    if (reference === undefined) {
      return { reference: undefined, referenceAlreadyReversed: false };
    }
    return { reference, referenceAlreadyReversed: await repositories.transactions.hasProcessedReversal(reference.id) };
  }

  /**
   * Spec 11: Processed for any applied transaction; BalanceChanged only when a ledger
   * entry exists; PendingReference only when the transaction STARTS waiting (a worker
   * check that finds nothing again changes nothing worth announcing).
   */
  private eventsFor(
    outcome: WagerOutcome,
    run: {
      transaction: WagerTransaction;
      wallet: Wallet;
      statusBefore: WagerTransactionStatus;
      context: (eventId: string) => EventContext;
    },
  ) {
    const { transaction, wallet, context } = run;
    switch (outcome.status) {
      case WagerTransactionStatus.Processed: {
        const processed = WagerTransactionProcessed.from(transaction, context(this.ids.newId()));
        if (outcome.ledgerEntry === undefined) {
          return [processed]; // LOSS: recorded, balance unchanged
        }
        return [processed, WalletBalanceChanged.from(wallet, outcome.ledgerEntry, context(this.ids.newId()))];
      }
      case WagerTransactionStatus.Rejected:
        return [WagerTransactionRejected.from(transaction, context(this.ids.newId()))];
      case WagerTransactionStatus.PendingReference:
        if (run.statusBefore === WagerTransactionStatus.PendingReference) {
          return [];
        }
        return [WagerTransactionPendingReference.from(transaction, context(this.ids.newId()))];
    }
  }
}
