import { describe, expect, test } from 'bun:test';
import { MetricName } from '../../../../src/application/ports/metrics.js';
import type { Repositories } from '../../../../src/application/ports/repositories.js';
import type { TransactionRunner } from '../../../../src/application/ports/transaction-runner.js';
import {
  type PendingReferenceSettings,
  ResolvePendingReferences,
} from '../../../../src/application/wagering/resolve-pending-references.js';
import type { OutboxMessage } from '../../../../src/domain/outbox/outbox-message.js';
import { FailureCode } from '../../../../src/domain/wager/failure-code.js';
import { WagerTransactionKind } from '../../../../src/domain/wager/wager-transaction-kind.js';
import type { WagerTransaction } from '../../../../src/domain/wager/wager-transaction.js';
import type { Wallet } from '../../../../src/domain/wallet/wallet.js';
import type { WalletLedgerEntry } from '../../../../src/domain/wallet/wallet-ledger-entry.js';
import { InMemoryMetrics } from '../../../../src/infrastructure/observability/in-memory-metrics.js';
import { CapturingLogger } from '../../../integration/support/capturing-logger.js';
import { AT, brl, LATER, submitted, walletWith } from '../../domain/support/domain-fixtures.js';

/**
 * The PENDING_REFERENCE worker's use case with the repositories replaced by in-memory
 * fakes. The row lock (FOR NO KEY UPDATE SKIP LOCKED) and the wallet lock are proven
 * against PostgreSQL in test/integration/wagering/pending-reference-worker.test.ts.
 */
const SETTINGS: PendingReferenceSettings = {
  batchSize: 5,
  // random 1: the next check is exactly the exponential step.
  wait: { maxAttempts: 10, baseDelayMs: 1_000, maxDelayMs: 60_000, random: () => 1 },
};

interface Due {
  readonly transaction: WagerTransaction;
  readonly referenceAttempts: number;
}

interface SavedOutcome {
  readonly id: string;
  readonly status: string;
  readonly failureCode: string | undefined;
  readonly referenceAttempts: number;
  readonly nextReferenceCheckAt: Date | undefined;
}

/** What the worker would find in the database, and everything it writes. */
class FakeDatabase {
  readonly due: Due[] = [];
  readonly stored: WagerTransaction[] = [];
  readonly outcomes: SavedOutcome[] = [];
  readonly ledger: WalletLedgerEntry[] = [];
  readonly events: OutboxMessage[] = [];
  readonly savedBalances: string[] = [];
  readonly skipRequests: string[][] = [];
  /** Wallet ids whose lock fails (lock timeout), as a hot or broken row would. */
  readonly failingWallets = new Set<string>();
  /** Transaction ids whose SQL transaction fails at COMMIT (a deferred constraint trigger, say). */
  readonly commitFailsFor = new Set<string>();
  lastPicked: string | undefined;

  constructor(readonly wallet: Wallet) {}

  repositories(): Repositories {
    return {
      transactions: {
        lockNextDuePendingReference: async (_now: Date, skipIds: readonly string[]) => {
          this.skipRequests.push([...skipIds]);
          const index = this.due.findIndex((due) => !skipIds.includes(due.transaction.id));
          const picked = index === -1 ? undefined : this.due.splice(index, 1)[0];
          this.lastPicked = picked?.transaction.id;
          return picked;
        },
        findByProviderAndExternalId: async (providerId: string, externalId: string) =>
          this.stored.find((t) => t.providerId === providerId && t.externalTransactionId === externalId),
        hasProcessedReversal: async () => false,
        saveOutcome: async (
          transaction: WagerTransaction,
          options: { referenceAttempts: number; nextReferenceCheckAt: Date | undefined },
        ) => {
          this.outcomes.push({
            id: transaction.id,
            status: transaction.status,
            failureCode: transaction.failureCode,
            referenceAttempts: options.referenceAttempts,
            nextReferenceCheckAt: options.nextReferenceCheckAt,
          });
        },
      },
      wallets: {
        lockById: async (walletId: string) => {
          if (this.failingWallets.has(walletId)) throw new Error('lock timeout');
          return this.wallet;
        },
        saveBalance: async (wallet: Wallet) => {
          this.savedBalances.push(wallet.balance.amount);
        },
      },
      ledger: { append: async (entry: WalletLedgerEntry) => void this.ledger.push(entry) },
      outbox: { add: async (messages: readonly OutboxMessage[]) => void this.events.push(...messages) },
    } as unknown as Repositories;
  }
}

