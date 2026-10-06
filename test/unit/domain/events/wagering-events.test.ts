import { describe, expect, test } from 'bun:test';
import type { EventContext } from '../../../../src/domain/events/integration-event.js';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../../../src/domain/events/wagering-events.js';
import { DomainInvariantError } from '../../../../src/domain/shared/domain-error.js';
import { applyWagerTransaction } from '../../../../src/domain/wager/apply-wager-transaction.js';
import { FailureCode } from '../../../../src/domain/wager/failure-code.js';
import { WagerTransactionKind } from '../../../../src/domain/wager/wager-transaction-kind.js';
import { WagerTransactionStatus } from '../../../../src/domain/wager/wager-transaction-status.js';
import type { WagerTransaction } from '../../../../src/domain/wager/wager-transaction.js';
import type { WalletLedgerEntry } from '../../../../src/domain/wallet/wallet-ledger-entry.js';
import { AT, brl, LATER, PLAYER_ID, ROUND_ID, submitted, WALLET_ID, walletWith } from '../support/domain-fixtures.js';

const CONTEXT: EventContext = {
  eventId: '0192f2a0-0000-7000-8000-000000000001',
  correlationId: 'corr-1',
  causationId: 'msg-1',
  occurredAt: LATER,
};

/** Runs the real rules so the events are built from real outcomes, not hand-made objects. */
function processedBet(amount: string, balance = '100.00') {
  const wallet = walletWith(brl(balance));
  const transaction = submitted({ kind: WagerTransactionKind.Bet, money: brl(amount), externalTransactionId: 'bet-1' });
  const outcome = applyWagerTransaction({
    wallet,
    transaction,
    reference: undefined,
    referenceAlreadyReversed: false,
    ledgerEntryId: 'entry-1',
    at: LATER,
  });
  return { wallet, transaction, outcome };
}

function ledgerEntryOf(outcome: ReturnType<typeof applyWagerTransaction>): WalletLedgerEntry {
  if (outcome.status !== WagerTransactionStatus.Processed || outcome.ledgerEntry === undefined) {
    throw new Error('expected a processed outcome with a ledger entry');
  }
  return outcome.ledgerEntry;
}

