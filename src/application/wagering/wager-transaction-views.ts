import type { MoneyProps } from '../../domain/money/money.js';
import type { FailureCode } from '../../domain/wager/failure-code.js';
import type { WagerTransactionKind } from '../../domain/wager/wager-transaction-kind.js';
import type { WagerTransactionStatus } from '../../domain/wager/wager-transaction-status.js';
import type { WagerTransaction } from '../../domain/wager/wager-transaction.js';

/**
 * Answer to a submitted transaction (spec 9). Built ONLY from the stored row, so the
 * first answer and every replay have the same body; only idempotentReplay differs.
 * balance is the balance observed when the transaction was decided, not the current one.
 */
export interface WagerResultView {
  readonly transactionId: string;
  readonly status: WagerTransactionStatus;
  /** Absent while PENDING_REFERENCE, and when the wallet belongs to another player. */
  readonly balance?: MoneyProps;
  readonly failureCode?: FailureCode;
  readonly idempotentReplay: boolean;
}

export function toWagerResultView(transaction: WagerTransaction, idempotentReplay: boolean): WagerResultView {
  return {
    transactionId: transaction.id,
    status: transaction.status,
    ...(transaction.resultBalance === undefined ? {} : { balance: transaction.resultBalance.toJSON() }),
    ...(transaction.failureCode === undefined ? {} : { failureCode: transaction.failureCode }),
    idempotentReplay,
  };
}

/** Full transaction for the GET endpoints. Absent values are null, so the shape never changes. */
export interface WagerTransactionView {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string | null;
  readonly gameId: string | null;
  readonly kind: WagerTransactionKind;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId: string | null;
  readonly referenceTransactionId: string | null;
  readonly status: WagerTransactionStatus;
  readonly failureCode: FailureCode | null;
  readonly balance: MoneyProps | null;
  readonly createdAt: string;
  readonly processedAt: string | null;
}

export function toWagerTransactionView(transaction: WagerTransaction): WagerTransactionView {
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
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    status: transaction.status,
    failureCode: transaction.failureCode ?? null,
    balance: transaction.resultBalance?.toJSON() ?? null,
    createdAt: transaction.createdAt.toISOString(),
    processedAt: transaction.processedAt?.toISOString() ?? null,
  };
}
