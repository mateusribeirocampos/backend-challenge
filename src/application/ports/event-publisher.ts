import type { OutboxMessage } from '../../domain/outbox/outbox-message.js';

/**
 * Sends one integration event to the broker (the SQS adapter sends it to
 * wagering-events.fifo). Called only by the outbox publisher, after the event was
 * committed, and never inside a SQL transaction.
 */
export interface EventPublisher {
  /**
   * Resolves when the broker confirmed the event; throws otherwise (the caller retries
   * later). A send can reach the broker and still throw (a timeout after delivery): the
   * retry sends a duplicate with the same deduplication id, and consumers deduplicate
   * by eventId.
   */
  publish(message: OutboxMessage): Promise<void>;
}

export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');
