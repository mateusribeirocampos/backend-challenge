import type { InboxMessage } from '../../domain/inbox/inbox-message.js';
import type { OutboxMessage } from '../../domain/outbox/outbox-message.js';
import type { WagerTransaction } from '../../domain/wager/wager-transaction.js';
import type { Wallet } from '../../domain/wallet/wallet.js';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry.js';

/**
 * Repositories bound to ONE SQL transaction (see TransactionRunner). Every write here
 * runs right away, in the order the use case calls it; the order matters because of
 * the foreign keys (wallet, then transaction, then ledger entry).
 */
export interface Repositories {
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: LedgerRepository;
  readonly outbox: OutboxRepository;
  readonly inbox: InboxRepository;
}

export interface WalletRepository {
  /** Inserts the wallet. false when the player already has a wallet in this currency. */
  insertIfAbsent(wallet: Wallet): Promise<boolean>;
  findById(walletId: string): Promise<Wallet | undefined>;
  /**
   * Reads the wallet and locks its row until the end of the transaction
   * (SELECT ... FOR NO KEY UPDATE, ADR-002). Another transaction asking for the same
   * row waits here; other wallets are not affected.
   */
  lockById(walletId: string): Promise<Wallet | undefined>;
  /** Writes balance, version and updatedAt. expectedVersion is the version read under the lock. */
  saveBalance(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface WagerTransactionRepository {
  /**
   * Insert-first idempotency (ADR-003): inserts the PENDING row unless the idempotency
   * key or (providerId, externalTransactionId) already exists, or the wallet does not
   * exist. true = this request owns the operation and must process it.
   */
  insertIfAbsent(transaction: WagerTransaction): Promise<boolean>;
  /** Plain insert, for the OPENING transaction of a new wallet. */
  insert(transaction: WagerTransaction): Promise<void>;
  findById(transactionId: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** True when a PROCESSED REFUND or ROLLBACK already points to this transaction. */
  hasProcessedReversal(transactionId: string): Promise<boolean>;
  /**
   * Writes the decided status and result columns, and the PENDING_REFERENCE schedule:
   * referenceAttempts (worker checks so far) and nextReferenceCheckAt, which the schema
   * requires when the status is PENDING_REFERENCE (when the worker should look again).
   */
  saveOutcome(transaction: WagerTransaction, options: ReferenceCheckSchedule): Promise<void>;
  /**
   * The PENDING_REFERENCE worker's pick (ADR-008): the waiting transaction whose next
   * check is the most overdue, locked with FOR NO KEY UPDATE SKIP LOCKED until the end
   * of the SQL transaction. A row another worker holds is skipped, not waited for, and
   * so are skipIds (rows that already failed in this batch).
   */
  lockNextDuePendingReference(now: Date, skipIds: readonly string[]): Promise<DuePendingReference | undefined>;
}

export interface ReferenceCheckSchedule {
  readonly referenceAttempts: number;
  /** undefined unless the transaction is (still) PENDING_REFERENCE. */
  readonly nextReferenceCheckAt: Date | undefined;
}

export interface DuePendingReference {
  readonly transaction: WagerTransaction;
  /** Worker checks already made (reference_attempts). */
  readonly referenceAttempts: number;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
}

/** What one publisher asks for when it claims a batch of the outbox. */
export interface OutboxClaim {
  /** New for every claim. Only the holder of this token releases or reschedules the rows. */
  readonly leaseToken: string;
  /** How long the rows stay reserved for this publisher (database clock). */
  readonly leaseMs: number;
  /** At most this many events. */
  readonly limit: number;
}

export interface OutboxRepository {
  add(messages: readonly OutboxMessage[]): Promise<void>;
  /**
   * Reserves a batch of due, unpublished events for this publisher (FOR UPDATE SKIP
   * LOCKED, then a lease). A wallet is taken whole or not at all: only wallets whose
   * OLDEST unpublished event is due and free, and then that event and the following
   * ones of the same wallet. Returned in the order they were written.
   */
  claimBatch(claim: OutboxClaim): Promise<OutboxMessage[]>;
  /** Writes publishedAt and clears the lease. false when another publisher had already marked it. */
  markPublished(message: OutboxMessage): Promise<boolean>;
  /** Writes attempts and nextAttemptAt and clears the lease, only if the lease is still this token's. */
  saveRetry(message: OutboxMessage, leaseToken: string): Promise<boolean>;
  /** Gives the events back untouched (no attempt counted), only where the lease is still this token's. */
  releaseLease(messageIds: readonly string[], leaseToken: string): Promise<number>;
  /** occurredAt of the oldest event not published yet, for the outbox lag. */
  oldestPendingOccurredAt(): Promise<Date | undefined>;
}

export interface InboxRepository {
  /**
   * Inserts the row unless (consumerName, messageId) already exists (ADR-005).
   * true = first time this consumer handles the message. If another transaction is
   * inserting the same pair, this call waits for it to finish first.
   */
  insertIfAbsent(message: InboxMessage): Promise<boolean>;
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  /** Writes processedAt. The row must exist and not be processed yet. */
  saveProcessed(message: InboxMessage): Promise<void>;
}