function pendingRefund(): WagerTransaction {
  const refund = submitted({
    kind: WagerTransactionKind.Refund,
    money: brl('25.00'),
    externalTransactionId: 'r1',
    referenceExternalTransactionId: 'b1',
  });
  refund.markPendingReference(AT);
  return refund;
}

function processedBet(): WagerTransaction {
  const bet = submitted({ kind: WagerTransactionKind.Bet, money: brl('25.00'), externalTransactionId: 'b1' });
  bet.markProcessed({ referenceTransactionId: undefined, resultBalance: brl('75.00'), at: AT });
  return bet;
}

function harness(balance = '75.00') {
  const database = new FakeDatabase(walletWith(brl(balance)));
  const metrics = new InMemoryMetrics();
  const logs = new CapturingLogger();
  let transactions = 0;
  const runner: TransactionRunner = {
    run: async (work) => {
      transactions += 1;
      database.lastPicked = undefined;
      const result = await work(database.repositories());
      // The callback finished; the failure comes from the COMMIT itself.
      if (database.lastPicked !== undefined && database.commitFailsFor.has(database.lastPicked)) {
        throw new Error('deferred trigger refused the commit');
      }
      return result;
    },
  };
  let nextId = 0;
  const worker = new ResolvePendingReferences(
    runner,
    { now: () => LATER },
    { newId: () => `id-${++nextId}` },
    metrics,
    logs,
    SETTINGS,
  );
  return { database, metrics, logs, worker, transactionCount: () => transactions };
}

