import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError } from '../../../../src/domain/money/money.js';
import { WalletReconciliation } from '../../../../src/domain/wallet/wallet-reconciliation.js';
import { brl, usd, WALLET_ID } from '../support/domain-fixtures.js';

function reconcile(stored: string, credits: string, debits: string, checkedEntries = 3): WalletReconciliation {
  return WalletReconciliation.of({
    walletId: WALLET_ID,
    storedBalance: brl(stored),
    totalCredits: brl(credits),
    totalDebits: brl(debits),
    checkedEntries,
  });
}

describe('WalletReconciliation (spec 9)', () => {
  test('opening 100 + WIN 10 - BET 25: the ledger says 85.00, the wallet says 85.00, consistent', () => {
    const result = reconcile('85.00', '110.00', '25.00');

    expect(result.calculatedBalance.amount).toBe('85.00');
    expect(result.difference.amount).toBe('0.00');
    expect(result.isConsistent()).toBe(true);
    expect(result.toJSON()).toEqual({
      walletId: WALLET_ID,
      storedBalance: { amount: '85.00', currency: 'BRL' },
      calculatedBalance: { amount: '85.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 3,
    });
  });

  test('difference = stored - calculated: the wallet shows 5.00 more than the ledger explains', () => {
    const result = reconcile('80.00', '100.00', '25.00', 2);

    expect(result.difference.amount).toBe('5.00');
    expect(result.isConsistent()).toBe(false);
  });

  test('the wallet shows less than the ledger: the difference is negative', () => {
    expect(reconcile('70.00', '100.00', '25.00').difference.amount).toBe('-5.00');
  });

  test('exact to the cent: 0.10 + 0.20 credits against a 0.30 balance is consistent (no float)', () => {
    expect(reconcile('0.30', '0.30', '0.00').isConsistent()).toBe(true);
    expect(reconcile('0.30', '0.31', '0.00').difference.amount).toBe('-0.01');
  });

  test('a ledger with more debits than credits (only possible with corrupted data) is reported, not hidden', () => {
    const result = reconcile('0.00', '10.00', '25.00');

    expect(result.calculatedBalance.amount).toBe('-15.00');
    expect(result.difference.amount).toBe('15.00');
  });

  test('a wallet opened at 0.00 with no entry is consistent with 0 entries checked', () => {
    const result = reconcile('0.00', '0', '0', 0);

    expect(result.isConsistent()).toBe(true);
    expect(result.checkedEntries).toBe(0);
  });

  test('totals in another currency are a programming error, never a silent comparison', () => {
    expect(() =>
      WalletReconciliation.of({
        walletId: WALLET_ID,
        storedBalance: brl('10.00'),
        totalCredits: usd('10.00'),
        totalDebits: usd('0.00'),
        checkedEntries: 1,
      }),
    ).toThrow(CurrencyMismatchError);
  });
});
