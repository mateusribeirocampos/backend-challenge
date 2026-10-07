import { setTimeout as sleep } from 'node:timers/promises';
import { LockContentionError } from './errors.js';

/** How many times to retry a transaction that lost a lock, and how long to wait in between. */
export interface ContentionRetryPolicy {
  /** Total attempts, the first one included. */
  readonly attempts: number;
  readonly minDelayMs: number;
  readonly maxDelayMs: number;
  /** Returns a value in [0, 1]. Injectable so tests get exact delays. */
  readonly random: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

/** 3 attempts, 50 to 300 ms apart: a busy wallet usually frees up within that. */
export const DEFAULT_CONTENTION_RETRY: ContentionRetryPolicy = {
  attempts: 3,
  minDelayMs: 50,
  maxDelayMs: 300,
  random: Math.random,
  sleep: (ms) => sleep(ms),
};

/**
 * Runs `work` (one whole SQL transaction) again when it fails with LockContentionError
 * (lock timeout, deadlock, serialization). Each failed attempt was rolled back entirely,
 * so running it again is safe. Any other error is thrown at once: a database that is
 * down does not come back in milliseconds, and a payload error never does.
 *
 * Why: without it, one lock timeout on a hot wallet sent the message back to the queue
 * with a visibility backoff AND released the rest of that wallet's batch, raising their
 * receive counts until untried messages reached the DLQ.
 */
export async function retryOnContention<T>(
  work: () => Promise<T>,
  policy: ContentionRetryPolicy = DEFAULT_CONTENTION_RETRY,
  onRetry: (attempt: number, delayMs: number) => void = () => {},
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof LockContentionError) || attempt >= policy.attempts) {
        throw error;
      }
      const delayMs = Math.round(policy.minDelayMs + policy.random() * (policy.maxDelayMs - policy.minDelayMs));
      onRetry(attempt + 1, delayMs);
      await policy.sleep(delayMs);
    }
  }
}