describe('ResolvePendingReferences', () => {
  test('nothing due: no check, nothing written', async () => {
    const { database, worker } = harness();

    expect(await worker.resolveBatch()).toEqual({ checked: 0, resolved: 0, stillWaiting: 0, expired: 0, failed: 0 });
    expect(database.outcomes).toEqual([]);
  });

  test('reference still missing on check 3 of 10: keeps waiting, attempts 3, next check 4 s later, no new event', async () => {
    const { database, worker } = harness();
    const refund = pendingRefund();
    database.due.push({ transaction: refund, referenceAttempts: 2 });

    const result = await worker.resolveBatch();

    expect(result).toEqual({ checked: 1, resolved: 0, stillWaiting: 1, expired: 0, failed: 0 });
    expect(database.outcomes).toEqual([
      {
        id: refund.id,
        status: 'PENDING_REFERENCE',
        failureCode: undefined,
        referenceAttempts: 3,
        nextReferenceCheckAt: new Date(LATER.getTime() + 4_000),
      },
    ]);
    // The PendingReference event went out when it first waited; waiting again is not news.
    expect(database.events).toEqual([]);
    expect(database.ledger).toEqual([]);
  });

  test('the reference arrived: the SAME rules apply it (REFUND credits), with its ledger entry and events', async () => {
    const { database, metrics, logs, worker } = harness('75.00');
    const refund = pendingRefund();
    database.stored.push(processedBet());
    database.due.push({ transaction: refund, referenceAttempts: 0 });

    const result = await worker.resolveBatch();

    expect(result).toEqual({ checked: 1, resolved: 1, stillWaiting: 0, expired: 0, failed: 0 });
    expect(refund.status).toBe('PROCESSED');
    expect(database.savedBalances).toEqual(['100.00']);
    expect(database.ledger.map((entry) => [entry.direction, entry.money.amount])).toEqual([['CREDIT', '25.00']]);
    expect(database.outcomes[0]).toMatchObject({ status: 'PROCESSED', referenceAttempts: 1, nextReferenceCheckAt: undefined });
    expect(database.events.map((event) => event.eventType)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    // No request caused this: the transaction id ties the events together.
    expect(database.events[0]?.payload).toMatchObject({ correlationId: refund.id });
    expect(metrics.value(MetricName.PendingReferencesResolved, { status: 'PROCESSED' })).toBe(1);
    expect(logs.events('pending_reference.resolved')[0]?.fields).toEqual(
      expect.objectContaining({
        transactionId: refund.id,
        walletId: refund.walletId,
        status: 'PROCESSED',
        attempt: 1,
        correlationId: refund.id, // the correlationId of the events this check wrote
      }),
    );
  });

  test('the 10th check still finds nothing: REJECTED with REFERENCE_NOT_FOUND and a WagerTransactionRejected event', async () => {
    const { database, metrics, logs, worker } = harness('100.00');
    const refund = pendingRefund();
    database.due.push({ transaction: refund, referenceAttempts: 9 });

    const result = await worker.resolveBatch();

    expect(result).toEqual({ checked: 1, resolved: 0, stillWaiting: 0, expired: 1, failed: 0 });
    expect(refund.status).toBe('REJECTED');
    expect(refund.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(database.outcomes[0]).toMatchObject({ referenceAttempts: 10, nextReferenceCheckAt: undefined });
    expect(database.events.map((event) => event.eventType)).toEqual(['WagerTransactionRejected']);
    expect(database.events[0]?.payload).toMatchObject({ data: { failureCode: 'REFERENCE_NOT_FOUND' } });
    expect(database.ledger).toEqual([]);
    expect(metrics.value(MetricName.PendingReferencesExpired)).toBe(1);
    expect(logs.events('pending_reference.expired')).toHaveLength(1);
  });

  test('past the last check, a reference that EXISTS but is still pending keeps it waiting, 60 s apart (the ceiling)', async () => {
    const { database, metrics, worker } = harness();
    const bet = submitted({ kind: WagerTransactionKind.Bet, money: brl('25.00'), externalTransactionId: 'b1' });
    bet.markPendingReference(AT); // the BET itself still waits for something
    database.stored.push(bet);
    const refund = pendingRefund();
    database.due.push({ transaction: refund, referenceAttempts: 12 });

    const result = await worker.resolveBatch();

    expect(result).toEqual({ checked: 1, resolved: 0, stillWaiting: 1, expired: 0, failed: 0 });
    expect(database.outcomes[0]).toEqual({
      id: refund.id,
      status: 'PENDING_REFERENCE',
      failureCode: undefined,
      referenceAttempts: 13,
      nextReferenceCheckAt: new Date(LATER.getTime() + 60_000),
    });
    expect(metrics.value(MetricName.PendingReferencesExpired)).toBe(0);
  });

  test('a row that fails is skipped for the rest of the batch: it does not block the rows behind it', async () => {
    const { database, logs, worker } = harness();
    const stuck = pendingRefundNumber(1, 'wallet-stuck');
    const fine = pendingRefundNumber(2);
    database.failingWallets.add('wallet-stuck');
    database.due.push({ transaction: stuck, referenceAttempts: 0 }, { transaction: fine, referenceAttempts: 0 });

    const result = await worker.resolveBatch();

    expect(result).toEqual({ checked: 1, resolved: 0, stillWaiting: 1, expired: 0, failed: 1 });
    expect(database.skipRequests).toEqual([[], [stuck.id], [stuck.id]]);
    expect(logs.events('pending_reference.check_failed')[0]?.fields).toEqual(
      expect.objectContaining({ transactionId: stuck.id, correlationId: stuck.id, error: 'Error: lock timeout' }),
    );
  });

  test('a row whose COMMIT fails is skipped too: the error comes after the callback, the row id is still known', async () => {
    const { database, logs, worker } = harness();
    const broken = pendingRefundNumber(1);
    const fine = pendingRefundNumber(2);
    database.commitFailsFor.add(broken.id);
    database.due.push({ transaction: broken, referenceAttempts: 0 }, { transaction: fine, referenceAttempts: 0 });

    const result = await worker.resolveBatch();

    expect(result).toEqual({ checked: 1, resolved: 0, stillWaiting: 1, expired: 0, failed: 1 });
    expect(database.skipRequests).toEqual([[], [broken.id], [broken.id]]);
    expect(logs.events('pending_reference.check_failed')[0]?.fields).toEqual(
      expect.objectContaining({ transactionId: broken.id, error: 'Error: deferred trigger refused the commit' }),
    );
  });

  test('one SQL transaction per pending row, at most batchSize rows, and it stops when asked', async () => {
    const { database, worker, transactionCount } = harness();
    for (let i = 0; i < 7; i++) {
      database.due.push({ transaction: pendingRefundNumber(i), referenceAttempts: 0 });
    }

    expect((await worker.resolveBatch()).checked).toBe(5);
    expect(transactionCount()).toBe(5);

    let checks = 0;
    const result = await worker.resolveBatch(() => checks++ >= 1);
    expect(result.checked).toBe(1);
  });
});

function pendingRefundNumber(index: number, walletId?: string): WagerTransaction {
  const refund = submitted({
    kind: WagerTransactionKind.Refund,
    money: brl('25.00'),
    externalTransactionId: `r-${index}`,
    referenceExternalTransactionId: `b-${index}`,
    ...(walletId === undefined ? {} : { walletId }),
  });
  refund.markPendingReference(AT);
  return refund;
}
