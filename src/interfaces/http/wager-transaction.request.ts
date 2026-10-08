import { z } from 'zod';
import type { ProcessWagerTransactionCommand } from '../../application/wagering/process-wager-transaction.js';
import { ContractViolationCode } from '../../domain/wager/failure-code.js';
import { WagerTransactionKind } from '../../domain/wager/wager-transaction-kind.js';
import { moneySchema } from './money-schema.js';
import { parseRequest, RequestValidationError, requiredText, uuidField, type ValidationDetail, violation } from './request-validation.js';

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/** OPENING is internal (spec 6.3): a provider can send any kind but this one. */
const SUBMITTABLE_KINDS: readonly string[] = Object.values(WagerTransactionKind).filter(
  (kind) => kind !== WagerTransactionKind.Opening,
);

const kindField = z.string('is required').superRefine((kind, ctx) => {
  if (kind === WagerTransactionKind.Opening) {
    violation(ctx, ContractViolationCode.InternalKindNotAllowed, 'OPENING is internal and cannot be submitted');
  } else if (!SUBMITTABLE_KINDS.includes(kind)) {
    violation(ctx, ContractViolationCode.UnknownKind, `must be one of ${SUBMITTABLE_KINDS.join(', ')}`);
  }
}).transform((kind) => kind as WagerTransactionKind);

/**
 * Body of POST /wagering/transactions (spec 9). Shape and format only. The rules that
 * depend on several fields (REFUND needs a reference, BET cannot have one, amounts
 * per kind) are checked by WagerTransaction.create, so HTTP and SQS apply exactly the
 * same contract.
 */
export const submitWagerTransactionBody = z.object(
  {
    // An identifier, not free text: it is part of the unique keys and of every log line.
    providerId: requiredText(64).regex(/^[A-Za-z0-9._-]+$/, 'letters, digits, ".", "_" or "-" only'),
    externalTransactionId: requiredText(),
    playerId: uuidField,
    walletId: uuidField,
    roundId: requiredText(),
    gameId: requiredText(),
    kind: kindField,
    money: moneySchema,
    // JSON null and a missing field both mean "no reference" (and hash the same).
    referenceExternalTransactionId: requiredText()
      .nullish()
      .transform((reference) => reference ?? undefined),
  },
  'the body must be a JSON object',
);

const idempotencyKeyHeader = requiredText(255);

/** Validates header and body together, so one 400 lists every problem at once. */
export function toProcessCommand(
  body: unknown,
  idempotencyKey: string | undefined,
  correlationId: string,
): ProcessWagerTransactionCommand {
  const parsedBody = parseRequest(submitWagerTransactionBody, body);
  const parsedKey = parseRequest(idempotencyKeyHeader, idempotencyKey, IDEMPOTENCY_KEY_HEADER);

  const details: ValidationDetail[] = [
    ...(parsedKey.ok ? [] : parsedKey.details),
    ...(parsedBody.ok ? [] : parsedBody.details),
  ];
  if (!parsedBody.ok || !parsedKey.ok) {
    throw new RequestValidationError(details);
  }

  const { referenceExternalTransactionId, ...fields } = parsedBody.value;
  return {
    ...fields,
    ...(referenceExternalTransactionId === undefined ? {} : { referenceExternalTransactionId }),
    idempotencyKey: parsedKey.value,
    correlationId,
  };
}
