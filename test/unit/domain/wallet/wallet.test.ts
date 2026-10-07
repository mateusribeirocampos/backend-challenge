import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, Money } from '../../../../src/domain/money/money.js';
import { WagerTransactionKind } from '../../../../src/domain/wager/wager-transaction-kind.js';
import { WagerTransactionStatus } from '../../../../src/domain/wager/wager-transaction-status.js';
import { INTERNAL_PROVIDER_ID } from '../../../../src/domain/wager/wager-transaction.js';
import {
  BalanceLimitExceededError,
  InsufficientFundsError,
  InvalidWalletError,
  MAX_BALANCE_AMOUNT,
  type OpenWalletProps,
  Wallet,
} from '../../../../src/domain/wallet/wallet.js';
import { LedgerDirection } from '../../../../src/domain/wallet/wallet-ledger-entry.js';
import { AT, brl, LATER, PLAYER_ID, usd, WALLET_ID, walletWith } from '../support/domain-fixtures.js';

function openProps(initialBalance: Money): OpenWalletProps {
  return {
    id: WALLET_ID,
    playerId: PLAYER_ID,
    initialBalance,
    at: AT,
    openingTransactionId: 'opening-tx',
    openingLedgerEntryId: 'opening-entry',
  };
}

function movement(money: Money, suffix = '1') {
  return { ledgerEntryId: `entry-${suffix}`, transactionId: `tx-${suffix}`, money, at: LATER };
}

describe('Wallet.open', () => {
  test('initial balance > 0: version 1, balance set, OPENING credit 0.00 -> 1000.00', () => {
    const { wallet, opening } = Wallet.open(openProps(brl('1000.00')));

    expect(wallet.version).toBe(1);
    expect(wallet.balance.amount).toBe('1000.00');
    expect(wallet.currency).toBe('BRL');
    expect(opening).toBeDefined();

    const { transaction, ledgerEntry } = opening!;
    expect(transaction.kind).toBe(WagerTransactionKind.Opening);
    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.providerId).toBe(INTERNAL_PROVIDER_ID);
    expect(transaction.resultBalance?.amount).toBe('1000.00');
    expect(transaction.roundId).toBeUndefined();
    expect(transaction.payloadHash).toBeUndefined();

    expect(ledgerEntry.direction).toBe(LedgerDirection.Credit);
    expect(ledgerEntry.transactionId).toBe(transaction.id);
    expect(ledgerEntry.balanceBefore.amount).toBe('0.00');
    expect(ledgerEntry.balanceAfter.amount).toBe('1000.00');
    expect(ledgerEntry.walletVersion).toBe(1);
  });

  test('initial balance 0: version 1 and no OPENING (nothing moved)', () => {
    const { wallet, opening } = Wallet.open(openProps(Money.zero('BRL')));

    expect(wallet.version).toBe(1);
    expect(wallet.balance.isZero()).toBe(true);
    expect(opening).toBeUndefined();
  });

  test('the wallet currency comes from the initial balance', () => {
    expect(Wallet.open(openProps(usd('5.00'))).wallet.currency).toBe('USD');
  });

  test('negative initial balance is refused', () => {
    expect(() => Wallet.open(openProps(brl('10.00').negate()))).toThrow(InvalidWalletError);
  });
});

