import { backoffDelayMs, type BackoffPolicy } from '../shared/exponential-backoff.js';

/**
 * How long a PENDING_REFERENCE transaction waits for its reference (spec 7.1).
 * The worker checks it right after it is stored, then after each failed check waits
 * backoffDelayMs(n): 1 s, 2 s, 4 s ... up to 60 s, with jitter. On check number
 * maxAttempts, a reference that still does not exist ends the wait: REJECTED with
 * REFERENCE_NOT_FOUND. A reference that exists but has not finished keeps the
 * transaction waiting, checked every 60 s, until the reference is decided.
 *
 * With 15 checks, the last one comes at most 543 s (about 9 minutes) after the first,
 * and at least 271.5 s (about 4.5 minutes) with the jitter at its minimum. Expiring too
 * early loses a refund for good; checking a few more times costs a few short transactions.
 */
export interface ReferenceWaitPolicy extends BackoffPolicy {
  readonly maxAttempts: number;
}

export const DEFAULT_REFERENCE_WAIT_POLICY: ReferenceWaitPolicy = {
  maxAttempts: 15,
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  random: Math.random,
};

/** attempt: number of the check being made now (1 for the worker's first). */
export function isLastReferenceCheck(attempt: number, policy: ReferenceWaitPolicy): boolean {
  return attempt >= policy.maxAttempts;
}

/** When to check again after check number `attempt` did not find the reference. */
export function nextReferenceCheckAt(attempt: number, at: Date, policy: ReferenceWaitPolicy): Date {
  return new Date(at.getTime() + backoffDelayMs(attempt, policy));
}
