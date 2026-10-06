import { Money } from '../../../domain/money/money.js';
import type { FailureCode } from '../../../domain/wager/failure-code.js';
import type { WagerTransactionKind } from '../../../domain/wager/wager-transaction-kind.js';
import type { WagerTransactionStatus } from '../../../domain/wager/wager-transaction-status.js';
import { WagerTransaction } from '../../../domain/wager/wager-transaction.js';
import type { WagerTransactionRecord } from '../entities/wager-transaction.entity.js';

/**
 * Row -> domain. kind, status and failure_code come from columns the schema already
 * restricts (CHECK constraints), so the casts below do not need another check.
 */
export function toWagerTransaction(record: WagerTransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: record.id,
    providerId: record.providerId,
    externalTransactionId: record.externalTransactionId,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash ?? undefined,
    walletId: record.walletId,
    playerId: record.playerId,
    roundId: record.roundId ?? undefined,
    gameId: record.gameId ?? undefined,
    kind: record.kind as WagerTransactionKind,
    money: Money.from({ amount: record.amount, currency: record.currency }),
    referenceExternalTransactionId: record.referenceExternalTransactionId ?? undefined,
    createdAt: record.createdAt,
    status: record.status as WagerTransactionStatus,
    referenceTransactionId: record.referenceTransactionId ?? undefined,
    failureCode: (record.failureCode ?? undefined) as FailureCode | undefined,
    resultBalance: toResultBalance(record),
    processedAt: record.processedAt ?? undefined,
    updatedAt: record.updatedAt,
  });
}

/** The columns that change when the outcome is decided (status and result). */
export function toOutcomeColumns(transaction: WagerTransaction) {
  return {
    status: transaction.status,
    failureCode: transaction.failureCode ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    resultBalanceAmount: transaction.resultBalance?.amount ?? null,
    resultBalanceCurrency: transaction.resultBalance?.currency ?? null,
    processedAt: transaction.processedAt ?? null,
    updatedAt: transaction.updatedAt,
  };
}

export function toWagerTransactionRecord(transaction: WagerTransaction): WagerTransactionRecord {
  return {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    payloadHash: transaction.payloadHash ?? null,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId ?? null,
    gameId: transaction.gameId ?? null,
    kind: transaction.kind,
    amount: transaction.money.amount,
    currency: transaction.money.currency,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    referenceAttempts: 0,
    nextReferenceCheckAt: null,
    createdAt: transaction.createdAt,
    ...toOutcomeColumns(transaction),
  };
}

function toResultBalance(record: WagerTransactionRecord): Money | undefined {
  if (record.resultBalanceAmount === null || record.resultBalanceAmount === undefined) {
    return undefined;
  }
  return Money.from({ amount: record.resultBalanceAmount, currency: record.resultBalanceCurrency ?? record.currency });
}
