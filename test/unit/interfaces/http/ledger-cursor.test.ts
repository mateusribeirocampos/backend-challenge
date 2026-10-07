import { describe, expect, test } from 'bun:test';
import { decodeLedgerCursor, encodeLedgerCursor } from '../../../../src/interfaces/http/ledger-cursor.js';
import { RequestValidationError } from '../../../../src/interfaces/http/request-validation.js';
import { parseLedgerQuery } from '../../../../src/interfaces/http/wallet.request.js';

function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

describe('ledger cursor', () => {
  test('round trip: the cursor after version 7 decodes back to 7', () => {
    expect(decodeLedgerCursor(encodeLedgerCursor(7))).toBe(7);
  });

  test('opaque: URL safe text, not the version itself', () => {
    const cursor = encodeLedgerCursor(7);

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cursor).not.toBe('7');
  });

  test.each([
    ['empty', ''],
    ['the bare version', '7'],
    ['not base64url', '***'],
    ['base64url of text that is not JSON', base64url('afterVersion=7')],
    ['another JSON shape', base64url('{"after":7}')],
    ['extra keys', base64url('{"afterVersion":7,"walletId":"x"}')],
    ['version 0', base64url('{"afterVersion":0}')],
    ['negative version', base64url('{"afterVersion":-1}')],
    ['fractional version', base64url('{"afterVersion":1.5}')],
    ['version as text', base64url('{"afterVersion":"7"}')],
    ['beyond the integers JSON keeps exact', base64url('{"afterVersion":9007199254740993}')],
    ['padded (not the form this API issues)', `${encodeLedgerCursor(7)}=`],
  ])('refuses %s', (_case, cursor) => {
    expect(decodeLedgerCursor(cursor)).toBeUndefined();
  });
});

describe('GET /wallets/:walletId/ledger query', () => {
  test('defaults: from the first entry, 50 per page', () => {
    expect(parseLedgerQuery({})).toEqual({ afterVersion: undefined, limit: 50 });
  });

  test('reads the cursor and a limit from 1 to 100', () => {
    expect(parseLedgerQuery({ cursor: encodeLedgerCursor(12), limit: '100' })).toEqual({ afterVersion: 12, limit: 100 });
    expect(parseLedgerQuery({ limit: '1' })).toEqual({ afterVersion: undefined, limit: 1 });
  });

  test.each(['0', '101', 'abc', '1.5', '-1', '', '007'])('limit %p is a 400 on the limit field', (limit) => {
    expect(() => parseLedgerQuery({ limit })).toThrow(RequestValidationError);
    try {
      parseLedgerQuery({ limit });
    } catch (error) {
      expect((error as RequestValidationError).details).toEqual([
        { field: 'limit', code: 'INVALID_FORMAT', message: 'must be an integer from 1 to 100' },
      ]);
    }
  });

  test('an invalid cursor is a 400 on the cursor field', () => {
    try {
      parseLedgerQuery({ cursor: 'garbage' });
      throw new Error('expected a RequestValidationError');
    } catch (error) {
      expect((error as RequestValidationError).details).toEqual([
        { field: 'cursor', code: 'INVALID_FORMAT', message: 'is not a cursor returned by this endpoint' },
      ]);
    }
  });

  test('a repeated parameter (?limit=1&limit=2) is refused, not guessed', () => {
    expect(() => parseLedgerQuery({ limit: ['1', '2'] })).toThrow(RequestValidationError);
  });
});
