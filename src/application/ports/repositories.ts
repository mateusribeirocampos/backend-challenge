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
   * Writes the decided status and result columns. nextReferenceCheckAt is required by
   * the schema when the status is PENDING_REFERENCE (when the worker should look again).
   */
  saveOutcome(transaction: WagerTransaction, options: { readonly nextReferenceCheckAt?: Date | undefined }): Promise<void>;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
}

export interface OutboxRepository {
  add(messages: readonly OutboxMessage[]): Promise<void>;
}
