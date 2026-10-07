/** A value in a log line. Flat values only, so every field can be searched as is. */
export type LogValue = string | number | boolean | undefined;
export type LogFields = Readonly<Record<string, LogValue>>;

/**
 * Structured logs (spec 12): one JSON object per line, an event name plus flat fields
 * such as messageId, transactionId, walletId, providerId and correlationId.
 * Never a full financial payload.
 */
export interface StructuredLogger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export const STRUCTURED_LOGGER = Symbol('STRUCTURED_LOGGER');
