/**
 * Errors of the application layer. Each one has a stable code: the HTTP layer maps
 * it to a status and the SQS consumer maps it to ack, retry or DLQ.
 * Business rejections are NOT errors: they are stored results (REJECTED + failureCode).
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The same request may succeed if sent again with the same key (lock timeout, deadlock, database down). */
export class TransientInfrastructureError extends ApplicationError {
  readonly code = 'TRANSIENT_FAILURE';
}

/**
 * The transient failure was contention on a row (lock timeout 55P03, deadlock 40P01,
 * serialization 40001): the database is up and another transaction was in the way. Worth
 * retrying in a few milliseconds, in the same process. Same code as its parent, so HTTP
 * still answers 503 TRANSIENT_FAILURE exactly as before.
 */
export class LockContentionError extends TransientInfrastructureError {}

/** Same Idempotency-Key, different business payload: a conflict, never a replay (spec 6.3). */
export class IdempotencyKeyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_KEY_CONFLICT';

  constructor(readonly idempotencyKey: string) {
    super(`Idempotency key ${idempotencyKey} was already used with a different payload`);
  }
}

/** The (providerId, externalTransactionId) pair already exists under another idempotency key. */
export class ExternalTransactionIdConflictError extends ApplicationError {
  readonly code = 'EXTERNAL_TRANSACTION_ID_CONFLICT';

  constructor(
    readonly providerId: string,
    readonly externalTransactionId: string,
  ) {
    super(`Transaction ${externalTransactionId} of ${providerId} already exists under another idempotency key`);
  }
}

/**
 * The inbox already has this messageId for this consumer, but with different data.
 * A redelivery always carries the same data, so the producer reused an id: the
 * message is not processed and goes to the DLQ for someone to look at.
 */
export class MessageIdConflictError extends ApplicationError {
  readonly code = 'MESSAGE_ID_CONFLICT';

  constructor(consumerName: string, messageId: string) {
    super(`Message ${messageId} was already handled by ${consumerName} with different data`);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';

  constructor(playerId: string, currency: string) {
    super(`Player ${playerId} already has a ${currency} wallet`);
  }
}

/** The currency is a valid ISO-4217 code, but the platform does not operate it (SUPPORTED_CURRENCIES). */
export class CurrencyNotSupportedError extends ApplicationError {
  readonly code = 'CURRENCY_NOT_SUPPORTED';

  constructor(currency: string, supported: readonly string[]) {
    super(`Currency ${currency} is not operated by this platform (supported: ${supported.join(', ')})`);
  }
}

export class WalletNotFoundError extends ApplicationError {
  readonly code = 'WALLET_NOT_FOUND';

  constructor(walletId: string) {
    super(`Wallet ${walletId} not found`);
  }
}

export class WagerTransactionNotFoundError extends ApplicationError {
  readonly code = 'TRANSACTION_NOT_FOUND';

  constructor(description: string) {
    super(`Transaction ${description} not found`);
  }
}
