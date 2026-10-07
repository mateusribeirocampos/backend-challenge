import { describe, expect, test } from 'bun:test';
import { Money } from '../../../../src/domain/money/money.js';
import { DomainInvariantError } from '../../../../src/domain/shared/domain-error.js';
import { applyWagerTransaction, type WagerOutcome } from '../../../../src/domain/wager/apply-wager-transaction.js';
import { FailureCode } from '../../../../src/domain/wager/failure-code.js';
import { WagerTransactionStatus } from '../../../../src/domain/wager/wager-transaction-status.js';
import type { WagerTransaction } from '../../../../src/domain/wager/wager-transaction.js';
import { LedgerDirection } from '../../../../src/domain/wallet/wallet-ledger-entry.js';
import { AT, brl, LATER, OTHER_PLAYER_ID, usd, walletWith } from '../support/domain-fixtures.js';
import { WalletScenario } from '../support/wallet-scenario.js';

function scenarioWith(balance: string): WalletScenario {
  return new WalletScenario(walletWith(brl(balance)));
}

function expectProcessed(outcome: WagerOutcome, balance: string): void {
  expect(outcome).toMatchObject({ status: 'PROCESSED' });
  if (outcome.status === WagerTransactionStatus.Processed) expect(outcome.balance.amount).toBe(balance);
}

function expectRejected(outcome: WagerOutcome, failureCode: string, balance: string | undefined): void {
  expect(outcome).toMatchObject({ status: 'REJECTED', failureCode });
  if (outcome.status === WagerTransactionStatus.Rejected) expect(outcome.balance?.amount).toBe(balance);
}

describe('spec section 8 scenario at the domain level: balance 100.00, two bets of 80.00', () => {
  test('one PROCESSED, one REJECTED with INSUFFICIENT_FUNDS, balance 20.00, exactly one debit', () => {
    const scenario = scenarioWith('100.00');

    const first = scenario.play({ kind: 'BET', money: brl('80.00'), externalTransactionId: 'bet-1' });
    const second = scenario.play({ kind: 'BET', money: brl('80.00'), externalTransactionId: 'bet-2' });

    expectProcessed(first.outcome, '20.00');
    expectRejected(second.outcome, FailureCode.InsufficientFunds, '20.00');
    expect(second.transaction.status).toBe('REJECTED');
    expect(second.transaction.resultBalance?.amount).toBe('20.00');
    expect(scenario.ledger).toHaveLength(1);
    expect(scenario.ledger[0]?.direction).toBe(LedgerDirection.Debit);
    expect(scenario.wallet.balance.amount).toBe('20.00');
    expect(scenario.wallet.version).toBe(2);
    scenario.assertBalanceMatchesLedger();
  });
});

describe('BET', () => {
  test('debits and produces one DEBIT entry', () => {
    const scenario = scenarioWith('100.00');

    const { transaction, outcome } = scenario.play({ kind: 'BET', money: brl('25.00'), externalTransactionId: 'b1' });

    expectProcessed(outcome, '75.00');
    expect(transaction.status).toBe('PROCESSED');
    expect(transaction.processedAt).toEqual(LATER);
    expect(transaction.resultBalance?.amount).toBe('75.00');
    expect(scenario.ledger[0]).toMatchObject({ direction: 'DEBIT', transactionId: transaction.id, walletVersion: 2 });
    scenario.assertBalanceMatchesLedger();
  });

  test('a bet of exactly the balance is allowed', () => {
    const scenario = scenarioWith('25.00');

    expectProcessed(scenario.play({ kind: 'BET', money: brl('25.00'), externalTransactionId: 'b1' }).outcome, '0.00');
  });

  test('insufficient funds: REJECTED, balance and version unchanged, no ledger entry', () => {
    const scenario = scenarioWith('10.00');

    const { outcome } = scenario.play({ kind: 'BET', money: brl('10.01'), externalTransactionId: 'b1' });

    expectRejected(outcome, FailureCode.InsufficientFunds, '10.00');
    expect(scenario.wallet.version).toBe(1);
    expect(scenario.ledger).toHaveLength(0);
  });
});

