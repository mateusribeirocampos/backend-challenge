import { Money } from '../money/money.js';
import { DomainError } from '../shared/domain-error.js';

export const LedgerDirection = {
  Debit: 'DEBIT',
  Credit: 'CREDIT',
} as const;
export type LedgerDirection = (typeof LedgerDirection)[keyof typeof LedgerDirection];

export class InvalidLedgerEntryError extends DomainError {
  readonly code = 'INVALID_LEDGER_ENTRY';
}

export interface LedgerEntryState {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  /** Amount moved, always positive; the direction says which way. */
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  /** Wallet version right after this entry. Makes the ledger a numbered chain per wallet. */
  readonly walletVersion: number;
  readonly createdAt: Date;
}

export type CreateLedgerEntryProps = LedgerEntryState;

/**
 * One line of the wallet ledger. No setters and no transition methods, and the
 * instance is frozen: an entry, once created, never changes (the table is
 * append-only for the same reason).
 */
export class WalletLedgerEntry {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly walletVersion: number;
  /**
   * Epoch milliseconds, not a Date: Object.freeze does not stop date.setTime(), so a
   * stored Date could still be changed by whoever holds a reference to it.
   */
  private readonly createdAtEpochMs: number;

  private constructor(state: LedgerEntryState) {
    this.id = state.id;
    this.walletId = state.walletId;
    this.transactionId = state.transactionId;
    this.direction = state.direction;
    this.money = state.money;
    this.balanceBefore = state.balanceBefore;
    this.balanceAfter = state.balanceAfter;
    this.walletVersion = state.walletVersion;
    this.createdAtEpochMs = state.createdAt.getTime();
    Object.freeze(this);
  }

  /** A new Date on every read: changing it does not change the entry. */
  get createdAt(): Date {
    return new Date(this.createdAtEpochMs);
  }

  /** Validates the entry's arithmetic: balanceBefore +/- money must equal balanceAfter. */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    if (props.direction !== LedgerDirection.Debit && props.direction !== LedgerDirection.Credit) {
      throw new InvalidLedgerEntryError(`Unknown ledger direction ${String(props.direction)}`);
    }
    if (!props.money.isPositive()) {
      throw new InvalidLedgerEntryError(`Ledger amount must be positive, got ${props.money.toString()}`);
    }
    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError('Ledger balances can never be negative');
    }
    if (!Number.isInteger(props.walletVersion) || props.walletVersion < 1) {
      throw new InvalidLedgerEntryError(`Wallet version must be an integer >= 1, got ${props.walletVersion}`);
    }

    const entry = new WalletLedgerEntry(props);
    // expectedBalanceAfter also throws CurrencyMismatchError if the three currencies differ.
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError(
        `Unbalanced entry: ${props.balanceBefore.toString()} ${props.direction} ${props.money.toString()} ` +
          `is not ${props.balanceAfter.toString()}`,
      );
    }
    return entry;
  }

  /** Rebuilds an entry already stored. No validation: the database checked it on insert. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(state);
  }

  /** balanceBefore + money (CREDIT) or balanceBefore - money (DEBIT) equals balanceAfter. */
  isBalanced(): boolean {
    return this.expectedBalanceAfter().equals(this.balanceAfter);
  }

  /** Signed effect of this entry on the balance: +money for CREDIT, -money for DEBIT. */
  signedAmount(): Money {
    return this.direction === LedgerDirection.Credit ? this.money : this.money.negate();
  }

  private expectedBalanceAfter(): Money {
    return this.balanceBefore.add(this.signedAmount());
  }
}
