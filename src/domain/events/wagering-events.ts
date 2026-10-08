import type { MoneyProps } from '../money/money.js';
import { DomainInvariantError } from '../shared/domain-error.js';
import type { FailureCode } from '../wager/failure-code.js';
import type { WagerTransactionKind } from '../wager/wager-transaction-kind.js';
import { WagerTransactionStatus } from '../wager/wager-transaction-status.js';
import type { WagerTransaction } from '../wager/wager-transaction.js';
import type { Wallet } from '../wallet/wallet.js';
import type { LedgerDirection, WalletLedgerEntry } from '../wallet/wallet-ledger-entry.js';
import { type EventContext, IntegrationEvent } from './integration-event.js';

/**
 * The four events of spec 11. Every one uses the wallet id as aggregateId: the
 * publisher sends it as the SQS MessageGroupId, so the events of one wallet keep
 * their order and different wallets are published in parallel.
 *
 * Optional values are null (not missing) so every payload of a given type and
 * version has the same keys.
 */

/** Fields every transaction event repeats, so a consumer can act without another lookup. */
export interface TransactionEventFields {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string | null;
  readonly gameId: string | null;
  readonly kind: WagerTransactionKind;
  readonly money: MoneyProps;
}

export interface WagerTransactionProcessedData extends TransactionEventFields {
  readonly referenceTransactionId: string | null;
  /** Balance right after this transaction (the same value a replay returns). */
  readonly balance: MoneyProps;
  readonly processedAt: string;
}

export interface WagerTransactionRejectedData extends TransactionEventFields {
  readonly failureCode: FailureCode;
  readonly referenceTransactionId: string | null;
  /** null when the wallet belongs to another player: its balance is not revealed. */
  readonly balance: MoneyProps | null;
}

export interface WagerTransactionPendingReferenceData extends TransactionEventFields {
  readonly referenceExternalTransactionId: string;
}

export interface WalletBalanceChangedData {
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: MoneyProps;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
  readonly walletVersion: number;
}

/** Any applied transaction, LOSS and the internal OPENING included. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionProcessed {
    assertStatus(transaction, WagerTransactionStatus.Processed);
    const { resultBalance, processedAt } = transaction;
    if (resultBalance === undefined || processedAt === undefined) {
      throw new DomainInvariantError(`PROCESSED transaction ${transaction.id} has no result balance or processedAt`);
    }
    return new WagerTransactionProcessed({
      ...context,
      aggregateId: transaction.walletId,
      data: {
        ...transactionFields(transaction),
        referenceTransactionId: transaction.referenceTransactionId ?? null,
        balance: resultBalance.toJSON(),
        processedAt: processedAt.toISOString(),
      },
    });
  }
}

/** A business rule refused the transaction. Nothing moved. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionRejected {
    assertStatus(transaction, WagerTransactionStatus.Rejected);
    const { failureCode } = transaction;
    if (failureCode === undefined) {
      throw new DomainInvariantError(`REJECTED transaction ${transaction.id} has no failureCode`);
    }
    return new WagerTransactionRejected({
      ...context,
      aggregateId: transaction.walletId,
      data: {
        ...transactionFields(transaction),
        failureCode,
        referenceTransactionId: transaction.referenceTransactionId ?? null,
        balance: transaction.resultBalance?.toJSON() ?? null,
      },
    });
  }
}

/** The referenced transaction is missing or not finished; this one waits. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionPendingReference {
    assertStatus(transaction, WagerTransactionStatus.PendingReference);
    const reference = transaction.referenceExternalTransactionId;
    if (reference === undefined) {
      throw new DomainInvariantError(`PENDING_REFERENCE transaction ${transaction.id} names no reference`);
    }
    return new WagerTransactionPendingReference({
      ...context,
      aggregateId: transaction.walletId,
      data: { ...transactionFields(transaction), referenceExternalTransactionId: reference },
    });
  }
}

/** Only when the balance really changed: one per ledger entry. A LOSS or a rejection never emits it. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, context: EventContext): WalletBalanceChanged {
    if (entry.walletId !== wallet.id || entry.walletVersion !== wallet.version) {
      throw new DomainInvariantError(
        `Ledger entry ${entry.id} (wallet ${entry.walletId} v${entry.walletVersion}) is not the last movement of wallet ${wallet.id} v${wallet.version}`,
      );
    }
    return new WalletBalanceChanged({
      ...context,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}

function transactionFields(transaction: WagerTransaction): TransactionEventFields {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId ?? null,
    gameId: transaction.gameId ?? null,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
  };
}

function assertStatus(transaction: WagerTransaction, expected: WagerTransactionStatus): void {
  if (transaction.status !== expected) {
    throw new DomainInvariantError(`Transaction ${transaction.id} is ${transaction.status}, expected ${expected}`);
  }
}
