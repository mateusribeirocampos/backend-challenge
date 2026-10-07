/**
 * Counters and gauges of the system (spec 12). The names follow the Prometheus
 * convention (_total for counters); the adapter that exposes them comes with the
 * observability work.
 */
export const MetricName = {
  /** First processing of a message, by the status the transaction got. Label: status. */
  MessagesProcessed: 'wager_messages_processed_total',
  /** A duplicate stopped before any effect. Label: layer = inbox | idempotency_key. */
  DuplicatesDetected: 'wager_duplicates_detected_total',
  /**
   * A transaction lost a row lock (lock timeout, deadlock, serialization) and was run
   * again in the same process. Spec 12: "conflitos de lock".
   */
  LockConflicts: 'wager_lock_conflicts_total',
  /** Transient failure: the message was left in the queue to come back later. Label: error_code. */
  MessageRetries: 'wager_message_retries_total',
  /** Sent to the DLQ by the consumer. Label: reason. */
  MessagesDeadLettered: 'wager_messages_dead_lettered_total',
  /** ReceiveMessage calls that answered. Label: result = messages | empty. */
  ConsumerReceives: 'wager_consumer_receives_total',
  /** A call to SQS that failed (receive, delete, ...). Label: operation. */
  ConsumerSqsErrors: 'wager_consumer_sqs_errors_total',

  // ---- outbox publisher (ADR-005)
  /** A send SQS confirmed (a duplicate send included, see below). Label: event_type. */
  OutboxPublished: 'wager_outbox_published_total',
  /** A send failed; the event got a new attempt with backoff. */
  OutboxPublishFailures: 'wager_outbox_publish_failures_total',
  /** A send of an event that had failed before (attempts > 0). */
  OutboxPublishRetries: 'wager_outbox_publish_retries_total',
  /**
   * The event was already marked published by another publisher, so this send was a
   * second copy. Harmless: same SQS deduplication id, and consumers deduplicate by eventId.
   */
  OutboxDuplicatePublishes: 'wager_outbox_duplicate_publishes_total',
  /** Gauge: age in seconds of the oldest event not published yet (0 when there is none). */
  OutboxLagSeconds: 'wager_outbox_lag_seconds',

  // ---- PENDING_REFERENCE worker (ADR-008)
  /** A waiting transaction found its reference and was decided. Label: status (PROCESSED | REJECTED). */
  PendingReferencesResolved: 'wager_pending_references_resolved_total',
  /** A waiting transaction gave up: REJECTED with REFERENCE_NOT_FOUND. */
  PendingReferencesExpired: 'wager_pending_references_expired_total',

  // ---- reconciliation (spec 9)
  /** A reconciliation found the stored balance different from the ledger. Never corrected. */
  ReconciliationDivergences: 'wager_reconciliation_divergences_total',
} as const;
export type MetricName = (typeof MetricName)[keyof typeof MetricName];

export type MetricLabels = Readonly<Record<string, string>>;

export interface Metrics {
  increment(name: MetricName, labels?: MetricLabels): void;
  /** A value that goes up and down (a gauge), such as the outbox lag. */
  setGauge(name: MetricName, value: number, labels?: MetricLabels): void;
}

export const METRICS = Symbol('METRICS');
