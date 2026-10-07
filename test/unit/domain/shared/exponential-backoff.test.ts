import { describe, expect, test } from 'bun:test';
import { backoffDelayMs, type BackoffPolicy } from '../../../../src/domain/shared/exponential-backoff.js';

function policy(random: number): BackoffPolicy {
  return { baseDelayMs: 1_000, maxDelayMs: 60_000, random: () => random };
}

describe('backoffDelayMs (exponential, capped, equal jitter)', () => {
  test('random 1 gives the full step: 1 s, 2 s, 4 s, 8 s...', () => {
    expect([1, 2, 3, 4].map((attempt) => backoffDelayMs(attempt, policy(1)))).toEqual([1_000, 2_000, 4_000, 8_000]);
  });

  test('random 0 gives half of the step, never less', () => {
    expect([1, 2, 3].map((attempt) => backoffDelayMs(attempt, policy(0)))).toEqual([500, 1_000, 2_000]);
  });

  test('the step stops growing at maxDelayMs (attempt 7 would be 64 s)', () => {
    expect(backoffDelayMs(7, policy(1))).toBe(60_000);
    expect(backoffDelayMs(30, policy(0))).toBe(30_000);
  });

  test('an attempt below 1 is treated as the first one', () => {
    expect(backoffDelayMs(0, policy(1))).toBe(1_000);
  });
});