describe('Wallet debit and credit', () => {
  test('debit returns the ledger entry and moves balance and version together', () => {
    const wallet = walletWith(brl('100.00'));

    const entry = wallet.debit(movement(brl('25.00')));

    expect(wallet.balance.amount).toBe('75.00');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(LATER);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.amount).toBe('100.00');
    expect(entry.balanceAfter.amount).toBe('75.00');
    expect(entry.walletVersion).toBe(wallet.version);
  });

  test('credit returns the ledger entry and moves balance and version together', () => {
    const wallet = walletWith(brl('75.00'));

    const entry = wallet.credit(movement(brl('25.00')));

    expect(wallet.balance.amount).toBe('100.00');
    expect(wallet.version).toBe(2);
    expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);
  });

  test('version goes up by exactly 1 per balance change', () => {
    const wallet = walletWith(brl('100.00'));

    wallet.debit(movement(brl('10.00'), '1'));
    wallet.credit(movement(brl('5.00'), '2'));
    wallet.debit(movement(brl('1.00'), '3'));

    expect(wallet.version).toBe(4);
    expect(wallet.balance.amount).toBe('94.00');
  });

  test('debit of the whole balance is allowed and leaves exactly 0.00', () => {
    const wallet = walletWith(brl('80.00'));

    wallet.debit(movement(brl('80.00')));

    expect(wallet.balance.amount).toBe('0.00');
  });

  test('never negative: debit above the balance throws and changes nothing', () => {
    const wallet = walletWith(brl('20.00'));

    expect(wallet.canDebit(brl('80.00'))).toBe(false);
    expect(() => wallet.debit(movement(brl('80.00')))).toThrow(InsufficientFundsError);
    expect(wallet.balance.amount).toBe('20.00');
    expect(wallet.version).toBe(1);
  });

  test('a zero movement is refused and does not bump the version', () => {
    const wallet = walletWith(brl('20.00'));

    expect(() => wallet.credit(movement(Money.zero('BRL')))).toThrow(InvalidWalletError);
    expect(wallet.version).toBe(1);
  });

  test('currency of the operation must match the wallet', () => {
    const wallet = walletWith(brl('100.00'));

    expect(() => wallet.debit(movement(usd('1.00')))).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(movement(usd('1.00')))).toThrow(CurrencyMismatchError);
    expect(() => wallet.canDebit(usd('1.00'))).toThrow(CurrencyMismatchError);
    expect(wallet.balance.amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });
});

describe('balance limit: the largest value numeric(20,2) stores', () => {
  test('MAX_BALANCE_AMOUNT is the same 18 integer digits bound Money.from accepts', () => {
    expect(MAX_BALANCE_AMOUNT).toBe('999999999999999999.99');
    expect(brl(MAX_BALANCE_AMOUNT).amount).toBe(MAX_BALANCE_AMOUNT);
  });

  test('canCredit is true up to the limit exactly and false one cent above', () => {
    const wallet = walletWith(brl('999999999999999990.00'));

    expect(wallet.canCredit(brl('9.99'))).toBe(true);
    expect(wallet.canCredit(brl('10.00'))).toBe(false);
  });

  test('credit above the limit throws and leaves the wallet as it was (last barrier, like debit)', () => {
    const wallet = walletWith(brl('999999999999999990.00'));

    expect(() => wallet.credit(movement(brl('10.00')))).toThrow(BalanceLimitExceededError);
    expect(wallet.balance.amount).toBe('999999999999999990.00');
    expect(wallet.version).toBe(1);
  });

  test('a credit that lands exactly on the limit is fine', () => {
    const wallet = walletWith(brl('999999999999999990.00'));

    wallet.credit(movement(brl('9.99')));

    expect(wallet.balance.amount).toBe(MAX_BALANCE_AMOUNT);
  });
});

describe('Wallet.rehydrate', () => {
  test('rebuilds the stored state as it is', () => {
    const wallet = Wallet.rehydrate({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      currency: 'BRL',
      balance: brl('42.00'),
      version: 7,
      createdAt: AT,
      updatedAt: LATER,
    });

    expect(wallet.balance.amount).toBe('42.00');
    expect(wallet.version).toBe(7);
    expect(wallet.createdAt).toEqual(AT);
    expect(wallet.updatedAt).toEqual(LATER);
  });
});

describe('Wallet dates cannot be changed through a Date reference', () => {
  const instant = '2026-10-06T12:00:00.000Z';

  test('mutating the Date given to open() or read back does not move createdAt/updatedAt', () => {
    const at = new Date(instant);
    const { wallet } = Wallet.open({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      initialBalance: brl('0.00'),
      at,
      openingTransactionId: 'tx-opening',
      openingLedgerEntryId: 'entry-opening',
    });

    at.setTime(0);
    wallet.createdAt.setTime(0);
    wallet.updatedAt.setTime(0);

    expect([wallet.createdAt.toISOString(), wallet.updatedAt.toISOString()]).toEqual([instant, instant]);
  });

  test('mutating the Date given to a movement does not move updatedAt', () => {
    const wallet = walletWith(brl('100.00'));
    const at = new Date(instant);
    wallet.debit({ ledgerEntryId: 'entry-2', transactionId: 'tx-2', money: brl('25.00'), at });

    at.setTime(0);

    expect(wallet.updatedAt.toISOString()).toBe(instant);
  });
});
