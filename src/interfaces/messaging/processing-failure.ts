import {
  ExternalTransactionIdConflictError,
  IdempotencyKeyConflictError,
  LockContentionError,
  MessageIdConflictError,
  TransientInfrastructureError,
  WalletNotFoundError,
} from '../../application/errors.js';
import { InvalidMoneyError } from '../../domain/money/money.js';
import { DomainError } from '../../domain/shared/domain-error.js';
import { InvalidWagerTransactionError } from '../../domain/wager/wager-transaction.js';

/** Why a message went to the DLQ. Sent as the "reason" attribute of the DLQ message. */
export const DeadLetterReason = {
  /** The body is not JSON. */
  MalformedJson: 'MALFORMED_JSON',
  /** JSON, but not a valid envelope or data (same rules as the HTTP body). */
  SchemaInvalid: 'SCHEMA_INVALID',
  /** Valid shape, refused by WagerTransaction.create (REFUND without reference, key namespace...). */
  ContractViolation: 'CONTRACT_VIOLATION',
  /** The producer reused a messageId for different data. */
  MessageIdConflict: 'MESSAGE_ID_CONFLICT',
  /** The idempotency key already belongs to another payload (the 409 of HTTP). */
  IdempotencyKeyConflict: 'IDEMPOTENCY_KEY_CONFLICT',
  /** The externalTransactionId already exists under another key (the other 409 of HTTP). */
  ExternalTransactionIdConflict: 'EXTERNAL_TRANSACTION_ID_CONFLICT',
  /** Anything else that is not transient: a bug, 22003, 08P01... */
  UnexpectedError: 'UNEXPECTED_ERROR',
} as const;
export type DeadLetterReason = (typeof DeadLetterReason)[keyof typeof DeadLetterReason];

/**
 * What to do with a message whose processing threw. (Business outcomes, REJECTED
 * included, are results and never reach this function.) The question is "can the SAME
 * message succeed if it is delivered again in a few seconds?"
 *   - transient: yes (lock timeout, database down, wallet not created yet). Leave it in
 *     the queue; the redrive policy bounds how long.
 *   - permanent: no. DLQ right away, with the reason, so the data is never lost.
 */
export type ProcessingFailure =
  | { readonly kind: 'transient'; readonly errorCode: string }
  | {
      readonly kind: 'permanent';
      readonly reason: DeadLetterReason;
      readonly errorCode: string;
      /** Short text for the DLQ attributes. */
      readonly detail: string;
    };

const MAX_DETAIL_LENGTH = 256;

export function classifyProcessingFailure(error: unknown): ProcessingFailure {
  // Database errors are transient only if the transaction runner translated them: the
  // runner is the one place that asks the database classifier. A payload error never is.
  if (error instanceof LockContentionError) {
    return { kind: 'transient', errorCode: 'LOCK_CONTENTION' };
  }
  if (error instanceof TransientInfrastructureError) {
    return { kind: 'transient', errorCode: error.code };
  }
  // The wallet may be created over HTTP a moment later: HTTP and SQS share no ordering.
  // The group is that wallet, so waiting blocks nobody else; the redrive bounds it.
  if (error instanceof WalletNotFoundError) {
    return { kind: 'transient', errorCode: error.code };
  }
  // Conflicts are final, but SQS has no response channel for a 409: acking would drop
  // the data. In the DLQ it stays visible and auditable.
  if (error instanceof IdempotencyKeyConflictError) {
    return permanent(DeadLetterReason.IdempotencyKeyConflict, error.code, error);
  }
  if (error instanceof ExternalTransactionIdConflictError) {
    return permanent(DeadLetterReason.ExternalTransactionIdConflict, error.code, error);
  }
  if (error instanceof MessageIdConflictError) {
    return permanent(DeadLetterReason.MessageIdConflict, error.code, error);
  }
  if (error instanceof InvalidWagerTransactionError || error instanceof InvalidMoneyError) {
    return permanent(DeadLetterReason.ContractViolation, error.code, error);
  }
  return permanent(DeadLetterReason.UnexpectedError, unexpectedErrorCode(error), error);
}

function permanent(reason: DeadLetterReason, errorCode: string, error: unknown): ProcessingFailure {
  const message = error instanceof Error ? error.message : String(error);
  return { kind: 'permanent', reason, errorCode, detail: message.slice(0, MAX_DETAIL_LENGTH) };
}

/** The SQLSTATE of a database error, the code of a domain error, or the error class name. */
function unexpectedErrorCode(error: unknown): string {
  if (error instanceof DomainError) {
    return error.code;
  }
  if (!(error instanceof Error)) {
    return 'UNKNOWN';
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code !== '' ? code : error.name;
}
