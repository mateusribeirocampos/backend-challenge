import type { Repositories } from './repositories.js';

/**
 * Runs work inside ONE SQL transaction: commit when it resolves, rollback when it
 * throws. Same role as Spring's TransactionTemplate.execute(...). Database errors
 * that can succeed on a retry (lock timeout, deadlock, connection lost) come out as
 * TransientInfrastructureError.
 */
export interface TransactionRunner {
  run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T>;
}

export const TRANSACTION_RUNNER = Symbol('TRANSACTION_RUNNER');
