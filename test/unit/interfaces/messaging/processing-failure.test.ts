import { describe, expect, test } from 'bun:test';
import {
  ExternalTransactionIdConflictError,
  IdempotencyKeyConflictError,
  LockContentionError,
  MessageIdConflictError,
  TransientInfrastructureError,
  WalletNotFoundError,
} from '../../../../src/application/errors.js';
import { InvalidMoneyError } from '../../../../src/domain/money/money.js';
import { DomainInvariantError } from '../../../../src/domain/shared/domain-error.js';
import { ContractViolationCode } from '../../../../src/domain/wager/failure-code.js';
import { InvalidWagerTransactionError } from '../../../../src/domain/wager/wager-transaction.js';
import { classifyProcessingFailure } from '../../../../src/interfaces/messaging/processing-failure.js';

/** An error as the pg driver raises it: the SQLSTATE in `code`. */
function databaseError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * The table of spec 10 for errors (business outcomes are results, not errors, and are
 * acked): transient failures are retried later, permanent failures go to the DLQ right
 * away. The question behind each row: "can the SAME message succeed if it is delivered
 * again in a few seconds?"
 */
describe('classifyProcessingFailure', () => {
  test.each<[string, unknown, ReturnType<typeof classifyProcessingFailure>]>([
    [
      'database down (already translated by the transaction runner)',
      new TransientInfrastructureError('Database temporarily unavailable'),
      { kind: 'transient', errorCode: 'TRANSIENT_FAILURE' },
    ],
    [
      'lock timeout, deadlock, serialization failure that outlasted the in-process retries',
      new LockContentionError('Wallet row busy'),
      { kind: 'transient', errorCode: 'LOCK_CONTENTION' },
    ],
    [
      'wallet that does not exist yet: it may be created over HTTP in a moment; the redrive bounds the wait',
      new WalletNotFoundError('0192f291-27dd-7d3f-8071-5f8685deef37'),
      { kind: 'transient', errorCode: 'WALLET_NOT_FOUND' },
    ],
  ])('transient: %s', (_case, error, expected) => {
    expect(classifyProcessingFailure(error)).toEqual(expected);
  });

  test.each<[string, unknown, string, string]>([
    [
      'same idempotency key with another payload: SQS has no channel to answer 409, so the data is kept',
      new IdempotencyKeyConflictError('provider-a:tx-1'),
      'IDEMPOTENCY_KEY_CONFLICT',
      'IDEMPOTENCY_KEY_CONFLICT',
    ],
    [
      'externalTransactionId already used under another key: same reason',
      new ExternalTransactionIdConflictError('provider-a', 'tx-1'),
      'EXTERNAL_TRANSACTION_ID_CONFLICT',
      'EXTERNAL_TRANSACTION_ID_CONFLICT',
    ],
    [
      'a messageId reused for different data: the producer is broken',
      new MessageIdConflictError('wager-transactions', 'msg-1'),
      'MESSAGE_ID_CONFLICT',
      'MESSAGE_ID_CONFLICT',
    ],
    [
      'a contract rule of the domain (REFUND without reference, a field in the wrong shape...)',
      new InvalidWagerTransactionError(ContractViolationCode.ReferenceRequired, 'REFUND requires a reference'),
      'CONTRACT_VIOLATION',
      'REFERENCE_REQUIRED',
    ],
    [
      'money the domain refuses',
      new InvalidMoneyError('Invalid amount'),
      'CONTRACT_VIOLATION',
      'INVALID_MONEY',
    ],
    [
      'numeric overflow (22003): the same payload overflows again',
      databaseError('22003', 'numeric field overflow'),
      'UNEXPECTED_ERROR',
      '22003',
    ],
    [
      'protocol violation (08P01): a byte PostgreSQL refuses, not a lost connection',
      databaseError('08P01', 'invalid message format'),
      'UNEXPECTED_ERROR',
      '08P01',
    ],
    [
      'a constraint violation that escaped the use case (23505)',
      databaseError('23505', 'duplicate key value violates unique constraint'),
      'UNEXPECTED_ERROR',
      '23505',
    ],
    ['a broken domain invariant (a bug)', new DomainInvariantError('vanished'), 'UNEXPECTED_ERROR', 'DOMAIN_INVARIANT_VIOLATED'],
    ['a plain programming error', new TypeError('x is undefined'), 'UNEXPECTED_ERROR', 'TypeError'],
    ['something thrown that is not an Error', 'boom', 'UNEXPECTED_ERROR', 'UNKNOWN'],
  ])('permanent, straight to the DLQ: %s', (_case, error, reason, errorCode) => {
    const classified = classifyProcessingFailure(error);

    expect(classified).toEqual(expect.objectContaining({ kind: 'permanent', reason, errorCode }));
  });

  test('a permanent failure carries a short detail for the DLQ attributes', () => {
    const classified = classifyProcessingFailure(new MessageIdConflictError('wager-transactions', 'msg-1'));

    expect(classified).toEqual(
      expect.objectContaining({ detail: 'Message msg-1 was already handled by wager-transactions with different data' }),
    );
  });

  test('the detail is cut to 256 characters: a DLQ attribute, not a dump', () => {
    const classified = classifyProcessingFailure(new IdempotencyKeyConflictError(`provider-a:${'x'.repeat(1000)}`));

    expect(classified.kind === 'permanent' && classified.detail.length).toBe(256);
  });

  test('an unexpected error ships class, SQLSTATE and constraint, never its message (review point F)', () => {
    const error = Object.assign(databaseError('23514', 'update wallets set balance_amount = -987.65 - violates check'), {
      constraint: 'wallets_balance_non_negative',
    });

    const classified = classifyProcessingFailure(error);

    expect(classified).toEqual(
      expect.objectContaining({ errorCode: '23514', detail: 'Error code=23514 constraint=wallets_balance_non_negative' }),
    );
  });
});
