export const WagerTransactionStatus = {
  /** Accepted, not applied yet. */
  Pending: 'PENDING',
  /** Waiting for the referenced transaction to arrive or to finish. */
  PendingReference: 'PENDING_REFERENCE',
  /** Applied. Terminal. */
  Processed: 'PROCESSED',
  /** Business rule violation. Terminal. */
  Rejected: 'REJECTED',
  /** Permanent infrastructure error. Terminal, kept for audit. */
  Failed: 'FAILED',
} as const;
export type WagerTransactionStatus = (typeof WagerTransactionStatus)[keyof typeof WagerTransactionStatus];

/**
 * The whole state machine in one table. A status not listed as a key's target is
 * not reachable from that key. Terminal statuses have no way out.
 *
 *   PENDING -----------------+--> PROCESSED
 *      |                     +--> REJECTED
 *      |                     +--> FAILED
 *      +--> PENDING_REFERENCE --> PROCESSED | REJECTED | FAILED
 *
 * The same rules exist in the database trigger wager_transactions_guard.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<WagerTransactionStatus, readonly WagerTransactionStatus[]>> = {
  PENDING: [
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
    WagerTransactionStatus.PendingReference,
  ],
  PENDING_REFERENCE: [WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected, WagerTransactionStatus.Failed],
  PROCESSED: [],
  REJECTED: [],
  FAILED: [],
};

export function isTerminalStatus(status: WagerTransactionStatus): boolean {
  return ALLOWED_TRANSITIONS[status].length === 0;
}

export function canTransition(from: WagerTransactionStatus, to: WagerTransactionStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}
