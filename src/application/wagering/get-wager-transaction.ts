import { WagerTransactionNotFoundError } from '../errors.js';
import type { TransactionRunner } from '../ports/transaction-runner.js';
import { toWagerTransactionView, type WagerTransactionView } from './wager-transaction-views.js';

/** GET /wagering/transactions/:id and GET /providers/:providerId/wagering/transactions/:externalId. */
export class GetWagerTransaction {
  constructor(private readonly runner: TransactionRunner) {}

  async byId(transactionId: string): Promise<WagerTransactionView> {
    const transaction = await this.runner.run((repositories) => repositories.transactions.findById(transactionId));
    if (transaction === undefined) {
      throw new WagerTransactionNotFoundError(transactionId);
    }
    return toWagerTransactionView(transaction);
  }

  async byExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransactionView> {
    const transaction = await this.runner.run((repositories) =>
      repositories.transactions.findByProviderAndExternalId(providerId, externalTransactionId),
    );
    if (transaction === undefined) {
      throw new WagerTransactionNotFoundError(`${providerId}/${externalTransactionId}`);
    }
    return toWagerTransactionView(transaction);
  }
}
