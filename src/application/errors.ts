/**
 * Errors of the application layer. Each one has a stable code: the HTTP layer maps
 * it to a status (ADR-007) and the SQS consumer will map it to ack, retry or DLQ.
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

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';

  constructor(playerId: string, currency: string) {
    super(`Player ${playerId} already has a ${currency} wallet`);
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
