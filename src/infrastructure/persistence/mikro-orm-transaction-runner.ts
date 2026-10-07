import { IsolationLevel } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { LockContentionError, TransientInfrastructureError } from '../../application/errors.js';
import type { Repositories } from '../../application/ports/repositories.js';
import type { TransactionRunner } from '../../application/ports/transaction-runner.js';
import { isLockContentionError, isTransientDatabaseError } from './database-error-classifier.js';
import { MikroOrmInboxRepository } from './repositories/mikro-orm-inbox.repository.js';
import { MikroOrmLedgerRepository } from './repositories/mikro-orm-ledger.repository.js';
import { MikroOrmOutboxRepository } from './repositories/mikro-orm-outbox.repository.js';
import { MikroOrmWagerTransactionRepository } from './repositories/mikro-orm-wager-transaction.repository.js';
import { MikroOrmWalletRepository } from './repositories/mikro-orm-wallet.repository.js';

/**
 * How long a statement may wait for a row lock (the wallet row, or a unique index
 * entry another request is inserting). Past it PostgreSQL raises 55P03 and the request
 * fails as transient (HTTP 503 + Retry-After) instead of piling up connections.
 */
export const LOCK_TIMEOUT = '2s';

/**
 * One SQL transaction per call, on a fresh fork of the EntityManager (its own identity
 * map, never shared between requests). Equivalent of @Transactional in Spring, but
 * explicit: the boundary is this call, not a proxy around a method.
 */
export class MikroOrmTransactionRunner implements TransactionRunner {
  constructor(private readonly orm: MikroORM) {}

  async run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(
        async (em) => {
          // SET LOCAL: only for this transaction; the pooled connection goes back clean.
          await em.execute(`set local lock_timeout = '${LOCK_TIMEOUT}'`);
          return work(repositoriesFor(em));
        },
        // PostgreSQL's default, written down because the design relies on it: after
        // waiting for a lock, the next statement sees what the other transaction committed.
        { isolationLevel: IsolationLevel.READ_COMMITTED },
      );
    } catch (error) {
      if (isLockContentionError(error)) {
        // Still a TransientInfrastructureError (HTTP 503), but the SQS consumer retries it in process first.
        throw new LockContentionError('Another transaction held the row, retry with the same key', { cause: error });
      }
      if (isTransientDatabaseError(error)) {
        throw new TransientInfrastructureError('Database temporarily unavailable, retry with the same key', {
          cause: error,
        });
      }
      throw error;
    }
  }
}

function repositoriesFor(em: EntityManager): Repositories {
  return {
    wallets: new MikroOrmWalletRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
    inbox: new MikroOrmInboxRepository(em),
  };
}
