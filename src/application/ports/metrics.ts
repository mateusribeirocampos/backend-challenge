/**
 * Counters of the message flow (spec 12). The names follow the Prometheus convention
 * (_total for counters); the adapter that exposes them comes with the observability work.
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
} as const;
export type MetricName = (typeof MetricName)[keyof typeof MetricName];

export type MetricLabels = Readonly<Record<string, string>>;

export interface Metrics {
  increment(name: MetricName, labels?: MetricLabels): void;
}

export const METRICS = Symbol('METRICS');
