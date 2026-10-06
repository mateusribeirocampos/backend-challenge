import { Money } from '../money/money.js';
import { DomainError, DomainInvariantError } from '../shared/domain-error.js';
import { LedgerDirection } from '../wallet/wallet-ledger-entry.js';
import { ContractViolationCode, type FailureCode } from './failure-code.js';
import {
  ALLOWED_REFERENCE_KINDS,
  isWagerTransactionKind,
  WagerTransactionKind,
} from './wager-transaction-kind.js';
import { canTransition, isTerminalStatus, WagerTransactionStatus } from './wager-transaction-status.js';

/** providerId used only by OPENING rows. A real provider cannot use it. */
export const INTERNAL_PROVIDER_ID = 'internal';

/** Separates the provider namespace from the rest of an idempotency key: "provider-a:transaction-123". */
export const IDEMPOTENCY_NAMESPACE_SEPARATOR = ':';

/** The transaction cannot be created as submitted. Never stored; the payload must be fixed. */
export class InvalidWagerTransactionError extends DomainError {
  constructor(
    readonly code: ContractViolationCode,
    message: string,
  ) {
    super(message);
  }
}

/** A transition the state machine does not allow. A programming error, not a business outcome. */
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';

  constructor(
    readonly transactionId: string,
    readonly from: WagerTransactionStatus,
    readonly to: WagerTransactionStatus,
  ) {
    super(`Transaction ${transactionId} cannot go from ${from} to ${to}`);
  }
}

/** Fields a provider submits (already parsed: money is a Money, the hash is computed). */
export interface CreateWagerTransactionProps {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId?: string | undefined;
  readonly createdAt: Date;
}

export interface CreateOpeningTransactionProps {
  readonly id: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly money: Money;
  readonly at: Date;
}

/** Everything stored for a transaction, as read back from the database. */
export interface WagerTransactionState {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  /** undefined only for OPENING, which is never compared against a resubmission. */
  readonly payloadHash: string | undefined;
  readonly walletId: string;
  readonly playerId: string;
  /** undefined only for OPENING, which does not belong to a game round. */
  readonly roundId: string | undefined;
  readonly gameId: string | undefined;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | undefined;
  readonly createdAt: Date;
  readonly status: WagerTransactionStatus;
  readonly referenceTransactionId: string | undefined;
  readonly failureCode: FailureCode | undefined;
  /** Wallet balance observed when the transaction was decided; returned again on replay (ADR-003). */
  readonly resultBalance: Money | undefined;
  readonly processedAt: Date | undefined;
  readonly updatedAt: Date;
}

export interface MarkProcessedProps {
  readonly referenceTransactionId: string | undefined;
  readonly resultBalance: Money;
  readonly at: Date;
}

export interface RejectProps {
  /** Internal id of the reference, when it was resolved before the rejection (audit). */
  readonly referenceTransactionId?: string | undefined;
  /** Balance observed. undefined when it must not be revealed (wallet of another player). */
  readonly resultBalance?: Money | undefined;
  readonly at: Date;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * One operation of a provider (or the internal OPENING credit). The identity and the
 * business fields never change; only the status moves, through the methods below,
 * and only along ALLOWED_TRANSITIONS.
 */
export class WagerTransaction {
  private readonly state: Mutable<WagerTransactionState>;

  private constructor(state: WagerTransactionState) {
    this.state = { ...state };
  }

