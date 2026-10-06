/**
 * Stable, machine readable reasons stored in wager_transactions.failure_code.
 * The text of a code never changes once released: providers branch on it.
 * Each one answers "should the provider resend, fix the payload or give up?".
 * Full table with the provider action: vault note "Taxonomia de failureCode".
 */
export const FailureCode = {
  // ---- REJECTED: business rule, terminal. Resending the same payload gives the same answer.
  /** BET larger than the balance. */
  InsufficientFunds: 'INSUFFICIENT_FUNDS',
  /** A reversal (ROLLBACK of a WIN or REFUND) would leave the balance negative. Spec rule 9. */
  ReversalWouldOverdraw: 'REVERSAL_WOULD_OVERDRAW',
  /** Transaction currency differs from the wallet currency. */
  CurrencyMismatch: 'CURRENCY_MISMATCH',
  /** The wallet exists but belongs to another player. */
  WalletPlayerMismatch: 'WALLET_PLAYER_MISMATCH',
  /** Reference resolved, but of a kind this transaction cannot point to (e.g. REFUND of a WIN). */
  ReferenceInvalidKind: 'REFERENCE_INVALID_KIND',
  /** Reference belongs to another player, wallet, currency or round. Spec rule 2. */
  ReferenceMismatch: 'REFERENCE_MISMATCH',
  /** REFUND/ROLLBACK amount differs from the referenced amount. Spec rule 5. */
  AmountMismatch: 'AMOUNT_MISMATCH',
  /** Reference ended REJECTED or FAILED: there is nothing to settle or revert. */
  ReferenceNotProcessed: 'REFERENCE_NOT_PROCESSED',
  /**
   * Reference already has a PROCESSED reversal, of any kind (ADR-008). Applies to a second
   * REFUND/ROLLBACK and also to a WIN/LOSS that tries to settle a reversed BET.
   */
  ReferenceAlreadyReversed: 'REFERENCE_ALREADY_REVERSED',
  /** PENDING_REFERENCE gave up: the reference never arrived (ADR-008 part B, worker). */
  ReferenceNotFound: 'REFERENCE_NOT_FOUND',

  // ---- FAILED: permanent infrastructure error, terminal, kept for audit (Slice 3 on).
  PermanentInfrastructureError: 'PERMANENT_INFRASTRUCTURE_ERROR',
} as const;
export type FailureCode = (typeof FailureCode)[keyof typeof FailureCode];

/**
 * Why a submitted transaction cannot even be created. These are contract errors
 * (HTTP 400 / SQS terminal), never stored: the payload has to be fixed first.
 */
export const ContractViolationCode = {
  /** A required text field is missing or blank. */
  MissingField: 'MISSING_FIELD',
  /** kind is not one of the known kinds. */
  UnknownKind: 'UNKNOWN_KIND',
  /** OPENING submitted from outside. Spec 6.3: OPENING is internal. */
  InternalKindNotAllowed: 'INTERNAL_KIND_NOT_ALLOWED',
  /** providerId "internal" is reserved for OPENING transactions. */
  ReservedProviderId: 'RESERVED_PROVIDER_ID',
  /** REFUND/ROLLBACK without referenceExternalTransactionId. Spec rule 1. */
  ReferenceRequired: 'REFERENCE_REQUIRED',
  /** BET with a reference: a bet never points to another transaction. */
  ReferenceNotAllowed: 'REFERENCE_NOT_ALLOWED',
  /** The transaction points to itself. */
  SelfReference: 'SELF_REFERENCE',
  /** Zero amount where the kind must move the balance (BET, WIN, REFUND, ROLLBACK). */
  InvalidAmount: 'INVALID_AMOUNT',
  /**
   * The idempotency key is not inside the provider namespace "{providerId}:...". Without
   * this, provider B could take provider A's keys, or the reserved "internal:" ones.
   */
  IdempotencyKeyInvalid: 'IDEMPOTENCY_KEY_INVALID',
  /** A field has the wrong shape (not a UUID, a providerId with ":", a control character, text too long). */
  InvalidFormat: 'INVALID_FORMAT',
  /** Money that Money.from refuses: NaN, "1e3", "1.234", "-5.00", "brl"... */
  InvalidMoney: 'INVALID_MONEY',
} as const;
export type ContractViolationCode = (typeof ContractViolationCode)[keyof typeof ContractViolationCode];
