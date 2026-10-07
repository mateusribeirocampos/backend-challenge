import { describe, expect, test } from 'bun:test';
import { Money } from '../../../../src/domain/money/money.js';
import { DomainInvariantError } from '../../../../src/domain/shared/domain-error.js';
import { ContractViolationCode, FailureCode } from '../../../../src/domain/wager/failure-code.js';
import { WagerTransactionKind } from '../../../../src/domain/wager/wager-transaction-kind.js';
import {
  ALLOWED_TRANSITIONS,
  WagerTransactionStatus,
} from '../../../../src/domain/wager/wager-transaction-status.js';
import {
  type CreateWagerTransactionProps,
  INTERNAL_PROVIDER_ID,
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  WagerTransaction,
  type WagerTransactionState,
} from '../../../../src/domain/wager/wager-transaction.js';
import { LedgerDirection } from '../../../../src/domain/wallet/wallet-ledger-entry.js';
import { AT, brl, LATER, submitProps, submitted } from '../support/domain-fixtures.js';

function createError(props: CreateWagerTransactionProps): InvalidWagerTransactionError {
  try {
    WagerTransaction.create(props);
  } catch (error) {
    if (error instanceof InvalidWagerTransactionError) return error;
    throw error;
  }
  throw new Error('expected WagerTransaction.create to throw');
}

/** REFUND and ROLLBACK cannot even be created without a reference. */
function referenceIfRequired(kind: WagerTransactionKind): { referenceExternalTransactionId?: string } {
  return kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback
    ? { referenceExternalTransactionId: 'b1' }
    : {};
}

const bet = () => submitted({ kind: WagerTransactionKind.Bet, money: brl('25.00'), externalTransactionId: 'b1' });

describe('WagerTransaction.create', () => {
  test('starts PENDING with no outcome yet', () => {
    const transaction = bet();

    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    expect(transaction.failureCode).toBeUndefined();
    expect(transaction.processedAt).toBeUndefined();
    expect(transaction.resultBalance).toBeUndefined();
    expect(transaction.isTerminal()).toBe(false);
  });

  test('refuses OPENING: it is internal (spec 6.3)', () => {
    const error = createError(
      submitProps({ kind: WagerTransactionKind.Opening, money: brl('10.00'), externalTransactionId: 'o1' }),
    );

    expect(error.code).toBe(ContractViolationCode.InternalKindNotAllowed);
  });

  test('refuses an unknown kind', () => {
    const props = submitProps({ kind: 'JACKPOT' as WagerTransactionKind, money: brl('1.00'), externalTransactionId: 'x' });

    expect(createError(props).code).toBe(ContractViolationCode.UnknownKind);
  });

  test('refuses the reserved provider id "internal"', () => {
    const props = { ...submitProps({ kind: WagerTransactionKind.Bet, money: brl('1.00'), externalTransactionId: 'x' }) };

    expect(createError({ ...props, providerId: INTERNAL_PROVIDER_ID }).code).toBe(ContractViolationCode.ReservedProviderId);
  });

  test.each([WagerTransactionKind.Refund, WagerTransactionKind.Rollback])('%s requires a reference (rule 1)', (kind) => {
    const error = createError(submitProps({ kind, money: brl('25.00'), externalTransactionId: 'r1' }));

    expect(error.code).toBe(ContractViolationCode.ReferenceRequired);
  });

  test('BET cannot reference another transaction', () => {
    const error = createError(
      submitProps({
        kind: WagerTransactionKind.Bet,
        money: brl('25.00'),
        externalTransactionId: 'b2',
        referenceExternalTransactionId: 'b1',
      }),
    );

    expect(error.code).toBe(ContractViolationCode.ReferenceNotAllowed);
  });

  test.each([WagerTransactionKind.Win, WagerTransactionKind.Loss])('%s may reference its BET or not', (kind) => {
    expect(() => submitted({ kind, money: brl('1.00'), externalTransactionId: 'w1' })).not.toThrow();
    expect(() =>
      submitted({ kind, money: brl('1.00'), externalTransactionId: 'w2', referenceExternalTransactionId: 'b1' }),
    ).not.toThrow();
  });

  test('a transaction cannot reference itself', () => {
    const error = createError(
      submitProps({
        kind: WagerTransactionKind.Refund,
        money: brl('25.00'),
        externalTransactionId: 'r1',
        referenceExternalTransactionId: 'r1',
      }),
    );

    expect(error.code).toBe(ContractViolationCode.SelfReference);
  });

  test.each([
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
    WagerTransactionKind.Rollback,
  ])('%s with amount 0.00 is refused: it must move the balance', (kind) => {
    const error = createError(
      submitProps({ kind, money: Money.zero('BRL'), externalTransactionId: 'z1', ...referenceIfRequired(kind) }),
    );

    expect(error.code).toBe(ContractViolationCode.InvalidAmount);
  });

  test('LOSS accepts amount 0.00 (informational, never moves the balance)', () => {
    const loss = submitted({ kind: WagerTransactionKind.Loss, money: Money.zero('BRL'), externalTransactionId: 'l1' });

    expect(loss.affectsBalance()).toBe(false);
  });

  test('a negative amount is refused for every kind', () => {
    const error = createError(
      submitProps({ kind: WagerTransactionKind.Loss, money: brl('1.00').negate(), externalTransactionId: 'n1' }),
    );

    expect(error.code).toBe(ContractViolationCode.InvalidAmount);
  });

  test.each(['id', 'providerId', 'externalTransactionId', 'idempotencyKey', 'payloadHash', 'walletId', 'playerId', 'roundId', 'gameId'])(
    'blank %s is refused',
    (field) => {
      const props = { ...submitProps({ kind: WagerTransactionKind.Bet, money: brl('1.00'), externalTransactionId: 'f1' }), [field]: '  ' };

      expect(createError(props).code).toBe(ContractViolationCode.MissingField);
    },
  );
});