describe('WIN', () => {
  test('credits without a reference', () => {
    const scenario = scenarioWith('75.00');

    expectProcessed(scenario.play({ kind: 'WIN', money: brl('50.00'), externalTransactionId: 'w1' }).outcome, '125.00');
    expect(scenario.ledger[0]?.direction).toBe(LedgerDirection.Credit);
    scenario.assertBalanceMatchesLedger();
  });

  test('credits with a reference to the BET of the round, keeping the resolved reference id', () => {
    const scenario = scenarioWith('100.00');
    const bet = scenario.play({ kind: 'BET', money: brl('25.00'), externalTransactionId: 'b1' }).transaction;

    const win = scenario.play({ kind: 'WIN', money: brl('60.00'), externalTransactionId: 'w1', referenceExternalTransactionId: 'b1' });

    expectProcessed(win.outcome, '135.00');
    expect(win.transaction.referenceTransactionId).toBe(bet.id);
    scenario.assertBalanceMatchesLedger();
  });

  test('a reference that is not a BET is REFERENCE_INVALID_KIND', () => {
    const scenario = scenarioWith('100.00');
    scenario.play({ kind: 'WIN', money: brl('5.00'), externalTransactionId: 'w0' });

    const { outcome } = scenario.play({ kind: 'WIN', money: brl('5.00'), externalTransactionId: 'w1', referenceExternalTransactionId: 'w0' });

    expectRejected(outcome, FailureCode.ReferenceInvalidKind, '105.00');
  });

  test('the referenced BET has not arrived yet: PENDING_REFERENCE', () => {
    const scenario = scenarioWith('100.00');

    const { transaction, outcome } = scenario.play({
      kind: 'WIN',
      money: brl('5.00'),
      externalTransactionId: 'w1',
      referenceExternalTransactionId: 'b-missing',
    });

    expect(outcome).toEqual({ status: 'PENDING_REFERENCE' });
    expect(transaction.status).toBe('PENDING_REFERENCE');
    expect(scenario.wallet.balance.amount).toBe('100.00');
  });
});

describe('LOSS', () => {
  test('PROCESSED without moving the balance and without a ledger entry', () => {
    const scenario = scenarioWith('75.00');

    const { transaction, outcome } = scenario.play({ kind: 'LOSS', money: brl('25.00'), externalTransactionId: 'l1' });

    expect(outcome).toEqual({ status: 'PROCESSED', ledgerEntry: undefined, balance: brl('75.00') });
    expect(transaction.resultBalance?.amount).toBe('75.00');
    expect(scenario.wallet.version).toBe(1);
    expect(scenario.ledger).toHaveLength(0);
  });

  test('a LOSS of 0.00 is accepted the same way', () => {
    const scenario = scenarioWith('75.00');

    expectProcessed(scenario.play({ kind: 'LOSS', money: Money.zero('BRL'), externalTransactionId: 'l1' }).outcome, '75.00');
    expect(scenario.wallet.version).toBe(1);
  });

  test('a LOSS may point to its BET', () => {
    const scenario = scenarioWith('100.00');
    const bet = scenario.play({ kind: 'BET', money: brl('25.00'), externalTransactionId: 'b1' }).transaction;

    const loss = scenario.play({ kind: 'LOSS', money: brl('25.00'), externalTransactionId: 'l1', referenceExternalTransactionId: 'b1' });

    expectProcessed(loss.outcome, '75.00');
    expect(loss.transaction.referenceTransactionId).toBe(bet.id);
  });
});

describe('REFUND', () => {
  test('credits the amount of the BET back', () => {
    const scenario = scenarioWith('100.00');
    scenario.play({ kind: 'BET', money: brl('25.00'), externalTransactionId: 'b1' });

    const { outcome } = scenario.play({ kind: 'REFUND', money: brl('25.00'), externalTransactionId: 'r1', referenceExternalTransactionId: 'b1' });

    expectProcessed(outcome, '100.00');
    expect(scenario.ledger.map((entry) => entry.direction)).toEqual(['DEBIT', 'CREDIT']);
    scenario.assertBalanceMatchesLedger();
  });

  test('only a BET can be refunded', () => {
    const scenario = scenarioWith('100.00');
    scenario.play({ kind: 'WIN', money: brl('25.00'), externalTransactionId: 'w1' });

    const { outcome } = scenario.play({ kind: 'REFUND', money: brl('25.00'), externalTransactionId: 'r1', referenceExternalTransactionId: 'w1' });

    expectRejected(outcome, FailureCode.ReferenceInvalidKind, '125.00');
  });

  test('a different amount is AMOUNT_MISMATCH (rule 5, no partial refund)', () => {
    const scenario = scenarioWith('100.00');
    scenario.play({ kind: 'BET', money: brl('25.00'), externalTransactionId: 'b1' });

    const { outcome } = scenario.play({ kind: 'REFUND', money: brl('20.00'), externalTransactionId: 'r1', referenceExternalTransactionId: 'b1' });

    expectRejected(outcome, FailureCode.AmountMismatch, '75.00');
    scenario.assertBalanceMatchesLedger();
  });
});

