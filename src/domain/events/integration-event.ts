/** What every event needs besides its data. The use case fills it (ids and clock come from outside). */
export interface EventContext {
  readonly eventId: string;
  /** Ties together everything caused by one request or message (X-Correlation-Id on HTTP). */
  readonly correlationId: string;
  /** Id of the message that caused this event (the SQS messageId). undefined for HTTP. */
  readonly causationId?: string | undefined;
  readonly occurredAt: Date;
}

export interface IntegrationEventProps<T> extends EventContext {
  readonly aggregateId: string;
  readonly data: T;
}

/** The serialized envelope stored in outbox_messages.payload and published as is. */
export interface IntegrationEventEnvelope<T> {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  /** ISO-8601. */
  readonly occurredAt: string;
  readonly version: number;
  readonly data: T;
}

/**
 * Base of every integration event (spec 11). eventType and version are declared by
 * each subclass, so a call site can never pair a payload with the wrong type string.
 * data must be plain JSON (MoneyProps, never Money): it is what goes to the outbox.
 */
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId: string | undefined;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    // The instance itself is not frozen: the subclass fields (eventType, version) are
    // defined after this constructor returns. Freezing data is what matters.
    this.data = deepFreeze(props.data);
  }

  toJSON(): IntegrationEventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId === undefined ? {} : { causationId: this.causationId }),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}
