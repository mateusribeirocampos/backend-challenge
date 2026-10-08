import { FailureCode } from '../../domain/wager/failure-code.js';
import { summarizeError } from '../error-summary.js';
import {
  isLastReferenceCheck,
  nextReferenceCheckAt,
  type ReferenceWaitPolicy,
} from '../../domain/wager/reference-wait-policy.js';
import { WagerTransactionStatus } from '../../domain/wager/wager-transaction-status.js';
import type { WagerTransaction } from '../../domain/wager/wager-transaction.js';
import type { Clock } from '../ports/clock.js';
import type { IdGenerator } from '../ports/id-generator.js';
import { type Metrics, MetricName } from '../ports/metrics.js';
import type { Repositories } from '../ports/repositories.js';
import type { StructuredLogger } from '../ports/structured-logger.js';
import type { TransactionRunner } from '../ports/transaction-runner.js';
import { ApplyAndRecord } from './apply-and-record.js';

export interface PendingReferenceSettings {
  /** Pending transactions checked per run, each in its own SQL transaction. */
  readonly batchSize: number;
  readonly wait: ReferenceWaitPolicy;
}

export interface PendingReferenceBatchResult {
  /** Checks that committed. */
  readonly checked: number;
  /** Found the reference and were decided (PROCESSED, or REJECTED by a rule). */
  readonly resolved: number;
  readonly stillWaiting: number;
  /** Gave up: REJECTED with REFERENCE_NOT_FOUND. */
  readonly expired: number;
  /** Checks that threw (rolled back, nothing changed); the row is tried again in the next batch. */
  readonly failed: number;
}

type CheckResult = 'resolved' | 'stillWaiting' | 'expired';

/** A check that threw after it picked a row: the row is known, the batch moves on. */
class CheckFailedError extends Error {
  constructor(
    readonly transactionId: string,
    readonly walletId: string,
    cause: unknown,
  ) {
    super(`Check of pending transaction ${transactionId} failed`, { cause });
  }
}

/**
 * The PENDING_REFERENCE worker (spec 7.1). A REFUND or ROLLBACK that
 * arrived before its BET was stored as PENDING_REFERENCE with a next check time. Each
 * check, in its own SQL transaction:
 *
 *   1. pick the most overdue waiting transaction, FOR NO KEY UPDATE SKIP LOCKED: two
 *      workers never check the same row at the same time, and neither waits for the other;
 *   2. run it through ApplyAndRecord, the SAME path a new submission takes (wallet
 *      lock, reference lookup, domain rules, writes, events);
 *   3. the reference is there: PROCESSED (or REJECTED by a rule, e.g. amount mismatch);
 *      still missing: count the check and schedule the next one with backoff;
 *      still missing on the last allowed check: REJECTED with REFERENCE_NOT_FOUND.
 */
export class ResolvePendingReferences {
  private readonly applyAndRecord: ApplyAndRecord;

  constructor(
    private readonly runner: TransactionRunner,
    private readonly clock: Clock,
    ids: IdGenerator,
    private readonly metrics: Metrics,
    private readonly logger: StructuredLogger,
    private readonly settings: PendingReferenceSettings,
  ) {
    this.applyAndRecord = new ApplyAndRecord(clock, ids);
  }

  /**
   * Checks up to batchSize due transactions. shouldStop: checked before each one.
   * Each row is checked at most once per batch:
   *   - a row whose check fails (a lock timeout on a busy wallet, a bug) is skipped for
   *     the rest of the batch; otherwise, being the most overdue, it would be picked
   *     again and again and block every row behind it;
   *   - a row checked and still waiting is skipped too: with a short delay its next check
   *     can come due before the batch ends, and the batch would spend itself on it.
   */
  async resolveBatch(shouldStop: () => boolean = () => false): Promise<PendingReferenceBatchResult> {
    const result = { checked: 0, resolved: 0, stillWaiting: 0, expired: 0, failed: 0 };
    const visitedIds: string[] = [];
    while (result.checked + result.failed < this.settings.batchSize && !shouldStop()) {
      try {
        const checked = await this.checkNext(visitedIds);
        if (checked === undefined) {
          break; // nothing (else) is due
        }
        visitedIds.push(checked.transactionId);
        result.checked += 1;
        result[checked.outcome] += 1;
      } catch (error) {
        if (!(error instanceof CheckFailedError)) {
          throw error;
        }
        visitedIds.push(error.transactionId);
        result.failed += 1;
        this.logger.error('pending_reference.check_failed', {
          transactionId: error.transactionId,
          // The correlationId the check would have written in its events (see check).
          correlationId: error.transactionId,
          walletId: error.walletId,
          ...summarizeError(error.cause),
        });
      }
    }
    return result;
  }

  /**
   * One due transaction, in one SQL transaction. undefined when none is due.
   * The picked row is remembered OUTSIDE the transaction: an error can come from the
   * callback or from the COMMIT itself (a deferred constraint trigger), and either way the
   * batch must know which row to skip.
   */
  private async checkNext(
    skipIds: readonly string[],
  ): Promise<{ transactionId: string; outcome: CheckResult } | undefined> {
    let picked: WagerTransaction | undefined;
    let checked: { transaction: WagerTransaction; attempt: number } | undefined;
    try {
      checked = await this.runner.run((repositories) =>
        this.check(repositories, skipIds, (transaction) => {
          picked = transaction;
        }),
      );
    } catch (error) {
      if (picked === undefined) {
        throw error; // nothing was picked (database down): the loop backs off
      }
      // Rolled back entirely; the id lets the batch skip the row.
      throw new CheckFailedError(picked.id, picked.walletId, error);
    }
    // After the commit: metrics and logs describe what is really stored.
    if (checked === undefined) {
      return undefined;
    }
    return { transactionId: checked.transaction.id, outcome: this.report(checked.transaction, checked.attempt) };
  }

  private async check(
    repositories: Repositories,
    skipIds: readonly string[],
    onPicked: (transaction: WagerTransaction) => void,
  ): Promise<{ transaction: WagerTransaction; attempt: number } | undefined> {
    const due = await repositories.transactions.lockNextDuePendingReference(this.clock.now(), skipIds);
    if (due === undefined) {
      return undefined;
    }
    const { transaction } = due;
    onPicked(transaction);
    const attempt = due.referenceAttempts + 1;
    await this.applyAndRecord.run(repositories, transaction, {
      // No request or message caused this run: the transaction id ties its events together.
      correlationId: transaction.id,
      lastReferenceCheck: isLastReferenceCheck(attempt, this.settings.wait),
      referenceAttempts: attempt,
      nextReferenceCheckAt: (at) => nextReferenceCheckAt(attempt, at, this.settings.wait),
    });
    return { transaction, attempt };
  }

  private report(transaction: WagerTransaction, attempt: number): CheckResult {
    const fields = {
      transactionId: transaction.id,
      correlationId: transaction.id,
      walletId: transaction.walletId,
      providerId: transaction.providerId,
      status: transaction.status,
      failureCode: transaction.failureCode,
      attempt,
    };
    if (transaction.status === WagerTransactionStatus.PendingReference) {
      return 'stillWaiting';
    }
    if (transaction.failureCode === FailureCode.ReferenceNotFound) {
      this.metrics.increment(MetricName.PendingReferencesExpired);
      this.logger.warn('pending_reference.expired', fields);
      return 'expired';
    }
    this.metrics.increment(MetricName.PendingReferencesResolved, { status: transaction.status });
    this.logger.info('pending_reference.resolved', fields);
    return 'resolved';
  }
}