describe('ROLLBACK', () => {
  test('of a BET credits (inverse of the debit)', () => {
    const scenario = scenarioWith('100.00');
    scenario.play({ kind: 'BET', money: brl('25.00'), externalTransactionId: 'b1' });

    const { outcome } = scenario.play({ kind: 'ROLLBACK', money: brl('25.00'), externalTransactionId: 'rb1', referenceExternalTransactionId: 'b1' });

    expectProcessed(outcome, '100.00');
    expect(scenario.ledger[1]?.direction).toBe(LedgerDirection.Credit);
    scenario.assertBalanceMatchesLedger();
  });

  test('of a WIN debits (inverse of the credit)', () => {
    const scenario = scenarioWith('100.00');
    scenario.play({ kind: 'WIN', money: brl('40.00'), externalTransactionId: 'w1' });

    const { outcome } = scenario.play({ kind: 'ROLLBACK', money: brl('40.00'), externalTransactionId: 'rb1', referenceExternalTransactionId: 'w1' });

    expectProcessed(outcome, '100.00');
    expect(scenario.ledger[1]?.direction).toBe(LedgerDirection.Debit);
    scenario.assertBalanceMatchesLedger();
  });

  test('of a REFUND debits: this is how a provider undoes a refund', () => {
    const scenario = scenarioWith('100.00');
    scenario.play({ kind: 'BET', money: brl('25.00'), externalTransactionId: 'b1' });
    scenario.play({ kind: 'REFUND', money: brl('25.00'), externalTransactionId: 'r1', referenceExternalTransactionId: 'b1' });

    const { outcome } = scenario.play({ kind: 'ROLLBACK', money: brl('25.00'), externalTransactionId: 'rb1', referenceExternalTransactionId: 'r1' });

    expectProcessed(outcome, '75.00');
    scenario.assertBalanceMatchesLedger();
  });

  test('with a different amount is AMOUNT_MISMATCH (rule 5, no partial rollback)', () => {
    const scenario = scenarioWith('100.00');
    scenario.play({ kind: 'WIN', money: brl('40.00'), externalTransactionId: 'w1' });

    const { outcome } = scenario.play({ kind: 'ROLLBACK', money: brl('30.00'), externalTransactionId: 'rb1', referenceExternalTransactionId: 'w1' });

    expectRejected(outcome, FailureCode.AmountMismatch, '140.00');
    scenario.assertBalanceMatchesLedger();
  });

  test('of a WIN already spent is REVERSAL_WOULD_OVERDRAW, not INSUFFICIENT_FUNDS (rule 9)', () => {
    const scenario = scenarioWith('0.00');
    scenario.play({ kind: 'WIN', money: brl('50.00'), externalTransactionId: 'w1' });
    scenario.play({ kind: 'BET', money: brl('45.00'), externalTransactionId: 'b2' });

    const { transaction, outcome } = scenario.play({
      kind: 'ROLLBACK',
      money: brl('50.00'),
      externalTransactionId: 'rb1',
      referenceExternalTransactionId: 'w1',
    });

    expectRejected(outcome, FailureCode.ReversalWouldOverdraw, '5.00');
    expect(transaction.status).toBe('REJECTED');
    expect(scenario.wallet.balance.amount).toBe('5.00');
    scenario.assertBalanceMatchesLedger();
  });

  test.each([
    ['LOSS', { kind: 'LOSS', money: brl('25.00'), externalTransactionId: 'x1' }],
    ['ROLLBACK', { kind: 'ROLLBACK', money: brl('25.00'), externalTransactionId: 'x1', referenceExternalTransactionId: 'b1' }],
  ] as const)('of a %s is REFERENCE_INVALID_KIND', (_kind, referenceOptions) => {
    const scenario = scenarioWith('100.00');
    scenario.play({ kind: 'BET', money: brl('25.00'), externalTransactionId: 'b1' });
    scenario.play(referenceOptions);

    const { outcome } = scenario.play({ kind: 'ROLLBACK', money: brl('25.00'), externalTransactionId: 'rb2', referenceExternalTransactionId: 'x1' });

    expect(outcome).toMatchObject({ status: 'REJECTED', failureCode: FailureCode.ReferenceInvalidKind });
  });
});

