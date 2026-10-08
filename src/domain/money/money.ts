import { DomainError } from '../shared/domain-error.js';
import { MoneyDecimal } from './money-decimal.js';

/** Contract shape of a monetary value: { "amount": "25.00", "currency": "BRL" }. */
export interface MoneyProps {
  readonly amount: string;
  readonly currency: string;
}

/** Every amount is serialized with exactly this many decimal places. */
export const MONEY_SCALE = 2;

/**
 * Accepted amount text: digits, optional dot and 1 or 2 decimals, no sign, no leading
 * zero, at most 18 integer digits (the integer part numeric(20,2) can store).
 * Checked BEFORE Decimal sees the text, because Decimal alone accepts "1e3",
 * "Infinity", "NaN", "-5" and "0x1F".
 */
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,17})(\.\d{1,2})?$/;

/** Three uppercase letters, the shape of an ISO-4217 code (BRL, USD). */
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
/**
 * ISO-4217 codes known to the runtime (Intl, ECMA-402). The table includes withdrawn
 * codes (HRK), metals (XAU) and fund codes (USN), and it comes from the runtime's ICU
 * data, so it can change with the runtime version. A shape that matches but is not in
 * the table (ABC) is refused.
 */
const ISO_4217_CODES = new Set(Intl.supportedValuesOf('currency'));
/** ISO-4217 codes that are not money a wallet can hold: XXX is "no currency", XTS is for testing. */
const NON_MONETARY_CODES = new Set(['XXX', 'XTS']);

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`Currency mismatch: expected ${expected}, got ${actual}`);
  }
}

/**
 * Immutable monetary value: an exact decimal plus its currency. Every operation
 * returns a new instance; the object is frozen, so not even a cast can change it.
 *
 * Parsing (Money.from) only accepts non-negative amounts, because every amount that
 * comes from outside (HTTP, SQS, database columns) is >= 0. A negative Money can
 * still exist, but only as the result of arithmetic (negate, subtract), for example
 * the difference in a reconciliation.
 */
export class Money {
  private constructor(
    private readonly value: MoneyDecimal,
    readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /** Parses a contract or database value. Rejects anything that is not "123" / "123.4" / "123.45". */
  static from(props: MoneyProps): Money {
    const currency = Money.parseCurrency(props.currency);
    // A number can still arrive here at runtime (JSON body, any cast). Refuse it
    // instead of converting: 0.1 as a number is already not 0.10.
    if (typeof props.amount !== 'string' || !AMOUNT_PATTERN.test(props.amount)) {
      // The value is not echoed: this text reaches logs and DLQ attributes (spec 12).
      throw new InvalidMoneyError(
        `Invalid amount: expected a non-negative decimal string with at most ${MONEY_SCALE} decimals`,
      );
    }
    return new Money(new MoneyDecimal(props.amount), currency);
  }

  static zero(currency: string): Money {
    return new Money(new MoneyDecimal(0), Money.parseCurrency(currency));
  }

  /** Amount as a fixed scale string, e.g. "25.00" or "-5.00". */
  get amount(): string {
    return this.value.toFixed(MONEY_SCALE);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  /** Value equality. Different currencies are simply not equal (no error). */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  /** "25.00 BRL". For logs and messages; contracts use toJSON(). */
  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static parseCurrency(currency: unknown): string {
    if (
      typeof currency !== 'string' ||
      !CURRENCY_PATTERN.test(currency) ||
      !ISO_4217_CODES.has(currency) ||
      NON_MONETARY_CODES.has(currency)
    ) {
      throw new InvalidMoneyError(`Invalid currency ${JSON.stringify(currency)}: expected an ISO-4217 currency code like BRL`);
    }
    return currency;
  }
}
