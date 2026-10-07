/**
 * How far apart retries are: an exponential step with a ceiling, plus jitter.
 * random is injectable so tests get exact delays.
 */
export interface BackoffPolicy {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Returns a value in [0, 1]. */
  readonly random: () => number;
}

/**
 * Delay before retry number `attempt` (1, 2, 3...):
 *
 *   step  = min(maxDelayMs, baseDelayMs * 2^(attempt - 1))
 *   delay = a random point between step / 2 and step ("equal jitter")
 *
 * Many retries that failed together (SQS down, a burst of references not found yet)
 * do not all come back in the same instant, and no retry comes sooner than half the step.
 */
export function backoffDelayMs(attempt: number, policy: BackoffPolicy): number {
  const exponent = Math.max(1, attempt) - 1;
  const step = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** exponent);
  const half = step / 2;
  return Math.floor(half + policy.random() * half);
}