describe('idempotency key namespace: the key must start with "{providerId}:"', () => {
  const base = submitProps({ kind: WagerTransactionKind.Bet, money: brl('1.00'), externalTransactionId: 'k1' });

  test('the default key and any other suffix inside the provider namespace are accepted', () => {
    expect(WagerTransaction.create({ ...base, idempotencyKey: 'provider-a:k1' }).idempotencyKey).toBe('provider-a:k1');
    expect(WagerTransaction.create({ ...base, idempotencyKey: 'provider-a:retry-batch-7' }).idempotencyKey).toBe(
      'provider-a:retry-batch-7',
    );
  });

  test.each([
    ['another provider namespace (provider-b squatting provider-a keys)', 'provider-b:k1'],
    ['the reserved internal namespace of OPENING', 'internal:opening-0192f291-27dd-7d3f-8071-5f8685deef37'],
    ['the provider id without the colon', 'provider-ak1'],
    ['only the prefix, nothing after it', 'provider-a:'],
    ['no namespace at all', 'k1'],
  ])('refused: %s', (_case, idempotencyKey) => {
    expect(createError({ ...base, idempotencyKey }).code).toBe(ContractViolationCode.IdempotencyKeyInvalid);
  });

  test('a providerId with ":" is refused: "a" and "a:b" would share the namespace "a:b:..."', () => {
    const error = createError({ ...base, providerId: 'provider:a', idempotencyKey: 'provider:a:k1' });

    expect(error.code).toBe(ContractViolationCode.InvalidFormat);
  });
});

