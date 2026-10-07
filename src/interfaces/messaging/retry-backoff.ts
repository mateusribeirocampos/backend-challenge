/** ChangeMessageVisibility accepts at most 12 hours. */
export const SQS_MAX_VISIBILITY_TIMEOUT_SECONDS = 43_200;

export interface RetryBackoffPolicy {
  readonly baseDelaySeconds: number;
  readonly maxDelaySeconds: number;
  /** Returns a value in [0, 1]. Injectable so tests get exact delays. */
  readonly random: () => number;
}

/**
 * How long a message that failed with a transient error stays invisible before SQS
 * delivers it again. receiveCount is SQS's ApproximateReceiveCount (1 on the first
 * delivery), so the delay grows with every failed delivery:
 *
 *   step  = min(maxDelaySeconds, baseDelaySeconds * 2^(receiveCount - 1))
 *   delay = a random point between step / 2 and step ("equal jitter"), rounded up
 *
 * The jitter spreads the retries of many messages that failed together (the database
 * restarted), so they do not all come back in the same second.
 */
export function retryDelaySeconds(receiveCount: number, policy: RetryBackoffPolicy): number {
  const attempt = Number.isInteger(receiveCount) && receiveCount >= 1 ? receiveCount : 1;
  const step = Math.min(policy.maxDelaySeconds, policy.baseDelaySeconds * 2 ** (attempt - 1));
  const half = step / 2;
  const delay = Math.ceil(half + policy.random() * half);
  return Math.min(SQS_MAX_VISIBILITY_TIMEOUT_SECONDS, Math.max(1, delay));
}