describe('ADR-008: a transaction is reversed at most once, by any reversal kind', () => {
  test('balance 100, BET 25, REFUND, then ROLLBACK of the same BET: rejected, balance 100 and not 125', () => {
    const scenario = scenarioWith('100.00');
    const bet = scenario.play({ kind: 'BET', money: brl('25.00'), externalTransactionId: 'b1' });
    const refund = scenario.play({ kind: 'REFUND', money: brl('25.00'), externalTransactionId: 'r1', referenceExternalTransactionId: 'b1' });

    const rollback = scenario.play({ kind: 'ROLLBACK', money: brl('25.00'), externalTransactionId: 'rb1', referenceExternalTransactionId: 'b1' });

    expectProcessed(bet.outcome, '75.00');
    expectProcessed(refund.outcome, '100.00');
    expectRejected(rollback.outcome, FailureCode.ReferenceAlreadyReversed, '100.00');
    expect(rollback.transaction.referenceTransactionId).toBe(bet.transaction.id);
    expect(scenario.wallet.balance.amount).toBe('100.00');
    expect(scenario.ledger).toHaveLength(2);
    scenario.assertBalanceMatchesLedger();
  });

  test('the other order (ROLLBACK, then REFUND) is rejected the same way', () => {
    const scenario = scenarioWith('100.00');
    scenario.play({ kind: 'BET', money: brl('25.00'), externalTransactionId: 'b1' });
    scenario.play({ kind: 'ROLLBACK', money: brl('25.00'), externalTransactionId: 'rb1', referenceExternalTransactionId: 'b1' });

    const { outcome } = scenario.play({ kind: 'REFUND', money: brl('25.00'), externalTransactionId: 'r1', referenceExternalTransactionId: 'b1' });

    expectRejected(outcome, FailureCode.ReferenceAlreadyReversed, '100.00');
    scenario.assertBalanceMatchesLedger();
  });

  test('two REFUNDs of the same BET (spec rule 4): the second is rejected', () => {
    const scenario = scenarioWith('100.00');
    scenario.play({ kind: 'BET', money: brl('25.00'), externalTransactionId: 'b1' });
    scenario.play({ kind: 'REFUND', money: brl('25.00'), externalTransactionId: 'r1', referenceExternalTransactionId: 'b1' });

    const { outcome } = scenario.play({ kind: 'REFUND', money: brl('25.00'), externalTransactionId: 'r2', referenceExternalTransactionId: 'b1' });

    expectRejected(outcome, FailureCode.ReferenceAlreadyReversed, '100.00');
  });

  test('accepted limitation: after undoing a REFUND, the BET still counts as reversed', () => {
    const scenario = scenarioWith('100.00');
    scenario.play({ kind: 'BET', money: brl('25.00'), externalTransactionId: 'b1' });
    scenario.play({ kind: 'REFUND', money: brl('25.00'), externalTransactionId: 'r1', referenceExternalTransactionId: 'b1' });
    scenario.play({ kind: 'ROLLBACK', money: brl('25.00'), externalTransactionId: 'rb1', referenceExternalTransactionId: 'r1' });

    const { outcome } = scenario.play({ kind: 'ROLLBACK', money: brl('25.00'), externalTransactionId: 'rb2', referenceExternalTransactionId: 'b1' });

    expectRejected(outcome, FailureCode.ReferenceAlreadyReversed, '75.00');
    scenario.assertBalanceMatchesLedger();
  });
});

