import { defineEntity, type InferEntity, p } from '@mikro-orm/core';

/** Mapping of wager_transactions. Money columns are strings (numeric(20,2)). */
export const WagerTransactionEntity = defineEntity({
  name: 'WagerTransactionRecord',
  tableName: 'wager_transactions',
  properties: {
    id: p.uuid().primary(),
    providerId: p.text(),
    externalTransactionId: p.text(),
    idempotencyKey: p.text(),
    payloadHash: p.text().nullable(),
    walletId: p.uuid(),
    playerId: p.uuid(),
    roundId: p.text().nullable(),
    gameId: p.text().nullable(),
    kind: p.text(),
    amount: p.decimal('string'),
    currency: p.string(),
    referenceExternalTransactionId: p.text().nullable(),
    referenceTransactionId: p.uuid().nullable(),
    status: p.text(),
    failureCode: p.text().nullable(),
    resultBalanceAmount: p.decimal('string').nullable(),
    resultBalanceCurrency: p.string().nullable(),
    referenceAttempts: p.integer(),
    nextReferenceCheckAt: p.datetime().nullable(),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
    processedAt: p.datetime().nullable(),
  },
});

export type WagerTransactionRecord = InferEntity<typeof WagerTransactionEntity>;
