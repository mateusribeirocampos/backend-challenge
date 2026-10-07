import type { Money, MoneyProps } from '../money/money.js';

export interface ReconciliationInput {
  readonly walletId: string;
  /** The materialized balance (wallets.balance_amount). */
  readonly storedBalance: Money;
  /** Sum of the CREDIT entries and of the DEBIT entries of the wallet's ledger. */
  readonly totalCredits: Money;
  readonly totalDebits: Money;
  readonly checkedEntries: number;
}

/** The answer of POST /wallets/:walletId/reconciliation (spec 9). */
export interface ReconciliationProps {
  readonly walletId: string;
  readonly storedBalance: MoneyProps;
  readonly calculatedBalance: MoneyProps;
  readonly difference: MoneyProps;
  readonly consistent: boolean;
  readonly checkedEntries: number;
}

/**
 * Compares the stored balance with the balance rebuilt from the ledger:
 *
 *   calculated = credits - debits
 *   difference = stored - calculated   (positive: the wallet shows more than the ledger explains)
 *
 * It only reports. Correcting a divergence would hide the bug or the tampering that
 * caused it, so it is never done here (spec 9: "não são corrigidas silenciosamente").
 * The amounts can come out negative on corrupted data; that is reported as is.
 */
export class WalletReconciliation {
  private constructor(
    readonly walletId: string,
    readonly storedBalance: Money,
    readonly calculatedBalance: Money,
    readonly difference: Money,
    readonly checkedEntries: number,
  ) {}

  static of(input: ReconciliationInput): WalletReconciliation {
    const calculatedBalance = input.totalCredits.subtract(input.totalDebits);
    const difference = input.storedBalance.subtract(calculatedBalance);
    return new WalletReconciliation(input.walletId, input.storedBalance, calculatedBalance, difference, input.checkedEntries);
  }

  isConsistent(): boolean {
    return this.difference.isZero();
  }

  toJSON(): ReconciliationProps {
    return {
      walletId: this.walletId,
      storedBalance: this.storedBalance.toJSON(),
      calculatedBalance: this.calculatedBalance.toJSON(),
      difference: this.difference.toJSON(),
      consistent: this.isConsistent(),
      checkedEntries: this.checkedEntries,
    };
  }
}