describe('a reversed BET cannot be settled', () => {
  test('WIN for a BET that was already refunded: REFERENCE_ALREADY_REVERSED, balance unchanged', () => {
    const scenario = scenarioWith('100.00');
    scenario.play({ kind: 'BET', money: brl('25.00'), externalTransactionId: 'b1' });
    scenario.play({ kind: 'REFUND', money: brl('25.00'), externalTransactionId: 'r1', referenceExternalTransactionId: 'b1' });

    const { outcome } = scenario.play({ kind: 'WIN', money: brl('60.00'), externalTransactionId: 'w1', referenceExternalTransactionId: 'b1' });

    expectRejected(outcome, FailureCode.ReferenceAlreadyReversed, '100.00');
    scenario.assertBalanceMatchesLedger();
  });

  test('LOSS for a BET that was already rolled back: REFERENCE_ALREADY_REVERSED', () => {
    const scenario = scenarioWith('100.00');
    scenario.play({ kind: 'BET', money: brl('25.00'), externalTransactionId: 'b1' });
    scenario.play({ kind: 'ROLLBACK', money: brl('25.00'), externalTransactionId: 'rb1', referenceExternalTransactionId: 'b1' });

    const { outcome } = scenario.play({ kind: 'LOSS', money: brl('25.00'), externalTransactionId: 'l1', referenceExternalTransactionId: 'b1' });

    expectRejected(outcome, FailureCode.ReferenceAlreadyReversed, '100.00');
  });

  test('the other way round is allowed: a BET with a settled WIN can still be refunded (the provider must also roll back the WIN)', () => {
    const scenario = scenarioWith('100.00');
    scenario.play({ kind: 'BET', money: brl('25.00'), externalTransactionId: 'b1' });
    scenario.play({ kind: 'WIN', money: brl('60.00'), externalTransactionId: 'w1', referenceExternalTransactionId: 'b1' });

    const refund = scenario.play({ kind: 'REFUND', money: brl('25.00'), externalTransactionId: 'r1', referenceExternalTransactionId: 'b1' });
    const rollbackOfWin = scenario.play({ kind: 'ROLLBACK', money: brl('60.00'), externalTransactionId: 'rb1', referenceExternalTransactionId: 'w1' });

    expectProcessed(refund.outcome, '160.00');
    expectProcessed(rollbackOfWin.outcome, '100.00');
    scenario.assertBalanceMatchesLedger();
  });
});

describe('reference must match provider, player, wallet, currency and round (rule 2)', () => {
  test('another round is REFERENCE_MISMATCH', () => {
    const scenario = scenarioWith('100.00');
    scenario.play({ kind: 'BET', money: brl('25.00'), externalTransactionId: 'b1', roundId: 'round-1' });

    const { outcome } = scenario.play({
      kind: 'REFUND',
      money: brl('25.00'),
      externalTransactionId: 'r1',
      referenceExternalTransactionId: 'b1',
      roundId: 'round-2',
    });

    expectRejected(outcome, FailureCode.ReferenceMismatch, '75.00');
  });

  test('another player is REFERENCE_MISMATCH', () => {
    const scenario = scenarioWith('100.00');
    processedReference(scenario.add({ kind: 'BET', money: brl('25.00'), externalTransactionId: 'b1', playerId: OTHER_PLAYER_ID }));

    const { outcome } = scenario.play({ kind: 'REFUND', money: brl('25.00'), externalTransactionId: 'r1', referenceExternalTransactionId: 'b1' });

    expectRejected(outcome, FailureCode.ReferenceMismatch, '100.00');
  });

  test('another wallet is REFERENCE_MISMATCH', () => {
    const scenario = scenarioWith('100.00');
    processedReference(scenario.add({ kind: 'BET', money: brl('25.00'), externalTransactionId: 'b1', walletId: 'other-wallet' }));

    const { outcome } = scenario.play({ kind: 'REFUND', money: brl('25.00'), externalTransactionId: 'r1', referenceExternalTransactionId: 'b1' });

    expectRejected(outcome, FailureCode.ReferenceMismatch, '100.00');
  });

  test('another currency is REFERENCE_MISMATCH', () => {
    const scenario = scenarioWith('100.00');
    processedReference(scenario.add({ kind: 'BET', money: usd('25.00'), externalTransactionId: 'b1' }));

    const { outcome } = scenario.play({ kind: 'REFUND', money: brl('25.00'), externalTransactionId: 'r1', referenceExternalTransactionId: 'b1' });

    expectRejected(outcome, FailureCode.ReferenceMismatch, '100.00');
  });
});

