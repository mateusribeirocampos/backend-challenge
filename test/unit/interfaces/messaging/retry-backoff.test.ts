import { describe, expect, test } from 'bun:test';
import { retryDelaySeconds, SQS_MAX_VISIBILITY_TIMEOUT_SECONDS } from '../../../../src/interfaces/messaging/retry-backoff.js';

const policy = (random: number) => ({ baseDelaySeconds: 5, maxDelaySeconds: 300, random: () => random });

/**
 * Receive n (ApproximateReceiveCount) failed with a transient error: the message stays
 * invisible for a random point between half and all of min(max, base * 2^(n-1)) seconds.
 */
describe('retryDelaySeconds', () => {
  test.each([
    [1, 5],
    [2, 10],
    [3, 20],
    [4, 40],
    [5, 80],
  ])('receive %d, random = 1 (top of the step): %d s', (receiveCount, seconds) => {
    expect(retryDelaySeconds(receiveCount, policy(1))).toBe(seconds);
  });

  test.each([
    [1, 3], // half of 5 is 2.5, rounded up: SQS takes whole seconds
    [2, 5],
    [3, 10],
    [5, 40],
  ])('receive %d, random = 0 (half of the step, never sooner): %d s', (receiveCount, seconds) => {
    expect(retryDelaySeconds(receiveCount, policy(0))).toBe(seconds);
  });

  test('the step stops growing at maxDelaySeconds', () => {
    expect(retryDelaySeconds(20, policy(1))).toBe(300);
    expect(retryDelaySeconds(20, policy(0))).toBe(150);
  });

  test('a huge receive count does not overflow into Infinity or NaN', () => {
    expect(retryDelaySeconds(5000, policy(1))).toBe(300);
  });

  test('a missing or nonsense receive count counts as the first receive', () => {
    for (const receiveCount of [0, -3, Number.NaN, 1.5]) {
      expect(retryDelaySeconds(receiveCount, policy(1))).toBe(5);
    }
  });

  test('never below 1 s and never above the SQS limit of 12 hours', () => {
    expect(retryDelaySeconds(1, { baseDelaySeconds: 0, maxDelaySeconds: 300, random: () => 0 })).toBe(1);
    expect(retryDelaySeconds(30, { baseDelaySeconds: 60, maxDelaySeconds: 10 ** 9, random: () => 1 })).toBe(
      SQS_MAX_VISIBILITY_TIMEOUT_SECONDS,
    );
  });
});
