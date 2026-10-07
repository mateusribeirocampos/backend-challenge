import { describe, expect, test } from 'bun:test';
import { ContractViolationCode } from '../../../../src/domain/wager/failure-code.js';
import {
  commandOf,
  messageDataHash,
  parseWagerMessage,
  type WagerMessage,
} from '../../../../src/interfaces/messaging/wager-transaction-message.js';

/** The message of spec 10, as a producer would send it. */
function specMessage(overrides: Record<string, unknown> = {}, dataOverrides: Record<string, unknown> = {}) {
  return {
    messageId: 'msg-123',
    type: 'WagerTransactionRequested',
    occurredAt: '2026-07-29T15:00:00.000Z',
    data: {
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      idempotencyKey: 'provider-a:transaction-123',
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      ...dataOverrides,
    },
    ...overrides,
  };
}

function parsed(body: unknown): WagerMessage {
  const result = parseWagerMessage(JSON.stringify(body));
  if (!result.ok) throw new Error(`expected a valid message, got ${JSON.stringify(result.failure)}`);
  return result.message;
}

function failure(body: string) {
  const result = parseWagerMessage(body);
  if (result.ok) throw new Error('expected the message to be refused');
  return result.failure;
}

describe('parseWagerMessage: the envelope of spec 10', () => {
  test('the spec example becomes the same command HTTP builds, with the key taken from data.idempotencyKey', () => {
    const command = commandOf(parsed(specMessage()));

    expect(command).toEqual({
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      idempotencyKey: 'provider-a:transaction-123',
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      // No correlationId in the envelope: the messageId ties the logs and events together.
      correlationId: 'msg-123',
      causationId: 'msg-123',
    });
  });

  test('an optional correlationId in the envelope is carried to the command', () => {
    expect(commandOf(parsed(specMessage({ correlationId: 'corr-7' }))).correlationId).toBe('corr-7');
  });

  test('same normalization as HTTP: upper case UUIDs become lower case, a null reference is absent', () => {
    const message = parsed(
      specMessage({}, { walletId: '0192F291-27DD-7D3F-8071-5F8685DEEF37', referenceExternalTransactionId: null }),
    );

    expect(message.data.walletId).toBe('0192f291-27dd-7d3f-8071-5f8685deef37');
    expect('referenceExternalTransactionId' in commandOf(message)).toBe(false);
  });

  test.each([
    ['not JSON at all', '{"messageId": "msg-1", '],
    ['an empty body', ''],
  ])('%s is MALFORMED_JSON', (_case, body) => {
    expect(failure(body)).toEqual({ reason: 'MALFORMED_JSON', errorCode: 'MALFORMED_JSON', details: [] });
  });

  test.each([
    ['a JSON array', '[]'],
    ['a JSON string', '"hello"'],
    ['a JSON number', '42'],
  ])('%s is valid JSON but not an envelope: SCHEMA_INVALID', (_case, body) => {
    expect(failure(body).reason).toBe('SCHEMA_INVALID');
  });

  test.each<[string, Record<string, unknown>, Record<string, unknown>, string, ContractViolationCode]>([
    ['messageId missing', { messageId: undefined }, {}, 'messageId', ContractViolationCode.MissingField],
    ['a type this consumer does not handle', { type: 'WalletOpened' }, {}, 'type', ContractViolationCode.InvalidFormat],
    ['occurredAt that is not an ISO date', { occurredAt: 'yesterday' }, {}, 'occurredAt', ContractViolationCode.InvalidFormat],
    ['data.idempotencyKey missing', {}, { idempotencyKey: undefined }, 'data.idempotencyKey', ContractViolationCode.MissingField],
    ['a NUL in data.roundId', {}, { roundId: 'round\u0000987' }, 'data.roundId', ContractViolationCode.InvalidFormat],
    ['a control character in messageId', { messageId: 'msg\u0007123' }, {}, 'messageId', ContractViolationCode.InvalidFormat],
    ['OPENING, which is internal', {}, { kind: 'OPENING' }, 'data.kind', ContractViolationCode.InternalKindNotAllowed],
    ['amount as a JSON number', {}, { money: { amount: 25, currency: 'BRL' } }, 'data.money', ContractViolationCode.InvalidMoney],
    ['walletId that is not a UUID', {}, { walletId: 'wallet-1' }, 'data.walletId', ContractViolationCode.InvalidFormat],
  ])('%s is SCHEMA_INVALID with the same code HTTP would answer', (_case, overrides, dataOverrides, field, code) => {
    const result = failure(JSON.stringify(specMessage(overrides, dataOverrides)));

    expect(result.reason).toBe('SCHEMA_INVALID');
    expect(result.errorCode).toBe(code);
    expect(result.details).toContainEqual(expect.objectContaining({ field, code }));
  });
});

describe('messageDataHash: the inbox payload_hash', () => {
  // Fixed value, computed outside the code:
  // printf '%s' '<canonical JSON of the spec example data>' | sha256sum
  test('is sha256 of the canonical JSON of data (sorted keys, no whitespace)', () => {
    expect(messageDataHash(parsed(specMessage()))).toBe(
      'a0b23737e20f6776c26497494deed2206e9418b3fd3a9dc43203c34866b05244',
    );
  });

  test('transport fields are not part of it: another messageId or occurredAt gives the same hash', () => {
    const original = messageDataHash(parsed(specMessage()));

    expect(messageDataHash(parsed(specMessage({ messageId: 'msg-999', occurredAt: '2026-07-30T00:00:00.000Z' })))).toBe(
      original,
    );
  });

  test('the same data written differently ("25" vs "25.00", unknown fields) is the same message', () => {
    const original = messageDataHash(parsed(specMessage()));

    expect(messageDataHash(parsed(specMessage({}, { money: { amount: '25', currency: 'BRL' }, extra: 'x' })))).toBe(
      original,
    );
  });

  test('any change in data, including the idempotency key, changes the hash', () => {
    const original = messageDataHash(parsed(specMessage()));

    expect(messageDataHash(parsed(specMessage({}, { money: { amount: '26.00', currency: 'BRL' } })))).not.toBe(original);
    expect(messageDataHash(parsed(specMessage({}, { idempotencyKey: 'provider-a:other' })))).not.toBe(original);
  });
});