describe('reference status', () => {
  test('reference REJECTED: REFERENCE_NOT_PROCESSED (nothing to revert)', () => {
    const scenario = scenarioWith('10.00');
    scenario.play({ kind: 'BET', money: brl('25.00'), externalTransactionId: 'b1' });

    const { outcome } = scenario.play({ kind: 'REFUND', money: brl('25.00'), externalTransactionId: 'r1', referenceExternalTransactionId: 'b1' });

    expectRejected(outcome, FailureCode.ReferenceNotProcessed, '10.00');
    expect(scenario.wallet.balance.amount).toBe('10.00');
  });

  test('WIN pointing to a REJECTED BET: REFERENCE_NOT_PROCESSED (nothing to settle)', () => {
    const scenario = scenarioWith('10.00');
    scenario.play({ kind: 'BET', money: brl('25.00'), externalTransactionId: 'b1' });

    const { outcome } = scenario.play({ kind: 'WIN', money: brl('50.00'), externalTransactionId: 'w1', referenceExternalTransactionId: 'b1' });

    expectRejected(outcome, FailureCode.ReferenceNotProcessed, '10.00');
  });

  test('reference FAILED: REFERENCE_NOT_PROCESSED', () => {
    const scenario = scenarioWith('100.00');
    scenario.add({ kind: 'BET', money: brl('25.00'), externalTransactionId: 'b1' }).fail(FailureCode.PermanentInfrastructureError, AT);

    const { outcome } = scenario.play({ kind: 'REFUND', money: brl('25.00'), externalTransactionId: 'r1', referenceExternalTransactionId: 'b1' });

    expectRejected(outcome, FailureCode.ReferenceNotProcessed, '100.00');
  });

  test.each(['PENDING', 'PENDING_REFERENCE'] as const)('reference still %s: wait in PENDING_REFERENCE', (status) => {
    const scenario = scenarioWith('100.00');
    const bet = scenario.add({ kind: 'BET', money: brl('25.00'), externalTransactionId: 'b1' });
    if (status === 'PENDING_REFERENCE') bet.markPendingReference(AT);

    const { transaction, outcome } = scenario.play({ kind: 'REFUND', money: brl('25.00'), externalTransactionId: 'r1', referenceExternalTransactionId: 'b1' });

    expect(outcome).toEqual({ status: 'PENDING_REFERENCE' });
    expect(transaction.status).toBe('PENDING_REFERENCE');
  });

  test('payload errors are reported even while the reference is pending (wrong kind does not wait)', () => {
    const scenario = scenarioWith('100.00');
    scenario.add({ kind: 'WIN', money: brl('25.00'), externalTransactionId: 'w1' });

    const { outcome } = scenario.play({ kind: 'REFUND', money: brl('25.00'), externalTransactionId: 'r1', referenceExternalTransactionId: 'w1' });

    expect(outcome).toMatchObject({ status: 'REJECTED', failureCode: FailureCode.ReferenceInvalidKind });
  });
});

describe('reference out of order (spec 13, concurrency item 7, at the domain level)', () => {
  test('ROLLBACK before its BET waits, the BET arrives, the retry processes it', () => {
    const scenario = scenarioWith('100.00');

    const rollback = scenario.play({ kind: 'ROLLBACK', money: brl('25.00'), externalTransactionId: 'rb1', referenceExternalTransactionId: 'b1' });
    expect(rollback.outcome).toEqual({ status: 'PENDING_REFERENCE' });

    // A worker retry before the BET arrives keeps waiting, without an invalid transition.
    expect(scenario.apply(rollback.transaction)).toEqual({ status: 'PENDING_REFERENCE' });
    expect(rollback.transaction.status).toBe('PENDING_REFERENCE');

    expectProcessed(scenario.play({ kind: 'BET', money: brl('25.00'), externalTransactionId: 'b1' }).outcome, '75.00');
    expectProcessed(scenario.apply(rollback.transaction), '100.00');
    expect(rollback.transaction.status).toBe('PROCESSED');
    scenario.assertBalanceMatchesLedger();
  });
});

