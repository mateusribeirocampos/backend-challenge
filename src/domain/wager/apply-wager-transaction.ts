import type { Money } from '../money/money.js';
import { DomainInvariantError } from '../shared/domain-error.js';
import type { Wallet } from '../wallet/wallet.js';
import { LedgerDirection, type WalletLedgerEntry } from '../wallet/wallet-ledger-entry.js';
import { FailureCode } from './failure-code.js';
import { ALLOWED_REFERENCE_KINDS, isReversal, WagerTransactionKind } from './wager-transaction-kind.js';
import { WagerTransactionStatus } from './wager-transaction-status.js';
import type { WagerTransaction } from './wager-transaction.js';

export interface ApplyWagerTransactionInput {
  /** The wallet named by transaction.walletId, loaded and locked with SELECT ... FOR NO KEY UPDATE. */
  readonly wallet: Wallet;
  /** PENDING or PENDING_REFERENCE. */
  readonly transaction: WagerTransaction;
  /**
   * The transaction found by (transaction.providerId, transaction.referenceExternalTransactionId),
   * or undefined when it does not exist (yet). Always undefined when there is no reference.
   */
  readonly reference: WagerTransaction | undefined;
  /**
   * True when the reference already has a PROCESSED REFUND or ROLLBACK pointing to it.
   * Blocks a second reversal and the settlement (WIN/LOSS) of a reversed BET.
   */
  readonly referenceAlreadyReversed: boolean;
  /** Id for the ledger entry, used only if the balance moves. */
  readonly ledgerEntryId: string;
  readonly at: Date;
  /**
   * The PENDING_REFERENCE worker's final check: if the reference still does not
   * exist, the wait is over and the transaction is REJECTED with REFERENCE_NOT_FOUND. A
   * reference that exists but is still PENDING or PENDING_REFERENCE keeps it waiting.
   * Always false for a new submission.
   */
  readonly lastReferenceCheck?: boolean;
}

export type WagerOutcome =
  | {
      readonly status: typeof WagerTransactionStatus.Processed;
      /** undefined for LOSS, which never moves money. */
      readonly ledgerEntry: WalletLedgerEntry | undefined;
      readonly balance: Money;
    }
  | {
      readonly status: typeof WagerTransactionStatus.Rejected;
      readonly failureCode: FailureCode;
      /** Unchanged balance; undefined when the wallet belongs to another player. */
      readonly balance: Money | undefined;
    }
  | { readonly status: typeof WagerTransactionStatus.PendingReference };

/**
 * The business rules of spec section 7 in one pure function. It decides the outcome
 * and applies it to the objects in memory: the transaction changes status, and the
 * wallet changes balance only when the outcome is PROCESSED with a ledger entry.
 * Nothing is saved here. The use case runs this inside one SQL transaction, with the
 * wallet row locked, and writes wallet, ledger entry and transaction together.
 *
 * Order of the checks: first what only depends on the submitted payload, then what
 * depends on the reference's immutable fields (kind, owner, amount), then the
 * reference's status, and the balance last. A payload error is reported as such
 * even while the reference is still pending.
 */
export function applyWagerTransaction(input: ApplyWagerTransactionInput): WagerOutcome {
  assertPreconditions(input);
  const { wallet, transaction, at } = input;

  if (transaction.playerId !== wallet.playerId) {
    // Do not echo the balance of a wallet that belongs to someone else.
    return reject(input, FailureCode.WalletPlayerMismatch, undefined);
  }
  if (transaction.money.currency !== wallet.currency) {
    return reject(input, FailureCode.CurrencyMismatch, wallet.balance);
  }

  if (transaction.hasReference()) {
    const referenceProblem = checkReference(input);
    if (referenceProblem === 'WAIT') {
      if (input.lastReferenceCheck === true && input.reference === undefined) {
        // The wait is over and the reference never arrived. A reference that exists but
        // has not finished keeps this one waiting instead: when it ends, this one is
        // decided (PROCESSED, or REFERENCE_NOT_PROCESSED), never rejected before it.
        return reject(input, FailureCode.ReferenceNotFound, wallet.balance);
      }
      return waitForReference(transaction, at);
    }
    if (referenceProblem !== undefined) {
      return reject(input, referenceProblem, wallet.balance);
    }
  }

  return applyToBalance(input);
}