describe('IntegrationEvent envelope (spec 11)', () => {
  test('toJSON is the envelope: type and version come from the subclass, occurredAt is ISO-8601', () => {
    const { transaction } = processedBet('25.00');

    const event = WagerTransactionProcessed.from(transaction, CONTEXT);

    expect(event.eventType).toBe('WagerTransactionProcessed');
    expect(event.version).toBe(1);
    expect(event.toJSON()).toEqual({
      eventId: CONTEXT.eventId,
      eventType: 'WagerTransactionProcessed',
      aggregateId: WALLET_ID,
      correlationId: 'corr-1',
      causationId: 'msg-1',
      occurredAt: '2026-10-06T12:00:05.000Z',
      version: 1,
      data: expect.any(Object),
    });
  });

  test('causationId is left out of the envelope when there is none (HTTP entry)', () => {
    const { transaction } = processedBet('25.00');

    const json = WagerTransactionProcessed.from(transaction, { ...CONTEXT, causationId: undefined }).toJSON();

    expect('causationId' in json).toBe(false);
  });

  test('the envelope survives JSON.stringify and parse unchanged (stable payload for the outbox)', () => {
    const { transaction } = processedBet('25.00');
    const json = WagerTransactionProcessed.from(transaction, CONTEXT).toJSON();

    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  test('data is frozen, including nested money objects', () => {
    const { wallet, outcome } = processedBet('25.00');
    const event = WalletBalanceChanged.from(wallet, ledgerEntryOf(outcome), CONTEXT);

    expect(Object.isFrozen(event.data)).toBe(true);
    expect(Object.isFrozen(event.data.money)).toBe(true);
  });
});

describe('WagerTransactionProcessed', () => {
  test('carries the original result: money and balance as MoneyProps strings, never Money', () => {
    const { transaction } = processedBet('25.00');

    const { data } = WagerTransactionProcessed.from(transaction, CONTEXT).toJSON();

    expect(data).toEqual({
      transactionId: transaction.id,
      providerId: 'provider-a',
      externalTransactionId: 'bet-1',
      walletId: WALLET_ID,
      playerId: PLAYER_ID,
      roundId: ROUND_ID,
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      referenceTransactionId: null,
      balance: { amount: '75.00', currency: 'BRL' },
      processedAt: '2026-10-06T12:00:05.000Z',
    });
  });

  test('a LOSS is processed too (spec 11: any applied transaction, LOSS included)', () => {
    const wallet = walletWith(brl('100.00'));
    const loss = submitted({ kind: WagerTransactionKind.Loss, money: brl('0.00'), externalTransactionId: 'loss-1' });
    applyWagerTransaction({ wallet, transaction: loss, reference: undefined, referenceAlreadyReversed: false, ledgerEntryId: 'e', at: LATER });

    const { data } = WagerTransactionProcessed.from(loss, CONTEXT).toJSON();

    expect(data.kind).toBe('LOSS');
    expect(data.balance).toEqual({ amount: '100.00', currency: 'BRL' });
  });

  test('refuses a transaction that is not PROCESSED (caller bug)', () => {
    const pending = submitted({ kind: WagerTransactionKind.Bet, money: brl('1.00'), externalTransactionId: 'bet-x' });

    expect(() => WagerTransactionProcessed.from(pending, CONTEXT)).toThrow(DomainInvariantError);
  });
});

describe('WagerTransactionRejected', () => {
  test('carries the failureCode and the balance observed', () => {
    const { transaction } = processedBet('80.00', '50.00');

    const { data } = WagerTransactionRejected.from(transaction, CONTEXT).toJSON();

    expect(data).toMatchObject({
      transactionId: transaction.id,
      kind: 'BET',
      money: { amount: '80.00', currency: 'BRL' },
      failureCode: FailureCode.InsufficientFunds,
      balance: { amount: '50.00', currency: 'BRL' },
    });
  });

  test('balance is null when it must not be revealed (wallet of another player)', () => {
    const wallet = walletWith(brl('100.00'), '0192f28f-5dc0-7d58-bdb2-000000000000');
    const bet = submitted({ kind: WagerTransactionKind.Bet, money: brl('1.00'), externalTransactionId: 'bet-2' });
    applyWagerTransaction({ wallet, transaction: bet, reference: undefined, referenceAlreadyReversed: false, ledgerEntryId: 'e', at: AT });

    const { data } = WagerTransactionRejected.from(bet, CONTEXT).toJSON();

    expect(data.failureCode).toBe(FailureCode.WalletPlayerMismatch);
    expect(data.balance).toBeNull();
  });

  test('refuses a transaction that is not REJECTED', () => {
    const { transaction } = processedBet('25.00');

    expect(() => WagerTransactionRejected.from(transaction, CONTEXT)).toThrow(DomainInvariantError);
  });
});

describe('WagerTransactionPendingReference', () => {
  function pendingRollback(): WagerTransaction {
    const wallet = walletWith(brl('100.00'));
    const rollback = submitted({
      kind: WagerTransactionKind.Rollback,
      money: brl('25.00'),
      externalTransactionId: 'rollback-1',
      referenceExternalTransactionId: 'bet-not-arrived',
    });
    applyWagerTransaction({ wallet, transaction: rollback, reference: undefined, referenceAlreadyReversed: false, ledgerEntryId: 'e', at: AT });
    return rollback;
  }

  test('names the reference the transaction is waiting for', () => {
    const rollback = pendingRollback();

    const { data } = WagerTransactionPendingReference.from(rollback, CONTEXT).toJSON();

    expect(data).toMatchObject({
      transactionId: rollback.id,
      kind: 'ROLLBACK',
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: 'bet-not-arrived',
    });
  });

  test('refuses a transaction that is not PENDING_REFERENCE', () => {
    const { transaction } = processedBet('25.00');

    expect(() => WagerTransactionPendingReference.from(transaction, CONTEXT)).toThrow(DomainInvariantError);
  });
});

describe('WalletBalanceChanged (spec 11 example)', () => {
  test('data has the movement, both balances and the new wallet version', () => {
    const { wallet, transaction, outcome } = processedBet('25.00');

    const event = WalletBalanceChanged.from(wallet, ledgerEntryOf(outcome), CONTEXT);

    expect(event.aggregateId).toBe(WALLET_ID);
    expect(event.toJSON().data).toEqual({
      walletId: WALLET_ID,
      transactionId: transaction.id,
      direction: 'DEBIT',
      money: { amount: '25.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '75.00', currency: 'BRL' },
      walletVersion: 2,
    });
  });

  test('refuses an entry that is not the last movement of this wallet (caller bug)', () => {
    const { outcome } = processedBet('25.00');
    const staleWallet = walletWith(brl('100.00'));

    expect(() => WalletBalanceChanged.from(staleWallet, ledgerEntryOf(outcome), CONTEXT)).toThrow(DomainInvariantError);
  });
});
