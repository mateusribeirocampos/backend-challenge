import { CurrencyMismatchError, Money } from '../money/money.js';
import { DomainError } from '../shared/domain-error.js';
import { WagerTransaction } from '../wager/wager-transaction.js';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry.js';

/** Version of a wallet right after it is opened (spec 6.2). */
export const INITIAL_WALLET_VERSION = 1;

export class InvalidWalletError extends DomainError {
  readonly code = 'INVALID_WALLET';
}

/**
 * debit() was called with more than the balance. The wallet refuses it so the balance
 * can never go negative, whoever the caller is. Callers that expect this case ask
 * canDebit() first and turn it into a REJECTED transaction.
 */
export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';
}

export interface WalletState {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly balance: Money;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface OpenWalletProps {
  readonly id: string;
  readonly playerId: string;
  readonly initialBalance: Money;
  readonly at: Date;
  /** Ids for the OPENING transaction and its ledger entry. Used only when initialBalance > 0. */
  readonly openingTransactionId: string;
  readonly openingLedgerEntryId: string;
}

/** What opening a wallet produces. The three objects are saved in one SQL transaction. */
export interface OpenedWallet {
  readonly wallet: Wallet;
  /** Present only when the initial balance is greater than zero. */
  readonly opening: { readonly transaction: WagerTransaction; readonly ledgerEntry: WalletLedgerEntry } | undefined;
}

export interface MovementProps {
  readonly ledgerEntryId: string;
  readonly transactionId: string;
  readonly money: Money;
  readonly at: Date;
}

/**
 * Aggregate root of a player's money in one currency. The only way to change the
 * balance is debit() or credit(), and both return the ledger entry they produced:
 * balance and ledger change together or not at all.
 */
export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private _balance: Money,
    private _version: number,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * A new wallet starts at version 1 already holding the initial balance. When that
   * balance is greater than zero, the OPENING credit (0.00 -> initial) is the ledger
   * entry of version 1. There is no "version 0 with balance 0": the wallet row and the
   * opening entry are written in the same SQL transaction, so that state never exists
   * in the database.
   */
  static open(props: OpenWalletProps): OpenedWallet {
    if (props.playerId.trim() === '') {
      throw new InvalidWalletError('playerId is required');
    }
    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletError(`Initial balance cannot be negative, got ${props.initialBalance.toString()}`);
    }

    const wallet = new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      INITIAL_WALLET_VERSION,
      props.at,
      props.at,
    );
    if (props.initialBalance.isZero()) {
      return { wallet, opening: undefined };
    }

    const transaction = WagerTransaction.createOpening({
      id: props.openingTransactionId,
      walletId: wallet.id,
      playerId: wallet.playerId,
      money: props.initialBalance,
      at: props.at,
    });
    const ledgerEntry = WalletLedgerEntry.create({
      id: props.openingLedgerEntryId,
      walletId: wallet.id,
      transactionId: transaction.id,
      direction: LedgerDirection.Credit,
      money: props.initialBalance,
      balanceBefore: Money.zero(wallet.currency),
      balanceAfter: props.initialBalance,
      walletVersion: INITIAL_WALLET_VERSION,
      createdAt: props.at,
    });
    return { wallet, opening: { transaction, ledgerEntry } };
  }

  /** Rebuilds a stored wallet as it is. No rule is checked again (spec 6.0). */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  /** Starts at 1 and goes up by exactly 1 each time the balance changes. */
  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** True when debiting money keeps the balance at zero or above. */
  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(props: MovementProps): WalletLedgerEntry {
    if (!this.canDebit(props.money)) {
      throw new InsufficientFundsError(
        `Wallet ${this.id} has ${this._balance.toString()}, cannot debit ${props.money.toString()}`,
      );
    }
    return this.move(LedgerDirection.Debit, props);
  }

  credit(props: MovementProps): WalletLedgerEntry {
    return this.move(LedgerDirection.Credit, props);
  }

  /** The single place where the balance changes: new balance, new version, one ledger entry. */
  private move(direction: LedgerDirection, props: MovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    if (!props.money.isPositive()) {
      throw new InvalidWalletError(`A movement must be greater than zero, got ${props.money.toString()}`);
    }

    const balanceBefore = this._balance;
    const balanceAfter =
      direction === LedgerDirection.Credit ? balanceBefore.add(props.money) : balanceBefore.subtract(props.money);
    const nextVersion = this._version + 1;

    // Built before touching the wallet: if the entry is invalid, the wallet stays as it was.
    const entry = WalletLedgerEntry.create({
      id: props.ledgerEntryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore,
      balanceAfter,
      walletVersion: nextVersion,
      createdAt: props.at,
    });

    this._balance = balanceAfter;
    this._version = nextVersion;
    this._updatedAt = props.at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