describe('the last reference check of the PENDING_REFERENCE worker (ADR-008)', () => {
  test('the reference never arrived: REJECTED with REFERENCE_NOT_FOUND, balance unchanged, no ledger entry', () => {
    const scenario = scenarioWith('100.00');
    const refund = scenario.play({ kind: 'REFUND', money: brl('25.00'), externalTransactionId: 'r1', referenceExternalTransactionId: 'b1' });

    const outcome = scenario.apply(refund.transaction, { lastReferenceCheck: true });

    expectRejected(outcome, FailureCode.ReferenceNotFound, '100.00');
    expect(refund.transaction.status).toBe('REJECTED');
    expect(refund.transaction.referenceTransactionId).toBeUndefined();
    expect(scenario.ledger).toHaveLength(0);
    scenario.assertBalanceMatchesLedger();
  });

  test('the reference exists but has not finished: it keeps waiting, even past the last check', () => {
    const scenario = scenarioWith('100.00');
    const bet = scenario.add({ kind: 'BET', money: brl('25.00'), externalTransactionId: 'b1' });
    bet.markPendingReference(AT);
    const refund = scenario.play({ kind: 'REFUND', money: brl('25.00'), externalTransactionId: 'r1', referenceExternalTransactionId: 'b1' });

    expect(scenario.apply(refund.transaction, { lastReferenceCheck: true })).toEqual({ status: 'PENDING_REFERENCE' });
    expect(refund.transaction.status).toBe('PENDING_REFERENCE');
  });

  test('...and when that reference ends REJECTED, the waiting one is REJECTED with REFERENCE_NOT_PROCESSED', () => {
    const scenario = scenarioWith('100.00');
    const refund = scenario.add({ kind: 'REFUND', money: brl('25.00'), externalTransactionId: 'r1', referenceExternalTransactionId: 'b1' });
    refund.markPendingReference(AT);
    const rollback = scenario.play({ kind: 'ROLLBACK', money: brl('25.00'), externalTransactionId: 'rb1', referenceExternalTransactionId: 'r1' });
    expect(scenario.apply(rollback.transaction, { lastReferenceCheck: true })).toEqual({ status: 'PENDING_REFERENCE' });

    // The REFUND's own wait ends: its BET never came.
    expectRejected(scenario.apply(refund, { lastReferenceCheck: true }), FailureCode.ReferenceNotFound, '100.00');

    expectRejected(scenario.apply(rollback.transaction, { lastReferenceCheck: true }), FailureCode.ReferenceNotProcessed, '100.00');
    scenario.assertBalanceMatchesLedger();
  });

  test('on the last check a reference that is there is applied normally: the flag only ends a wait', () => {
    const scenario = scenarioWith('100.00');
    const refund = scenario.play({ kind: 'REFUND', money: brl('25.00'), externalTransactionId: 'r1', referenceExternalTransactionId: 'b1' });
    scenario.play({ kind: 'BET', money: brl('25.00'), externalTransactionId: 'b1' });

    expectProcessed(scenario.apply(refund.transaction, { lastReferenceCheck: true }), '100.00');
    scenario.assertBalanceMatchesLedger();
  });

  test('a rule broken by the payload is still reported as such on the last check', () => {
    const scenario = scenarioWith('100.00');
    scenario.play({ kind: 'BET', money: brl('25.00'), externalTransactionId: 'b1' });

    const { transaction } = scenario.play({ kind: 'REFUND', money: brl('30.00'), externalTransactionId: 'r1', referenceExternalTransactionId: 'b1' });

    expect(transaction.failureCode).toBe(FailureCode.AmountMismatch);
  });
});