/** undefined = reference is usable; 'WAIT' = not there or not finished yet; otherwise the reason to reject. */
function checkReference(input: ApplyWagerTransactionInput): FailureCode | 'WAIT' | undefined {
  const { transaction, reference } = input;
  if (reference === undefined) {
    return 'WAIT';
  }
  if (!ALLOWED_REFERENCE_KINDS[transaction.kind].includes(reference.kind)) {
    return FailureCode.ReferenceInvalidKind;
  }
  if (!belongsToSameRound(transaction, reference)) {
    return FailureCode.ReferenceMismatch;
  }
  if (isReversal(transaction.kind) && !transaction.money.equals(reference.money)) {
    return FailureCode.AmountMismatch;
  }
  if (!reference.isTerminal()) {
    // PENDING or PENDING_REFERENCE: it may still be processed, rejecting now would be premature.
    return 'WAIT';
  }
  if (reference.status !== WagerTransactionStatus.Processed) {
    return FailureCode.ReferenceNotProcessed;
  }
  // A reversed transaction cannot be reversed again nor settled: a WIN or
  // LOSS for a BET that was already refunded or rolled back is refused too.
  if (input.referenceAlreadyReversed) {
    return FailureCode.ReferenceAlreadyReversed;
  }
  return undefined;
}

/** Spec section 7 rule 2: same provider, player, wallet, currency and round. */
function belongsToSameRound(transaction: WagerTransaction, reference: WagerTransaction): boolean {
  return (
    reference.providerId === transaction.providerId &&
    reference.playerId === transaction.playerId &&
    reference.walletId === transaction.walletId &&
    reference.money.currency === transaction.money.currency &&
    reference.roundId === transaction.roundId
  );
}

function applyToBalance(input: ApplyWagerTransactionInput): WagerOutcome {
  const { wallet, transaction, reference, at } = input;

  if (!transaction.affectsBalance()) {
    // LOSS: the result is recorded, the balance does not move and there is no ledger entry.
    transaction.markProcessed({ referenceTransactionId: reference?.id, resultBalance: wallet.balance, at });
    return { status: WagerTransactionStatus.Processed, ledgerEntry: undefined, balance: wallet.balance };
  }

  const direction = transaction.ledgerDirectionFor(reference);
  if (direction === LedgerDirection.Debit && !wallet.canDebit(transaction.money)) {
    // Spec rule 9: a reversal without funds is a different situation from a bet without funds.
    const code = isReversal(transaction.kind) ? FailureCode.ReversalWouldOverdraw : FailureCode.InsufficientFunds;
    return reject(input, code, wallet.balance);
  }
  if (direction === LedgerDirection.Credit && !wallet.canCredit(transaction.money)) {
    // The balance column has a ceiling; refusing here keeps it a recorded business answer
    // instead of a numeric overflow (22003) that would only surface as a 500.
    return reject(input, FailureCode.BalanceLimitExceeded, wallet.balance);
  }

  const movement = {
    ledgerEntryId: input.ledgerEntryId,
    transactionId: transaction.id,
    money: transaction.money,
    at,
  };
  const ledgerEntry = direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
  transaction.markProcessed({ referenceTransactionId: reference?.id, resultBalance: wallet.balance, at });
  return { status: WagerTransactionStatus.Processed, ledgerEntry, balance: wallet.balance };
}

function reject(input: ApplyWagerTransactionInput, failureCode: FailureCode, balance: Money | undefined): WagerOutcome {
  input.transaction.reject(failureCode, {
    referenceTransactionId: input.reference?.id,
    resultBalance: balance,
    at: input.at,
  });
  return { status: WagerTransactionStatus.Rejected, failureCode, balance };
}

function waitForReference(transaction: WagerTransaction, at: Date): WagerOutcome {
  // A retry of a transaction that is already waiting keeps waiting; it is not a new transition.
  if (transaction.status === WagerTransactionStatus.Pending) {
    transaction.markPendingReference(at);
  }
  return { status: WagerTransactionStatus.PendingReference };
}

/** Caller bugs, not business outcomes: they throw instead of rejecting. */
function assertPreconditions(input: ApplyWagerTransactionInput): void {
  const { wallet, transaction, reference } = input;
  if (transaction.isTerminal()) {
    throw new DomainInvariantError(`Transaction ${transaction.id} is already ${transaction.status}`);
  }
  if (transaction.kind === WagerTransactionKind.Opening) {
    throw new DomainInvariantError('OPENING is applied by Wallet.open, not here');
  }
  if (transaction.walletId !== wallet.id) {
    throw new DomainInvariantError(`Transaction ${transaction.id} is for wallet ${transaction.walletId}, got ${wallet.id}`);
  }
  if (reference === undefined) {
    return;
  }
  const isTheNamedReference =
    reference.providerId === transaction.providerId &&
    reference.externalTransactionId === transaction.referenceExternalTransactionId;
  if (!isTheNamedReference) {
    throw new DomainInvariantError(
      `Reference ${reference.providerId}/${reference.externalTransactionId} is not the one transaction ${transaction.id} names`,
    );
  }
}