describe('control characters: refused in every text field, whatever the entry point (HTTP or SQS)', () => {
  const base = submitProps({ kind: WagerTransactionKind.Win, money: brl('1.00'), externalTransactionId: 'c1' });
  type TextField = keyof Pick<
    CreateWagerTransactionProps,
    | 'providerId'
    | 'externalTransactionId'
    | 'idempotencyKey'
    | 'walletId'
    | 'playerId'
    | 'roundId'
    | 'gameId'
    | 'referenceExternalTransactionId'
  >;
  const textFields: TextField[] = [
    'providerId',
    'externalTransactionId',
    'idempotencyKey',
    'walletId',
    'playerId',
    'roundId',
    'gameId',
    'referenceExternalTransactionId',
  ];

  // U+0000 (NUL: PostgreSQL answers 08P01), U+0007 (stored silently before), U+001F and U+007F (the range limits).
  for (const character of ['\u0000', '\u0007', '\u001F', '\u007F']) {
    const visible = `U+${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`;

    test.each(textFields)(`%s with ${visible} is INVALID_FORMAT and names the field`, (field) => {
      const props: CreateWagerTransactionProps = { ...base, referenceExternalTransactionId: 'b1' };
      const value = `${props[field] ?? ''}${character}x`;
      // The key keeps its namespace, so only the control character can be the reason.
      const tampered = field === 'providerId' ? { providerId: value, idempotencyKey: `${value}:c1` } : { [field]: value };

      const error = createError({ ...props, ...tampered });

      expect(error.code).toBe(ContractViolationCode.InvalidFormat);
      expect(error.message).toContain(field);
    });
  }

  test('ordinary punctuation, accents and spaces inside a value are still accepted', () => {
    const transaction = WagerTransaction.create({ ...base, roundId: 'rodada 7: ação/ñ #1', gameId: 'fortune chimp ü' });

    expect(transaction.roundId).toBe('rodada 7: ação/ñ #1');
  });
});

