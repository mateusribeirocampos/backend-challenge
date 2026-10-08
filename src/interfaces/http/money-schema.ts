import { z } from 'zod';
import { InvalidMoneyError, Money, type MoneyProps } from '../../domain/money/money.js';
import { ContractViolationCode } from '../../domain/wager/failure-code.js';
import { violation } from './request-validation.js';

/**
 * { "amount": "25.00", "currency": "BRL" }. The rules live in one place, Money.from
 *: this schema only calls it, so the API and the domain can never disagree
 * about what a valid amount is. A JSON number for amount is refused, not converted.
 */
export const moneySchema = z
  .object({ amount: z.unknown(), currency: z.unknown() }, 'must be an object like {"amount":"25.00","currency":"BRL"}')
  .superRefine((money, ctx) => {
    try {
      Money.from(money as MoneyProps);
    } catch (error) {
      if (!(error instanceof InvalidMoneyError)) throw error;
      violation(ctx, ContractViolationCode.InvalidMoney, error.message);
    }
  })
  .transform((money) => money as MoneyProps);