describe('wallet checks', () => {
  test('currency different from the wallet: CURRENCY_MISMATCH, balance shown in the wallet currency', () => {
    const scenario = scenarioWith('100.00');

    const { outcome } = scenario.play({ kind: 'BET', money: usd('25.00'), externalTransactionId: 'b1' });

    expectRejected(outcome, FailureCode.CurrencyMismatch, '100.00');
    expect(scenario.wallet.version).toBe(1);
  });

  test('wallet of another player: WALLET_PLAYER_MISMATCH, balance not revealed', () => {
    const scenario = new WalletScenario(walletWith(brl('100.00'), OTHER_PLAYER_ID));

    const { transaction, outcome } = scenario.play({ kind: 'BET', money: brl('25.00'), externalTransactionId: 'b1' });

    expectRejected(outcome, FailureCode.WalletPlayerMismatch, undefined);
    expect(transaction.resultBalance).toBeUndefined();
    expect(scenario.wallet.balance.amount).toBe('100.00');
  });
});

describe('balance limit (the largest value numeric(20,2) stores)', () => {
  test('a WIN that would pass the limit is REJECTED with BALANCE_LIMIT_EXCEEDED; nothing moves', () => {
    const scenario = scenarioWith('999999999999999990.00');

    const { transaction, outcome } = scenario.play({ kind: 'WIN', money: brl('10.00'), externalTransactionId: 'w1' });

    expectRejected(outcome, FailureCode.BalanceLimitExceeded, '999999999999999990.00');
    expect(transaction.resultBalance?.amount).toBe('999999999999999990.00');
    expect(scenario.ledger).toHaveLength(0);
    expect(scenario.wallet.version).toBe(1);
    scenario.assertBalanceMatchesLedger();
  });

  test('a WIN that lands exactly on the limit is PROCESSED', () => {
    const scenario = scenarioWith('999999999999999990.00');

    const { outcome } = scenario.play({ kind: 'WIN', money: brl('9.99'), externalTransactionId: 'w1' });

    expectProcessed(outcome, '999999999999999999.99');
    scenario.assertBalanceMatchesLedger();
  });

  test('a reversal that credits past the limit gets the same code (not REVERSAL_WOULD_OVERDRAW)', () => {
    const scenario = scenarioWith('999999999999999999.99');
    scenario.play({ kind: 'BET', money: brl('10.00'), externalTransactionId: 'b1' });
    scenario.play({ kind: 'WIN', money: brl('10.00'), externalTransactionId: 'w1', referenceExternalTransactionId: 'b1' });

    const { outcome } = scenario.play({
      kind: 'ROLLBACK',
      money: brl('10.00'),
      externalTransactionId: 'r1',
      referenceExternalTransactionId: 'b1',
    });

    expectRejected(outcome, FailureCode.BalanceLimitExceeded, '999999999999999999.99');
    scenario.assertBalanceMatchesLedger();
  });
});

describe('caller bugs throw instead of producing an outcome', () => {
  test('a terminal transaction cannot be applied again', () => {
    const scenario = scenarioWith('100.00');
    const { transaction } = scenario.play({ kind: 'BET', money: brl('25.00'), externalTransactionId: 'b1' });

    expect(() => scenario.apply(transaction)).toThrow(DomainInvariantError);
    expect(scenario.wallet.balance.amount).toBe('75.00');
  });

  test('the wallet must be the one the transaction names', () => {
    const scenario = scenarioWith('100.00');
    const transaction = scenario.add({ kind: 'BET', money: brl('25.00'), externalTransactionId: 'b1', walletId: 'other-wallet' });

    expect(() => scenario.apply(transaction)).toThrow(DomainInvariantError);
  });

  test('the reference must be the one the transaction names', () => {
    const scenario = scenarioWith('100.00');
    const unrelated = scenario.play({ kind: 'BET', money: brl('25.00'), externalTransactionId: 'b1' }).transaction;
    const refund = scenario.add({ kind: 'REFUND', money: brl('25.00'), externalTransactionId: 'r1', referenceExternalTransactionId: 'b9' });

    expect(() =>
      applyWagerTransaction({
        wallet: scenario.wallet,
        transaction: refund,
        reference: unrelated,
        referenceAlreadyReversed: false,
        ledgerEntryId: 'e',
        at: LATER,
      }),
    ).toThrow(DomainInvariantError);
  });
});

function processedReference(transaction: WagerTransaction): void {
  transaction.markProcessed({ referenceTransactionId: undefined, resultBalance: brl('0.00'), at: AT });
}
