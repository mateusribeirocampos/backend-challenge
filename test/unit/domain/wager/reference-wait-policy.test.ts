import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_REFERENCE_WAIT_POLICY,
  isLastReferenceCheck,
  nextReferenceCheckAt,
  type ReferenceWaitPolicy,
} from '../../../../src/domain/wager/reference-wait-policy.js';

const AT = new Date('2026-10-07T12:00:00.000Z');

function policy(random: number): ReferenceWaitPolicy {
  return { ...DEFAULT_REFERENCE_WAIT_POLICY, random: () => random };
}

function secondsAfterAt(date: Date): number {
  return (date.getTime() - AT.getTime()) / 1000;
}

describe('reference wait policy (15 checks: base 1 s, factor 2, ceiling 60 s, jitter)', () => {
  test('defaults: 15 checks', () => {
    expect(DEFAULT_REFERENCE_WAIT_POLICY).toMatchObject({ maxAttempts: 15, baseDelayMs: 1_000, maxDelayMs: 60_000 });
  });

  test('after failed check n the next one comes after min(60 s, 2^(n-1) s), with random 1', () => {
    const delays = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((attempt) => secondsAfterAt(nextReferenceCheckAt(attempt, AT, policy(1))));

    expect(delays).toEqual([1, 2, 4, 8, 16, 32, 60, 60, 60]);
  });

  test('jitter: never sooner than half of the step', () => {
    expect(secondsAfterAt(nextReferenceCheckAt(4, AT, policy(0)))).toBe(4);
  });

  test('the window: the 15th check comes 543 s after the first at most (random 1), 271.5 s at least (random 0)', () => {
    // First check right after the transaction was stored, then 14 waits.
    const attempts = Array.from({ length: 14 }, (_, index) => index + 1);
    const total = (random: number) =>
      attempts.reduce((sum, attempt) => sum + secondsAfterAt(nextReferenceCheckAt(attempt, AT, policy(random))), 0);

    expect(total(1)).toBe(543);
    expect(total(0)).toBe(271.5);
  });

  test('the 15th check is the last one; the 14th is not', () => {
    expect(isLastReferenceCheck(14, DEFAULT_REFERENCE_WAIT_POLICY)).toBe(false);
    expect(isLastReferenceCheck(15, DEFAULT_REFERENCE_WAIT_POLICY)).toBe(true);
    expect(isLastReferenceCheck(16, DEFAULT_REFERENCE_WAIT_POLICY)).toBe(true);
  });
});
