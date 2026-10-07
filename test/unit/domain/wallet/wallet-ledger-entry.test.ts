import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, Money } from '../../../../src/domain/money/money.js';
import {
  type CreateLedgerEntryProps,
  InvalidLedgerEntryError,
  LedgerDirection,
  WalletLedgerEntry,
} from '../../../../src/domain/wallet/wallet-ledger-entry.js';
import { AT, brl, usd, WALLET_ID } from '../support/domain-fixtures.js';

function entryProps(overrides: Partial<CreateLedgerEntryProps> = {}): CreateLedgerEntryProps {
  return {
    id: 'entry-1',
    walletId: WALLET_ID,
    transactionId: 'tx-1',
    direction: LedgerDirection.Debit,
    money: brl('25.00'),
    balanceBefore: brl('100.00'),
    balanceAfter: brl('75.00'),
    walletVersion: 2,
    createdAt: AT,
    ...overrides,
  };
}

describe('WalletLedgerEntry.create validates the arithmetic', () => {
  test('DEBIT: 100.00 - 25.00 = 75.00', () => {
    const entry = WalletLedgerEntry.create(entryProps());

    expect(entry.isBalanced()).toBe(true);
    expect(entry.signedAmount().amount).toBe('-25.00');
  });

  test('CREDIT: 75.00 + 25.00 = 100.00', () => {
    const entry = WalletLedgerEntry.create(
      entryProps({ direction: LedgerDirection.Credit, balanceBefore: brl('75.00'), balanceAfter: brl('100.00') }),
    );

    expect(entry.isBalanced()).toBe(true);
    expect(entry.signedAmount().amount).toBe('25.00');
  });

  test('a DEBIT whose after does not match is refused (100.00 - 25.00 is not 80.00)', () => {
    expect(() => WalletLedgerEntry.create(entryProps({ balanceAfter: brl('80.00') }))).toThrow(InvalidLedgerEntryError);
  });

  test('the direction matters: 100.00 -> 125.00 is not a DEBIT of 25.00', () => {
    expect(() => WalletLedgerEntry.create(entryProps({ balanceAfter: brl('125.00') }))).toThrow(InvalidLedgerEntryError);
  });

  test('amount must be positive (zero is refused)', () => {
    expect(() =>
      WalletLedgerEntry.create(entryProps({ money: Money.zero('BRL'), balanceAfter: brl('100.00') })),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('a balance can never be negative', () => {
    expect(() =>
      WalletLedgerEntry.create(entryProps({ balanceBefore: brl('10.00'), balanceAfter: brl('15.00').negate() })),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('wallet version must be an integer >= 1', () => {
    expect(() => WalletLedgerEntry.create(entryProps({ walletVersion: 0 }))).toThrow(InvalidLedgerEntryError);
    expect(() => WalletLedgerEntry.create(entryProps({ walletVersion: 1.5 }))).toThrow(InvalidLedgerEntryError);
  });

  test('mixed currencies are refused', () => {
    expect(() => WalletLedgerEntry.create(entryProps({ money: usd('25.00') }))).toThrow(CurrencyMismatchError);
  });
});

describe('WalletLedgerEntry is immutable', () => {
  test('frozen instance, no field can be assigned', () => {
    const entry = WalletLedgerEntry.create(entryProps());

    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { balanceAfter: Money }).balanceAfter = brl('1000.00');
    }).toThrow(TypeError);
  });

  test('rehydrate rebuilds a stored entry without validating it again', () => {
    const stored = entryProps({ balanceAfter: brl('80.00') });

    const entry = WalletLedgerEntry.rehydrate(stored);

    expect(entry.balanceAfter.amount).toBe('80.00');
    expect(entry.isBalanced()).toBe(false);
  });
});

describe('WalletLedgerEntry.createdAt cannot be changed through a Date reference', () => {
  const instant = '2026-10-06T12:00:00.000Z';

  test.each([
    ['create', (createdAt: Date) => WalletLedgerEntry.create(entryProps({ createdAt }))],
    ['rehydrate', (createdAt: Date) => WalletLedgerEntry.rehydrate(entryProps({ createdAt }))],
  ])('%s: mutating the Date given in does not move the entry', (_factory, build) => {
    const input = new Date(instant);
    const entry = build(input);

    input.setTime(0);

    expect(entry.createdAt.toISOString()).toBe(instant);
  });

  test('mutating the Date read from it does not move the entry (Object.freeze alone does not stop setTime)', () => {
    const entry = WalletLedgerEntry.create(entryProps({ createdAt: new Date(instant) }));

    entry.createdAt.setTime(0);

    expect(entry.createdAt.toISOString()).toBe(instant);
  });
});
