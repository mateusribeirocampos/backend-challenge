import { describe, expect, test } from 'bun:test';
import { CheckConstraintViolationException } from '@mikro-orm/core';
import { LockContentionError } from '../../../src/application/errors.js';
import { errorSummaryText, summarizeError } from '../../../src/application/error-summary.js';

const MARKER = '987.65';

/** What pg raises for a CHECK violation: the SQL text and the failing row (with the amount) travel along. */
function checkViolation(): Error {
  const driverError = Object.assign(
    new Error(`update wallets set balance_amount = -${MARKER} - new row for relation "wallets" violates check constraint`),
    { code: '23514', constraint: 'wallets_balance_non_negative', detail: `Failing row contains (-${MARKER}).` },
  );
  return new CheckConstraintViolationException(driverError);
}

describe('summarizeError: what may be logged or shipped about an error (spec 12)', () => {
  test('a database error keeps class, SQLSTATE and constraint, never the message, detail or stack', () => {
    const summary = summarizeError(checkViolation());

    expect(summary).toEqual({
      errorClass: 'CheckConstraintViolationException',
      errorCode: '23514',
      constraint: 'wallets_balance_non_negative',
    });
    expect(JSON.stringify(summary)).not.toContain(MARKER);
  });

  test('a wrapped error also names its cause, so a 503 still says which SQLSTATE caused it', () => {
    const cause = Object.assign(new Error(`lock timeout on ${MARKER}`), { code: '55P03' });
    const error = new LockContentionError('Another transaction held the row', { cause });

    expect(summarizeError(error)).toEqual({
      errorClass: 'LockContentionError',
      errorCode: 'TRANSIENT_FAILURE',
      causeClass: 'Error',
      causeCode: '55P03',
    });
  });

  test('something thrown that is not an Error is reduced to its type', () => {
    expect(summarizeError(`amount ${MARKER}`)).toEqual({ errorClass: 'string' });
  });

  test('a code or constraint that is not a plain identifier is dropped: those fields cannot smuggle text', () => {
    const error = Object.assign(new Error('x'), { code: `bad code ${MARKER}`, constraint: `x" ${MARKER}` });

    expect(summarizeError(error)).toEqual({ errorClass: 'Error' });
  });

  test('errorSummaryText: one short line for a DLQ attribute', () => {
    expect(errorSummaryText(summarizeError(checkViolation()))).toBe(
      'CheckConstraintViolationException code=23514 constraint=wallets_balance_non_negative',
    );
  });
});
