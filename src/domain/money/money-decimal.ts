import { Decimal } from 'decimal.js';

/**
 * Private copy of the Decimal constructor with the configuration Money needs.
 * Decimal.clone() leaves the library's global configuration untouched, so no other
 * code that imports decimal.js can change how Money rounds (ADR-004).
 *
 * precision 40: significant digits kept by each operation, far above the 20 digits
 * of numeric(20,2), so add and subtract never lose a digit.
 * ROUND_HALF_EVEN: banker's rounding, only a safety net. Money never rounds in the
 * normal flow: input has at most 2 decimals and add/subtract keep that scale.
 *
 * Exported for Money and for the test that pins this policy. Nothing else should use it.
 */
export const MoneyDecimal = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

export type MoneyDecimal = InstanceType<typeof MoneyDecimal>;