describe('WagerTransaction.createOpening', () => {
  test('is born PROCESSED under provider "internal" with a key derived from the wallet', () => {
    const opening = WagerTransaction.createOpening({
      id: 'opening-tx',
      walletId: 'wallet-1',
      playerId: 'player-1',
      money: brl('1000.00'),
      at: AT,
    });

    expect(opening.kind).toBe(WagerTransactionKind.Opening);
    expect(opening.status).toBe(WagerTransactionStatus.Processed);
    expect(opening.providerId).toBe('internal');
    expect(opening.externalTransactionId).toBe('opening-wallet-1');
    expect(opening.idempotencyKey).toBe('internal:opening-wallet-1');
    expect(opening.processedAt).toEqual(AT);
    expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test('refuses a zero opening (a zero balance needs no OPENING)', () => {
    expect(() =>
      WagerTransaction.createOpening({ id: 'o', walletId: 'w', playerId: 'p', money: Money.zero('BRL'), at: AT }),
    ).toThrow(InvalidWagerTransactionError);
  });
});

describe('WagerTransaction transitions', () => {
  test('PENDING -> PROCESSED records reference, balance and time', () => {
    const transaction = bet();

    transaction.markProcessed({ referenceTransactionId: undefined, resultBalance: brl('75.00'), at: LATER });

    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.resultBalance?.amount).toBe('75.00');
    expect(transaction.processedAt).toEqual(LATER);
    expect(transaction.updatedAt).toEqual(LATER);
  });

  test('PENDING -> REJECTED records the failure code', () => {
    const transaction = bet();

    transaction.reject(FailureCode.InsufficientFunds, { resultBalance: brl('20.00'), at: LATER });

    expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(transaction.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(transaction.processedAt).toBeUndefined();
  });

  test('PENDING -> FAILED records the failure code', () => {
    const transaction = bet();

    transaction.fail(FailureCode.PermanentInfrastructureError, LATER);

    expect(transaction.status).toBe(WagerTransactionStatus.Failed);
    expect(transaction.failureCode).toBe(FailureCode.PermanentInfrastructureError);
  });

  test('PENDING -> PENDING_REFERENCE -> PROCESSED', () => {
    const transaction = bet();

    transaction.markPendingReference(AT);
    expect(transaction.status).toBe(WagerTransactionStatus.PendingReference);
    expect(transaction.isTerminal()).toBe(false);

    transaction.markProcessed({ referenceTransactionId: 'tx-b1', resultBalance: brl('1.00'), at: LATER });
    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
  });

  test('PENDING_REFERENCE cannot go to PENDING_REFERENCE again', () => {
    const transaction = bet();
    transaction.markPendingReference(AT);

    expect(() => transaction.markPendingReference(LATER)).toThrow(InvalidTransactionStateError);
  });

  const terminalStatuses = [
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
  ] as const;
  const transitions = {
    markProcessed: (transaction: WagerTransaction) =>
      transaction.markProcessed({ referenceTransactionId: undefined, resultBalance: brl('1.00'), at: LATER }),
    markPendingReference: (transaction: WagerTransaction) => transaction.markPendingReference(LATER),
    reject: (transaction: WagerTransaction) => transaction.reject(FailureCode.AmountMismatch, { at: LATER }),
    fail: (transaction: WagerTransaction) => transaction.fail(FailureCode.PermanentInfrastructureError, LATER),
  };

  for (const status of terminalStatuses) {
    for (const [name, transition] of Object.entries(transitions)) {
      test(`${status} is terminal: ${name} throws InvalidTransactionStateError and changes nothing`, () => {
        const transaction = rehydrated(status);

        expect(transaction.isTerminal()).toBe(true);
        expect(() => transition(transaction)).toThrow(InvalidTransactionStateError);
        expect(transaction.status).toBe(status);
        expect(transaction.updatedAt).toEqual(AT);
      });
    }
  }

  test('the transition table has no way out of a terminal status', () => {
    expect(ALLOWED_TRANSITIONS).toEqual({
      PENDING: ['PROCESSED', 'REJECTED', 'FAILED', 'PENDING_REFERENCE'],
      PENDING_REFERENCE: ['PROCESSED', 'REJECTED', 'FAILED'],
      PROCESSED: [],
      REJECTED: [],
      FAILED: [],
    });
  });

  test('rehydrate does not re-validate: a stored terminal row comes back as it is', () => {
    expect(rehydrated(WagerTransactionStatus.Rejected).status).toBe(WagerTransactionStatus.Rejected);
  });
});

describe('WagerTransaction queries', () => {
  test('matchesPayload: same hash is a replay, a divergent hash is a conflict', () => {
    const transaction = bet();

    expect(transaction.matchesPayload('a'.repeat(64))).toBe(true);
    expect(transaction.matchesPayload('b'.repeat(64))).toBe(false);
  });

  test('matchesPayload is always false for OPENING (no hash)', () => {
    const opening = WagerTransaction.createOpening({ id: 'o', walletId: 'w', playerId: 'p', money: brl('1.00'), at: AT });

    expect(opening.matchesPayload('')).toBe(false);
  });

  test('affectsBalance is false only for LOSS; requiresReference only for REFUND and ROLLBACK', () => {
    const make = (kind: WagerTransactionKind) =>
      submitted({ kind, money: brl('1.00'), externalTransactionId: `q-${kind}`, ...referenceIfRequired(kind) });

    expect(make(WagerTransactionKind.Bet).affectsBalance()).toBe(true);
    expect(make(WagerTransactionKind.Win).affectsBalance()).toBe(true);
    expect(make(WagerTransactionKind.Loss).affectsBalance()).toBe(false);
    expect(make(WagerTransactionKind.Refund).affectsBalance()).toBe(true);
    expect(make(WagerTransactionKind.Rollback).affectsBalance()).toBe(true);

    expect(make(WagerTransactionKind.Bet).requiresReference()).toBe(false);
    expect(make(WagerTransactionKind.Win).requiresReference()).toBe(false);
    expect(make(WagerTransactionKind.Refund).requiresReference()).toBe(true);
    expect(make(WagerTransactionKind.Rollback).requiresReference()).toBe(true);
  });

  test('ledgerDirectionFor: BET debits, WIN and REFUND credit', () => {
    expect(bet().ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(submitted({ kind: 'WIN', money: brl('1.00'), externalTransactionId: 'w' }).ledgerDirectionFor()).toBe(
      LedgerDirection.Credit,
    );
    expect(
      submitted({ kind: 'REFUND', money: brl('1.00'), externalTransactionId: 'r', referenceExternalTransactionId: 'b1' }).ledgerDirectionFor(),
    ).toBe(LedgerDirection.Credit);
  });

  test('ledgerDirectionFor: ROLLBACK is the inverse of its reference', () => {
    const rollback = submitted({ kind: 'ROLLBACK', money: brl('1.00'), externalTransactionId: 'rb', referenceExternalTransactionId: 'x' });
    const win = submitted({ kind: 'WIN', money: brl('1.00'), externalTransactionId: 'w' });
    const refund = submitted({ kind: 'REFUND', money: brl('1.00'), externalTransactionId: 'r', referenceExternalTransactionId: 'b1' });

    expect(rollback.ledgerDirectionFor(bet())).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
  });

  test('ledgerDirectionFor throws for LOSS and for a ROLLBACK without a valid reference', () => {
    const loss = submitted({ kind: 'LOSS', money: brl('1.00'), externalTransactionId: 'l' });
    const rollback = submitted({ kind: 'ROLLBACK', money: brl('1.00'), externalTransactionId: 'rb', referenceExternalTransactionId: 'x' });

    expect(() => loss.ledgerDirectionFor()).toThrow(DomainInvariantError);
    expect(() => rollback.ledgerDirectionFor()).toThrow(DomainInvariantError);
    expect(() => rollback.ledgerDirectionFor(loss)).toThrow(DomainInvariantError);
  });
});

function rehydrated(status: WagerTransactionStatus): WagerTransaction {
  const base = bet();
  const isProcessed = status === WagerTransactionStatus.Processed;
  const hasFailureCode = status === WagerTransactionStatus.Rejected || status === WagerTransactionStatus.Failed;
  const state: WagerTransactionState = {
    id: base.id,
    providerId: base.providerId,
    externalTransactionId: base.externalTransactionId,
    idempotencyKey: base.idempotencyKey,
    payloadHash: base.payloadHash,
    walletId: base.walletId,
    playerId: base.playerId,
    roundId: base.roundId,
    gameId: base.gameId,
    kind: base.kind,
    money: base.money,
    referenceExternalTransactionId: undefined,
    createdAt: AT,
    status,
    referenceTransactionId: undefined,
    failureCode: hasFailureCode ? FailureCode.InsufficientFunds : undefined,
    resultBalance: isProcessed ? brl('75.00') : undefined,
    processedAt: isProcessed ? AT : undefined,
    updatedAt: AT,
  };
  return WagerTransaction.rehydrate(state);
}

describe('WagerTransaction dates cannot be changed through a Date reference', () => {
  const instant = '2026-10-06T12:00:00.000Z';

  test('mutating the Date given in or read back does not move createdAt, updatedAt or processedAt', () => {
    const createdAt = new Date(instant);
    const processedAt = new Date(instant);
    const transaction = WagerTransaction.create({
      ...submitProps({ kind: WagerTransactionKind.Bet, money: brl('25.00'), externalTransactionId: 'ext-dates' }),
      createdAt,
    });
    transaction.markProcessed({ referenceTransactionId: undefined, resultBalance: brl('75.00'), at: processedAt });

    createdAt.setTime(0);
    processedAt.setTime(0);
    transaction.createdAt.setTime(0);
    transaction.updatedAt.setTime(0);
    transaction.processedAt?.setTime(0);

    expect([transaction.createdAt, transaction.updatedAt, transaction.processedAt].map((date) => date?.toISOString())).toEqual([
      instant,
      instant,
      instant,
    ]);
  });
});
