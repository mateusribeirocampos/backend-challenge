import { InboxMessage } from '../../domain/inbox/inbox-message.js';
import { Money } from '../../domain/money/money.js';
import { DomainInvariantError } from '../../domain/shared/domain-error.js';
import type { WagerTransactionKind } from '../../domain/wager/wager-transaction-kind.js';
import { WagerTransaction } from '../../domain/wager/wager-transaction.js';
import {
  ExternalTransactionIdConflictError,
  IdempotencyKeyConflictError,
  MessageIdConflictError,
  WalletNotFoundError,
} from '../errors.js';
import type { Clock } from '../ports/clock.js';
import type { IdGenerator } from '../ports/id-generator.js';
import type { Repositories } from '../ports/repositories.js';
import type { TransactionRunner } from '../ports/transaction-runner.js';
import { ApplyAndRecord } from './apply-and-record.js';
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

/** Which SQS message delivered the operation (spec 10). Not used by HTTP. */
export interface MessageDelivery {
  /** The logical consumer, the same on every instance (inbox key, part 1). */
  readonly consumerName: string;
  /** envelope.messageId, stable across redeliveries (inbox key, part 2). */
  readonly messageId: string;
  /** Hash of the envelope data: a redelivery has the same; a reused messageId does not. */
  readonly payloadHash: string;
}

export interface DeliveryResult {
  /** true: the inbox already had this message, so nothing was processed again. */
  readonly duplicateMessage: boolean;
  /** The stored result of the operation (a replay view when anything was a duplicate). */
  readonly result: WagerResultView;
}

/**
 * Processes one provider operation. The same code serves POST /wagering/transactions
 * (execute) and the SQS consumer (executeDelivery). Everything below runs in ONE SQL
 * transaction:
 *
 *   0. SQS only: INSERT the inbox row ... ON CONFLICT DO NOTHING
 *        - not inserted -> this message was already processed: answer, change nothing;
 *   1. insert-first: INSERT the PENDING row ... ON CONFLICT DO NOTHING
 *        - not inserted -> replay (same payload hash) or conflict (different hash);
 *   2 to 5. ApplyAndRecord: lock the wallet row, resolve the reference, apply the
 *      domain rules, write wallet, outcome, ledger entry and outbox events
 *      (SQS: then mark the inbox row processed);
 *   6. COMMIT (the runner). Any error before it rolls back all of the above, inbox included.
 */
export class ProcessWagerTransaction {
  private readonly applyAndRecord: ApplyAndRecord;

  constructor(
    private readonly runner: TransactionRunner,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {
    this.applyAndRecord = new ApplyAndRecord(clock, ids);
  }

  /** HTTP entry: the Idempotency-Key is the only deduplication. */
  async execute(command: ProcessWagerTransactionCommand): Promise<WagerResultView> {
    const transaction = this.newTransaction(command);
    return this.runner.run((repositories) => this.decide(repositories, transaction, command));
  }

  /**
   * SQS entry: the inbox row deduplicates the MESSAGE, the idempotency key the OPERATION.
   * Both are written in the same transaction as the effect, so a message that was
   * committed is never processed again, even if its ack never reached SQS.
   */
  async executeDelivery(command: ProcessWagerTransactionCommand, delivery: MessageDelivery): Promise<DeliveryResult> {
    const transaction = this.newTransaction(command);
    const inbox = InboxMessage.receive({ ...delivery, receivedAt: this.clock.now() });

    return this.runner.run(async (repositories) => {
      const isFirstDelivery = await repositories.inbox.insertIfAbsent(inbox);
      if (!isFirstDelivery) {
        return { duplicateMessage: true, result: await this.answerRedelivery(repositories, inbox, transaction) };
      }
      const result = await this.decide(repositories, transaction, command);
      inbox.markProcessed(this.clock.now());
      await repositories.inbox.saveProcessed(inbox);
      return { duplicateMessage: false, result };
    });
  }

  /** Contract checks run before any I/O: an invalid payload never opens a transaction. */
  private newTransaction(command: ProcessWagerTransactionCommand): WagerTransaction {
    return WagerTransaction.create({
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
  }

  /** Steps 1 to 5, inside the transaction the caller opened. */
  private async decide(
    repositories: Repositories,
    transaction: WagerTransaction,
    command: ProcessWagerTransactionCommand,
  ): Promise<WagerResultView> {
    const isNewOperation = await repositories.transactions.insertIfAbsent(transaction);
    if (!isNewOperation) {
      return this.answerExistingOperation(repositories, transaction);
    }
    await this.applyAndRecord.run(repositories, transaction, {
      correlationId: command.correlationId,
      causationId: command.causationId,
      lastReferenceCheck: false,
      referenceAttempts: 0,
      // Due right away: the PENDING_REFERENCE worker owns the backoff from there on.
      nextReferenceCheckAt: (at) => at,
    });
    return toWagerResultView(transaction, false);
  }

  /**
   * The inbox insert did not happen: the row was committed by an earlier delivery (if
   * that delivery was still running, the insert waited for its commit). Its effect is
   * committed too, so the answer is the stored result of the operation.
   */
  private async answerRedelivery(
    repositories: Repositories,
    inbox: InboxMessage,
    submitted: WagerTransaction,
  ): Promise<WagerResultView> {
    const stored = await repositories.inbox.find(inbox.consumerName, inbox.messageId);
    if (stored === undefined) {
      throw new DomainInvariantError(`Inbox message ${inbox.messageId} vanished after the insert`);
    }
    if (!stored.matchesPayload(inbox.payloadHash)) {
      throw new MessageIdConflictError(inbox.consumerName, inbox.messageId);
    }
    // Same data means the same idempotency key, and the inbox row only commits together
    // with an operation stored under that key.
    const operation = await repositories.transactions.findByIdempotencyKey(submitted.providerId, submitted.idempotencyKey);
    if (operation === undefined) {
      throw new DomainInvariantError(`Inbox message ${inbox.messageId} has no operation ${submitted.idempotencyKey}`);
    }
    return toWagerResultView(operation, true);
  }

  /**
   * The insert did not happen. In READ COMMITTED, if another request was inserting the
   * same key, our INSERT waited for it to commit, so the row read here is final.
   */
  private async answerExistingOperation(
    repositories: Repositories,
    submitted: WagerTransaction,
  ): Promise<WagerResultView> {
    const sameKey = await repositories.transactions.findByIdempotencyKey(submitted.providerId, submitted.idempotencyKey);
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
}
