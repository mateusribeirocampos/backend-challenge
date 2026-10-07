import { describe, expect, test } from 'bun:test';
import { LockContentionError, TransientInfrastructureError, WalletNotFoundError } from '../../../src/application/errors.js';
import { type ContentionRetryPolicy, retryOnContention } from '../../../src/application/retry-on-contention.js';

/** A policy with a fixed random value and a sleep that only records the delays. */
function policy(random: number): ContentionRetryPolicy & { slept: number[] } {
  const slept: number[] = [];
  return { attempts: 3, minDelayMs: 50, maxDelayMs: 300, random: () => random, sleep: async (ms) => void slept.push(ms), slept };
}

/** work() that fails with the given errors, in order, then answers "done". */
function failingWith(...errors: Error[]): { work: () => Promise<string>; calls: () => number } {
  let calls = 0;
  return {
    work: async () => {
      const error = errors[calls];
      calls += 1;
      if (error !== undefined) throw error;
      return 'done';
    },
    calls: () => calls,
  };
}

describe('retryOnContention', () => {
  test('success on the first attempt: no wait at all', async () => {
    const retry = policy(0.5);
    const { work, calls } = failingWith();

    expect(await retryOnContention(work, retry)).toBe('done');
    expect(calls()).toBe(1);
    expect(retry.slept).toEqual([]);
  });

  test('one lock timeout, then success: one short wait, the caller never sees the error', async () => {
    const retry = policy(0);
    const { work, calls } = failingWith(new LockContentionError('busy'));

    expect(await retryOnContention(work, retry)).toBe('done');
    expect(calls()).toBe(2);
    expect(retry.slept).toEqual([50]);
  });

  test('the wait is a random point between minDelayMs and maxDelayMs', async () => {
    const top = policy(1);
    await retryOnContention(failingWith(new LockContentionError('busy')).work, top);
    const middle = policy(0.5);
    await retryOnContention(failingWith(new LockContentionError('busy')).work, middle);

    expect(top.slept).toEqual([300]);
    expect(middle.slept).toEqual([175]);
  });

  test('contention on every attempt: gives up after `attempts` and throws the last error', async () => {
    const retry = policy(0);
    const last = new LockContentionError('third');
    const { work, calls } = failingWith(new LockContentionError('first'), new LockContentionError('second'), last);

    await expect(retryOnContention(work, retry)).rejects.toBe(last);
    expect(calls()).toBe(3);
    expect(retry.slept).toEqual([50, 50]);
  });

  test.each([
    ['database down: milliseconds will not bring it back', new TransientInfrastructureError('down')],
    ['wallet not found', new WalletNotFoundError('w-1')],
    ['a bug', new TypeError('x is undefined')],
  ])('anything that is not contention is thrown at once (%s)', async (_case, error) => {
    const retry = policy(0);
    const { work, calls } = failingWith(error);

    await expect(retryOnContention(work, retry)).rejects.toBe(error);
    expect(calls()).toBe(1);
    expect(retry.slept).toEqual([]);
  });

  test('onRetry hears about each retry, for logs and metrics', async () => {
    const seen: [number, number][] = [];
    const { work } = failingWith(new LockContentionError('a'), new LockContentionError('b'));

    await retryOnContention(work, policy(0), (attempt, delayMs) => seen.push([attempt, delayMs]));

    expect(seen).toEqual([
      [2, 50],
      [3, 50],
    ]);
  });
});
