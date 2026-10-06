import { describe, expect, test } from 'bun:test';
import { Decimal } from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError, Money } from '../../../../src/domain/money/money.js';
import { MoneyDecimal } from '../../../../src/domain/money/money-decimal.js';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

describe('Money.from: accepted input', () => {
  test.each([
    ['25.00', '25.00'],
    ['25', '25.00'],
    ['25.5', '25.50'],
    ['0', '0.00'],
    ['0.01', '0.01'],
    ['999999999999999999.99', '999999999999999999.99'],
  ])('%p is read and always written with scale 2 as %p', (input, expected) => {
    const money = Money.from({ amount: input, currency: 'BRL' });

    expect(money.amount).toBe(expected);
    expect(money.toJSON()).toEqual({ amount: expected, currency: 'BRL' });
    expect(money.toString()).toBe(`${expected} BRL`);
  });
});

describe('Money.from: rejected input (spec 6.1)', () => {
  test.each([
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['-Infinity', '-Infinity'],
    ['scientific notation', '1e3'],
    ['scientific notation with decimals', '2.5E2'],
    ['empty string', ''],
    ['only spaces', '   '],
    ['leading space', ' 5.00'],
    ['trailing space', '5.00 '],
    ['more than 2 decimals', '1.234'],
    ['3 decimals ending in zero', '1.000'],
    ['negative', '-5.00'],
    ['negative zero', '-0.00'],
    ['explicit plus sign', '+5.00'],
    ['leading zero', '05.00'],
    ['dot without decimals', '5.'],
    ['dot without integer part', '.50'],
    ['comma as decimal separator', '5,00'],
    ['thousands separator', '1,000.00'],
    ['hexadecimal', '0x1F'],
    ['more than 18 integer digits (does not fit numeric(20,2))', '1000000000000000000.00'],
  ])('%s (%p)', (_label, amount) => {
    expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test('a JavaScript number is refused even if a cast lets it through', () => {
    const props = { amount: 25.5 as unknown as string, currency: 'BRL' };

    expect(() => Money.from(props)).toThrow(InvalidMoneyError);
  });

  test.each(['brl', 'BR', 'BRLX', '', '123', 'R$'])('currency %p is not an ISO-4217 code', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
    expect(() => Money.zero(currency)).toThrow(InvalidMoneyError);
  });
});

describe('Money arithmetic is exact', () => {
  test('0.10 + 0.20 = 0.30 (with number it would be 0.30000000000000004)', () => {
    expect(brl('0.10').add(brl('0.20')).amount).toBe('0.30');
    expect(brl('0.10').add(brl('0.20')).equals(brl('0.30'))).toBe(true);
  });

  test('adding 0.01 one thousand times gives exactly 10.00', () => {
    let total = Money.zero('BRL');
    for (let index = 0; index < 1000; index++) total = total.add(brl('0.01'));

    expect(total.amount).toBe('10.00');
  });

  test('subtract below zero gives a negative Money (used for differences)', () => {
    const difference = brl('975.00').subtract(brl('1000.00'));

    expect(difference.amount).toBe('-25.00');
    expect(difference.isNegative()).toBe(true);
  });

  test('the largest values keep every digit', () => {
    expect(brl('999999999999999999.99').subtract(brl('0.01')).amount).toBe('999999999999999999.98');
  });

  test('negate flips the sign and negating zero stays 0.00', () => {
    expect(brl('25.00').negate().amount).toBe('-25.00');
    expect(brl('25.00').negate().negate().equals(brl('25.00'))).toBe(true);
    expect(Money.zero('BRL').negate().amount).toBe('0.00');
  });
});

describe('Money comparisons', () => {
  test('isZero / isPositive / isNegative', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(Money.zero('BRL').isPositive()).toBe(false);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.01').negate().isNegative()).toBe(true);
    expect(brl('0.00').isNegative()).toBe(false);
  });

  test('isLessThan and equals compare value, not text', () => {
    expect(brl('24.99').isLessThan(brl('25'))).toBe(true);
    expect(brl('25').isLessThan(brl('25.00'))).toBe(false);
    expect(brl('25').equals(brl('25.00'))).toBe(true);
  });

  test('equals across currencies is false, not an error', () => {
    expect(brl('10.00').equals(usd('10.00'))).toBe(false);
  });
});

describe('Money currency conflict', () => {
  test.each([
    ['add', (a: Money, b: Money) => a.add(b)],
    ['subtract', (a: Money, b: Money) => a.subtract(b)],
    ['isLessThan', (a: Money, b: Money) => a.isLessThan(b)],
  ])('%s between BRL and USD throws CurrencyMismatchError', (_name, operation) => {
    const error = (() => {
      try {
        operation(brl('10.00'), usd('10.00'));
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();

    expect(error).toBeInstanceOf(CurrencyMismatchError);
    expect((error as CurrencyMismatchError).code).toBe('CURRENCY_MISMATCH');
    expect((error as CurrencyMismatchError).expected).toBe('BRL');
    expect((error as CurrencyMismatchError).actual).toBe('USD');
  });
});

describe('Money is immutable', () => {
  test('operations return new instances and leave the operands untouched', () => {
    const a = brl('10.00');
    const b = brl('2.50');

    const sum = a.add(b);
    const difference = a.subtract(b);
    const negated = a.negate();

    expect([sum, difference, negated]).not.toContain(a);
    expect(a.amount).toBe('10.00');
    expect(b.amount).toBe('2.50');
  });

  test('the instance is frozen: assigning a field throws at runtime', () => {
    const money = brl('10.00');

    expect(() => {
      (money as unknown as { currency: string }).currency = 'USD';
    }).toThrow(TypeError);
    expect(money.currency).toBe('BRL');
  });
});

describe('Money rounding policy (ADR-004)', () => {
  test('input with more than 2 decimals is rejected, never rounded', () => {
    expect(() => Money.from({ amount: '10.005', currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test('the private Decimal rounds half to even (banker\'s rounding)', () => {
    expect(new MoneyDecimal('0.125').toFixed(2)).toBe('0.12');
    expect(new MoneyDecimal('0.135').toFixed(2)).toBe('0.14');
    expect(new MoneyDecimal('2.5').toFixed(0)).toBe('2');
    expect(MoneyDecimal.rounding).toBe(Decimal.ROUND_HALF_EVEN);
    expect(MoneyDecimal.precision).toBe(40);
  });

  test('the global decimal.js configuration is left untouched', () => {
    expect(Decimal.rounding).toBe(Decimal.ROUND_HALF_UP);
    expect(Decimal.precision).toBe(20);
  });
});
