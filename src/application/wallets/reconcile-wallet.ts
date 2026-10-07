import { type ReconciliationProps, WalletReconciliation } from '../../domain/wallet/wallet-reconciliation.js';
import { WalletNotFoundError } from '../errors.js';
import { type Metrics, MetricName } from '../ports/metrics.js';
import type { StructuredLogger } from '../ports/structured-logger.js';
import type { TransactionRunner } from '../ports/transaction-runner.js';

export interface ReconcileWalletCommand {
  readonly walletId: string;
  readonly correlationId: string;
}

/**
 * POST /wallets/:walletId/reconciliation (spec 9). Reads the stored balance and the
 * ledger totals in one statement, compares them in the domain, and reports. A
 * divergence is logged (error), counted in a metric and flagged in the answer; nothing
 * is written. The schema already refuses, at commit, a balance that differs from the
 * last ledger entry, so a divergence here means data changed outside the application.
 */
export class ReconcileWallet {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly metrics: Metrics,
    private readonly logger: StructuredLogger,
  ) {}

  async execute(command: ReconcileWalletCommand): Promise<ReconciliationProps> {
    const totals = await this.runner.run((repositories) => repositories.ledger.reconciliationTotals(command.walletId));
    if (totals === undefined) {
      throw new WalletNotFoundError(command.walletId);
    }
    const reconciliation = WalletReconciliation.of({
      walletId: command.walletId,
      storedBalance: totals.storedBalance,
      totalCredits: totals.totalCredits,
      totalDebits: totals.totalDebits,
      checkedEntries: totals.entries,
    });
    if (!reconciliation.isConsistent()) {
      this.metrics.increment(MetricName.ReconciliationDivergences);
      // The difference and the count only: enough to start an investigation, no ledger dump.
      this.logger.error('wallet.reconciliation_divergence', {
        walletId: command.walletId,
        correlationId: command.correlationId,
        currency: reconciliation.difference.currency,
        difference: reconciliation.difference.amount,
        checkedEntries: reconciliation.checkedEntries,
      });
    }
    return reconciliation.toJSON();
  }
}
