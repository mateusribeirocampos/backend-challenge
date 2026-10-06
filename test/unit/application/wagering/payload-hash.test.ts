import { describe, expect, test } from 'bun:test';
import {
  canonicalJson,
  computePayloadHash,
  type WagerPayload,
} from '../../../../src/application/wagering/payload-hash.js';

/** The example of spec section 9. */
const PAYLOAD: WagerPayload = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

describe('canonicalJson', () => {
  test('sorts keys recursively and has no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: 'x', c: 'y' } })).toBe('{"a":{"c":"y","d":"x"},"b":1}');
  });

  test('the same object written in any key order gives the same text', () => {
    const one = { kind: 'BET', money: { currency: 'BRL', amount: '1.00' }, providerId: 'p' };
    const other = { providerId: 'p', money: { amount: '1.00', currency: 'BRL' }, kind: 'BET' };

    expect(canonicalJson(one)).toBe(canonicalJson(other));
  });

  test('undefined fields are left out, like JSON.stringify does', () => {
    expect(canonicalJson({ a: 'x', b: undefined })).toBe('{"a":"x"}');
  });
});

describe('computePayloadHash', () => {
  test('is sha256 hex of the canonical JSON of the business fields (pinned value)', () => {
    // Pinned with: printf '%s' '<canonical json>' | sha256sum. If this changes, every
    // stored payload_hash stops matching its replay: the algorithm is part of the contract.
    expect(canonicalJson({ ...PAYLOAD })).toBe(
      '{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET",' +
        '"money":{"amount":"25.00","currency":"BRL"},"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",' +
        '"providerId":"provider-a","roundId":"round-987","walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}',
    );
    expect(computePayloadHash(PAYLOAD)).toBe('629836932b79106b99523d06a1e7fa80689b0ea1e1c47aa3f0a5a2c87d0c4344');
  });

  test('key order of the submitted body does not matter', () => {
    const reordered: WagerPayload = {
      money: { currency: 'BRL', amount: '25.00' },
      kind: 'BET',
      gameId: 'fortune-chimp',
      roundId: 'round-987',
      walletId: PAYLOAD.walletId,
      playerId: PAYLOAD.playerId,
      externalTransactionId: 'transaction-123',
      providerId: 'provider-a',
    };

    expect(computePayloadHash(reordered)).toBe(computePayloadHash(PAYLOAD));
  });

  test('the amount is normalized: "25", "25.0" and "25.00" are the same operation', () => {
    const hash = computePayloadHash(PAYLOAD);

    expect(computePayloadHash({ ...PAYLOAD, money: { amount: '25', currency: 'BRL' } })).toBe(hash);
    expect(computePayloadHash({ ...PAYLOAD, money: { amount: '25.0', currency: 'BRL' } })).toBe(hash);
  });

  test('UUIDs are compared in lower case, as PostgreSQL stores them', () => {
    const upper = { ...PAYLOAD, walletId: PAYLOAD.walletId.toUpperCase(), playerId: PAYLOAD.playerId.toUpperCase() };

    expect(computePayloadHash(upper)).toBe(computePayloadHash(PAYLOAD));
  });

  test('a null reference is the same as no reference (JSON null and a missing field are one operation)', () => {
    expect(computePayloadHash({ ...PAYLOAD, referenceExternalTransactionId: null })).toBe(computePayloadHash(PAYLOAD));
  });

  test('the Idempotency-Key header and transport metadata are not part of the hash', () => {
    const withTransport = { ...PAYLOAD, idempotencyKey: 'provider-a:other-key', messageId: 'msg-1', occurredAt: 'x' };

    expect(computePayloadHash(withTransport)).toBe(computePayloadHash(PAYLOAD));
  });

  test.each([
    ['amount', { money: { amount: '25.01', currency: 'BRL' } }],
    ['currency', { money: { amount: '25.00', currency: 'USD' } }],
    ['kind', { kind: 'WIN' }],
    ['roundId', { roundId: 'round-988' }],
    ['walletId', { walletId: '0192f291-27dd-7d3f-8071-5f8685deef38' }],
    ['a reference that was absent', { referenceExternalTransactionId: 'bet-1' }],
  ])('a different %s gives a different hash', (_field, change) => {
    expect(computePayloadHash({ ...PAYLOAD, ...change })).not.toBe(computePayloadHash(PAYLOAD));
  });
});