  /** A transaction submitted by a provider. Starts PENDING. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    WagerTransaction.assertSubmittable(props);
    return new WagerTransaction({
      id: props.id,
      providerId: props.providerId,
      externalTransactionId: props.externalTransactionId,
      idempotencyKey: props.idempotencyKey,
      payloadHash: props.payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: props.roundId,
      gameId: props.gameId,
      kind: props.kind,
      money: props.money,
      referenceExternalTransactionId: props.referenceExternalTransactionId,
      createdAt: props.createdAt,
      status: WagerTransactionStatus.Pending,
      referenceTransactionId: undefined,
      failureCode: undefined,
      resultBalance: undefined,
      processedAt: undefined,
      updatedAt: props.createdAt,
    });
  }

  /**
   * The internal credit of a wallet's initial balance. Only Wallet.open calls it.
   * It is born PROCESSED because it is written in the same SQL transaction as the wallet.
   */
  static createOpening(props: CreateOpeningTransactionProps): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvalidWagerTransactionError(
        ContractViolationCode.InvalidAmount,
        'OPENING exists only for an initial balance greater than zero',
      );
    }
    const externalTransactionId = `opening-${props.walletId}`;
    const transaction = new WagerTransaction({
      id: props.id,
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId,
      idempotencyKey: `${INTERNAL_PROVIDER_ID}${IDEMPOTENCY_NAMESPACE_SEPARATOR}${externalTransactionId}`,
      payloadHash: undefined,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: undefined,
      gameId: undefined,
      kind: WagerTransactionKind.Opening,
      money: props.money,
      referenceExternalTransactionId: undefined,
      createdAt: props.at,
      status: WagerTransactionStatus.Pending,
      referenceTransactionId: undefined,
      failureCode: undefined,
      resultBalance: undefined,
      processedAt: undefined,
      updatedAt: props.at,
    });
    transaction.markProcessed({ referenceTransactionId: undefined, resultBalance: props.money, at: props.at });
    return transaction;
  }

  /** Rebuilds a stored transaction as it is. Does not check transitions (spec 6.0). */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get id(): string { return this.state.id; }
  get providerId(): string { return this.state.providerId; }
  get externalTransactionId(): string { return this.state.externalTransactionId; }
  get idempotencyKey(): string { return this.state.idempotencyKey; }
  get payloadHash(): string | undefined { return this.state.payloadHash; }
  get walletId(): string { return this.state.walletId; }
  get playerId(): string { return this.state.playerId; }
  get roundId(): string | undefined { return this.state.roundId; }
  get gameId(): string | undefined { return this.state.gameId; }
  get kind(): WagerTransactionKind { return this.state.kind; }
  get money(): Money { return this.state.money; }
  get referenceExternalTransactionId(): string | undefined { return this.state.referenceExternalTransactionId; }
  get createdAt(): Date { return this.state.createdAt; }
  get status(): WagerTransactionStatus { return this.state.status; }
  get referenceTransactionId(): string | undefined { return this.state.referenceTransactionId; }
  get failureCode(): FailureCode | undefined { return this.state.failureCode; }
  get resultBalance(): Money | undefined { return this.state.resultBalance; }
  get processedAt(): Date | undefined { return this.state.processedAt; }
  get updatedAt(): Date { return this.state.updatedAt; }

  // ---- transitions (throw InvalidTransactionStateError when ALLOWED_TRANSITIONS says no)

  markProcessed(props: MarkProcessedProps): void {
    this.transitionTo(WagerTransactionStatus.Processed, props.at);
    this.state.referenceTransactionId = props.referenceTransactionId;
    this.state.resultBalance = props.resultBalance;
    this.state.processedAt = props.at;
  }

  markPendingReference(at: Date): void {
    this.transitionTo(WagerTransactionStatus.PendingReference, at);
  }

  reject(code: FailureCode, props: RejectProps): void {
    this.transitionTo(WagerTransactionStatus.Rejected, props.at);
    this.state.failureCode = code;
    this.state.referenceTransactionId = props.referenceTransactionId;
    this.state.resultBalance = props.resultBalance;
  }

  fail(code: FailureCode, at: Date): void {
    this.transitionTo(WagerTransactionStatus.Failed, at);
    this.state.failureCode = code;
  }

  // ---- domain queries

  isTerminal(): boolean {
    return isTerminalStatus(this.state.status);
  }

  /** false only for LOSS, which records a result without moving money. */
  affectsBalance(): boolean {
    return this.state.kind !== WagerTransactionKind.Loss;
  }

  /** REFUND and ROLLBACK must point to the transaction they revert (spec rule 1). */
  requiresReference(): boolean {
    return this.state.kind === WagerTransactionKind.Refund || this.state.kind === WagerTransactionKind.Rollback;
  }

  hasReference(): boolean {
    return this.state.referenceExternalTransactionId !== undefined;
  }

  /**
   * Same idempotency key + same hash = replay; same key + different hash = conflict
   * (spec 6.3). OPENING has no hash and never matches.
   */
  matchesPayload(payloadHash: string): boolean {
    return this.state.payloadHash !== undefined && this.state.payloadHash === payloadHash;
  }

  /**
   * Which way this transaction moves the balance. BET debits; WIN, REFUND and OPENING
   * credit; ROLLBACK does the opposite of its reference. LOSS moves nothing and throws.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.state.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback:
        return WagerTransaction.opposite(this.rollbackTarget(reference).ledgerDirectionFor());
      case WagerTransactionKind.Loss:
        throw new DomainInvariantError(`LOSS ${this.state.id} does not move the balance`);
    }
  }

  private rollbackTarget(reference: WagerTransaction | undefined): WagerTransaction {
    if (reference === undefined) {
      throw new DomainInvariantError(`ROLLBACK ${this.state.id} needs its reference to know the direction`);
    }
    if (!ALLOWED_REFERENCE_KINDS.ROLLBACK.includes(reference.kind)) {
      throw new DomainInvariantError(`ROLLBACK cannot revert a ${reference.kind}`);
    }
    return reference;
  }

  private transitionTo(next: WagerTransactionStatus, at: Date): void {
    if (!canTransition(this.state.status, next)) {
      throw new InvalidTransactionStateError(this.state.id, this.state.status, next);
    }
    this.state.status = next;
    this.state.updatedAt = at;
  }

  private static opposite(direction: LedgerDirection): LedgerDirection {
    return direction === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
  }

  private static assertSubmittable(props: CreateWagerTransactionProps): void {
    const required = {
      id: props.id,
      providerId: props.providerId,
      externalTransactionId: props.externalTransactionId,
      idempotencyKey: props.idempotencyKey,
      payloadHash: props.payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: props.roundId,
      gameId: props.gameId,
    };
    for (const [field, value] of Object.entries(required)) {
      if (typeof value !== 'string' || value.trim() === '') {
        throw new InvalidWagerTransactionError(ContractViolationCode.MissingField, `${field} is required`);
      }
    }

    if (!isWagerTransactionKind(props.kind)) {
      throw new InvalidWagerTransactionError(ContractViolationCode.UnknownKind, `Unknown kind ${String(props.kind)}`);
    }
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError(
        ContractViolationCode.InternalKindNotAllowed,
        'OPENING is internal and cannot be submitted',
      );
    }
    if (props.providerId === INTERNAL_PROVIDER_ID) {
      throw new InvalidWagerTransactionError(
        ContractViolationCode.ReservedProviderId,
        `providerId "${INTERNAL_PROVIDER_ID}" is reserved`,
      );
    }
    WagerTransaction.assertIdempotencyNamespace(props.providerId, props.idempotencyKey);

    WagerTransaction.assertReferenceShape(props);
    WagerTransaction.assertAmount(props.kind, props.money);
  }

  /**
   * Every key lives in its provider's namespace: "{providerId}:{anything}". The key is the
   * source of truth for idempotency, so a key outside the namespace would let one
   * provider collide with (or block) another provider's operations, or with the
   * "internal:" keys of OPENING. A ":" inside providerId would make two namespaces
   * overlap ("a" and "a:b" both own "a:b:x"), so it is refused too.
   */
  private static assertIdempotencyNamespace(providerId: string, idempotencyKey: string): void {
    if (providerId.includes(IDEMPOTENCY_NAMESPACE_SEPARATOR)) {
      throw new InvalidWagerTransactionError(
        ContractViolationCode.InvalidFormat,
        `providerId cannot contain "${IDEMPOTENCY_NAMESPACE_SEPARATOR}"`,
      );
    }
    const namespace = `${providerId}${IDEMPOTENCY_NAMESPACE_SEPARATOR}`;
    if (!idempotencyKey.startsWith(namespace) || idempotencyKey.length === namespace.length) {
      throw new InvalidWagerTransactionError(
        ContractViolationCode.IdempotencyKeyInvalid,
        `Idempotency key must start with "${namespace}" followed by the operation id`,
      );
    }
  }

  private static assertReferenceShape(props: CreateWagerTransactionProps): void {
    const reference = props.referenceExternalTransactionId;
    const allowedKinds = ALLOWED_REFERENCE_KINDS[props.kind];

    if (reference === undefined || reference.trim() === '') {
      if (props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback) {
        throw new InvalidWagerTransactionError(
          ContractViolationCode.ReferenceRequired,
          `${props.kind} requires referenceExternalTransactionId`,
        );
      }
      if (reference !== undefined) {
        throw new InvalidWagerTransactionError(ContractViolationCode.MissingField, 'referenceExternalTransactionId is blank');
      }
      return;
    }
    if (allowedKinds.length === 0) {
      throw new InvalidWagerTransactionError(
        ContractViolationCode.ReferenceNotAllowed,
        `${props.kind} cannot reference another transaction`,
      );
    }
    if (reference === props.externalTransactionId) {
      throw new InvalidWagerTransactionError(ContractViolationCode.SelfReference, 'A transaction cannot reference itself');
    }
  }

  /**
   * BET, WIN, REFUND and ROLLBACK must move money, so they need amount > 0.
   * LOSS never moves money and accepts >= 0 (the provider may send the stake or zero).
   * A zero WIN is refused: a win of zero is a LOSS (vault ADR-009).
   */
  private static assertAmount(kind: WagerTransactionKind, money: Money): void {
    if (money.isNegative()) {
      throw new InvalidWagerTransactionError(ContractViolationCode.InvalidAmount, 'Amount cannot be negative');
    }
    if (kind !== WagerTransactionKind.Loss && money.isZero()) {
      throw new InvalidWagerTransactionError(
        ContractViolationCode.InvalidAmount,
        `${kind} amount must be greater than zero`,
      );
    }
  }
}
