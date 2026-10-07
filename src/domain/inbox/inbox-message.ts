import { DomainError, DomainInvariantError } from '../shared/domain-error.js';

/** The message cannot be recorded as received (blank key or hash). */
export class InvalidInboxMessageError extends DomainError {
  readonly code = 'INVALID_INBOX_MESSAGE';
}

export interface ReceiveInboxProps {
  /** The logical consumer, the same on every instance. Not an instance id. */
  readonly consumerName: string;
  /** The producer's id of the message (envelope.messageId), stable across redeliveries. */
  readonly messageId: string;
  /** Hash of the message data: tells a redelivery apart from a reused messageId. */
  readonly payloadHash: string;
  readonly receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  readonly processedAt: Date | undefined;
}

/**
 * One message a consumer has handled (spec 6.5, ADR-005). The pair (consumerName,
 * messageId) is the primary key of inbox_messages: a redelivered message finds its
 * row and is not processed again. The row is written in the same SQL transaction as
 * the effect of the message, so "row exists" and "effect exists" are the same fact.
 */
export class InboxMessage {
  private constructor(
    readonly consumerName: string,
    readonly messageId: string,
    readonly payloadHash: string,
    readonly receivedAt: Date,
    private _processedAt: Date | undefined,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    for (const [field, value] of Object.entries({
      consumerName: props.consumerName,
      messageId: props.messageId,
      payloadHash: props.payloadHash,
    })) {
      if (value.trim() === '') {
        throw new InvalidInboxMessageError(`${field} is required`);
      }
    }
    return new InboxMessage(props.consumerName, props.messageId, props.payloadHash, props.receivedAt, undefined);
  }

  /** Rebuilds a stored row as it is. No checks (spec 6.0). */
  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(state.consumerName, state.messageId, state.payloadHash, state.receivedAt, state.processedAt);
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  /** Same hash: the same message again. Another hash: the producer reused the messageId. */
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * No check that `at` comes after receivedAt: both are wall clock readings, and a
   * clock adjusted backwards between them must not fail a valid message.
   */
  markProcessed(at: Date): void {
    if (this._processedAt !== undefined) {
      throw new DomainInvariantError(`Inbox message ${this.messageId} was already processed`);
    }
    this._processedAt = at;
  }
}
