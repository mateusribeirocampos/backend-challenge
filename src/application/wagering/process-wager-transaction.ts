import type { EventContext } from '../../domain/events/integration-event.js';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../domain/events/wagering-events.js';
import { Money } from '../../domain/money/money.js';
import { OutboxMessage } from '../../domain/outbox/outbox-message.js';
import { DomainInvariantError } from '../../domain/shared/domain-error.js';
import { applyWagerTransaction, type WagerOutcome } from '../../domain/wager/apply-wager-transaction.js';
import { WagerTransactionStatus } from '../../domain/wager/wager-transaction-status.js';
import { WagerTransaction } from '../../domain/wager/wager-transaction.js';
import type { WagerTransactionKind } from '../../domain/wager/wager-transaction-kind.js';
import type { Wallet } from '../../domain/wallet/wallet.js';
import {
  ExternalTransactionIdConflictError,
  IdempotencyKeyConflictError,
  WalletNotFoundError,
} from '../errors.js';
import type { Clock } from '../ports/clock.js';
import type { IdGenerator } from '../ports/id-generator.js';
import type { Repositories } from '../ports/repositories.js';
import type { TransactionRunner } from '../ports/transaction-runner.js';
import { computePayloadHash, type WagerPayload } from './payload-hash.js';
import { toWagerResultView, type WagerResultView } from './wager-transaction-views.js';

export interface ProcessWagerTransactionCommand extends WagerPayload {
  readonly kind: WagerTransactionKind;
  /** The Idempotency-Key header (HTTP) or data.idempotencyKey (SQS): the source of truth. */
  readonly idempotencyKey: string;
  readonly correlationId: string;
  /** The SQS messageId that caused this processing. undefined for HTTP. */
  readonly causationId?: string | undefined;
}

/**
 * Processes one provider operation. Shared by POST /wagering/transactions and, later,
 * by the SQS consumer. Everything below runs in ONE SQL transaction (ADR-002, ADR-003):
 *
 *   1. insert-first: INSERT the PENDING row ... ON CONFLICT DO NOTHING
 *        - not inserted -> replay (same payload hash) or conflict (different hash);
 *   2. lock the wallet row: SELECT ... FOR NO KEY UPDATE (lock_timeout 2s);
 *   3. resolve the reference and whether it was already reversed;
 *   4. applyWagerTransaction (pure domain rules);
 *   5. write wallet, transaction outcome, ledger entry and outbox events;
 *   6. COMMIT (the runner). Any error before it rolls back all of the above.
 */
export class ProcessWagerTransaction {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: ProcessWagerTransactionCommand): Promise<WagerResultView> {
    // Contract checks run before any I/O: an invalid payload never opens a transaction.
    const transaction = WagerTransaction.create({
      id: this.ids.newId(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash: computePayloadHash(command),
      walletId: command.walletId.toLowerCase(),
      playerId: command.playerId.toLowerCase(),
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: Money.from(command.money),
      referenceExternalTransactionId: command.referenceExternalTransactionId ?? undefined,
      createdAt: this.clock.now(),
    });

    return this.runner.run(async (repositories) => {
      const isNewOperation = await repositories.transactions.insertIfAbsent(transaction);
      if (!isNewOperation) {
        return this.answerExistingOperation(repositories, transaction);
      }
      return this.process(repositories, transaction, command);
    });
  }

  private async process(
    repositories: Repositories,
    transaction: WagerTransaction,
    command: ProcessWagerTransactionCommand,
  ): Promise<WagerResultView> {
    // The insert above only happens when the wallet exists, and wallet_id is a foreign
    // key, so the wallet is there. From here on, every other request for this wallet waits.
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
    });

    // Write order follows the foreign keys: wallet, transaction, ledger entry, outbox.
    const ledgerEntry = outcome.status === WagerTransactionStatus.Processed ? outcome.ledgerEntry : undefined;
    if (ledgerEntry !== undefined) {
      await repositories.wallets.saveBalance(wallet, versionBeforeApply);
    }
    await repositories.transactions.saveOutcome(transaction, {
      // Due right away: the PENDING_REFERENCE worker owns the backoff from there on.
      nextReferenceCheckAt: transaction.status === WagerTransactionStatus.PendingReference ? at : undefined,
    });
    if (ledgerEntry !== undefined) {
      await repositories.ledger.append(ledgerEntry);
    }
    const context = (eventId: string): EventContext => ({
      eventId,
      correlationId: command.correlationId,
      causationId: command.causationId,
      occurredAt: at,
    });
    await repositories.outbox.add(this.eventsFor(outcome, transaction, wallet, context).map(OutboxMessage.enqueue));

    return toWagerResultView(transaction, false);
  }

  /**
   * The insert did not happen. In READ COMMITTED, if another request was inserting the
   * same key, our INSERT waited for it to commit, so the row read here is final.
   */
  private async answerExistingOperation(
    repositories: Repositories,
    submitted: WagerTransaction,
  ): Promise<WagerResultView> {
    const sameKey = await repositories.transactions.findByIdempotencyKey(submitted.idempotencyKey);
    if (sameKey !== undefined) {
      if (submitted.payloadHash !== undefined && sameKey.matchesPayload(submitted.payloadHash)) {
        return toWagerResultView(sameKey, true);
      }
      throw new IdempotencyKeyConflictError(submitted.idempotencyKey);
    }

    const sameOperation = await repositories.transactions.findByProviderAndExternalId(
      submitted.providerId,
      submitted.externalTransactionId,
    );
    if (sameOperation !== undefined) {
      throw new ExternalTransactionIdConflictError(submitted.providerId, submitted.externalTransactionId);
    }

    // Neither key existed, so the insert was skipped because the wallet does not exist.
    // Nothing is stored: wager_transactions.wallet_id is a foreign key.
    throw new WalletNotFoundError(submitted.walletId);
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

  /** Spec 11: Processed for any applied transaction; BalanceChanged only when a ledger entry exists. */
  private eventsFor(
    outcome: WagerOutcome,
    transaction: WagerTransaction,
    wallet: Wallet,
    context: (eventId: string) => EventContext,
  ) {
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
        return [WagerTransactionPendingReference.from(transaction, context(this.ids.newId()))];
    }
  }
}
