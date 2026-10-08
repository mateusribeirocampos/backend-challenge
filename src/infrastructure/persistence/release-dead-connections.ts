import { PostgresDriver } from 'kysely';
import { isTransientDatabaseError } from './database-error-classifier.js';

const INSTALLED = Symbol.for('wagering.releaseDeadConnectionsOnRollback');

type RollbackTransaction = PostgresDriver['rollbackTransaction'];
type BeginTransaction = PostgresDriver['beginTransaction'];

/**
 * Works around a connection leak in kysely 0.29 (the SQL layer of MikroORM 7).
 * ControlledTransaction.rollback() runs ROLLBACK and only then releases the connection:
 *
 *   await driver.rollbackTransaction(connection)   // throws if the connection is dead
 *   connection.release()                           // never reached
 *
 * When PostgreSQL goes away in the middle of a transaction, ROLLBACK fails on the dead
 * socket and the pool slot is never given back. After as many drops as the pool size,
 * every request waits for a connection that never comes (503 until a restart): a
 * database failover would leave each instance unable to recover on its own.
 *
 * On a dead connection there is nothing to roll back (the server aborts the
 * transaction when the session ends), so that error is swallowed and the release runs.
 * pg's pool then discards the client, because it is no longer queryable, and opens a
 * new one on demand. Any other ROLLBACK error still propagates. The error that made the
 * transaction fail is never hidden: MikroORM rethrows it after the rollback.
 *
 * The same leak exists one step earlier: ControlledTransactionBuilder.execute() takes a
 * connection and runs BEGIN; if BEGIN fails on a connection that just died, nobody ever
 * releases it (the transaction object that would is never created). A BEGIN that fails
 * that way hands the client back to the pool here, and the error still propagates.
 *
 * Proved by test/integration/resilience/database-outage.test.ts.
 */
export function releaseDeadConnectionsOnRollback(): void {
  const prototype = PostgresDriver.prototype as PostgresDriver & { [INSTALLED]?: true };
  if (prototype[INSTALLED]) return;
  const rollback: RollbackTransaction = prototype.rollbackTransaction;
  prototype.rollbackTransaction = async function rollbackOrReleaseDeadConnection(this: PostgresDriver, connection) {
    try {
      await rollback.call(this, connection);
    } catch (error) {
      if (!isTransientDatabaseError(error)) throw error;
    }
  };
  const begin: BeginTransaction = prototype.beginTransaction;
  prototype.beginTransaction = async function beginOrReleaseDeadConnection(this: PostgresDriver, connection, settings) {
    try {
      await begin.call(this, connection, settings);
    } catch (error) {
      if (isTransientDatabaseError(error)) {
        // This driver only ever receives its own PostgresConnection here.
        await this.releaseConnection(connection as Parameters<PostgresDriver['releaseConnection']>[0]);
      }
      throw error;
    }
  };
  prototype[INSTALLED] = true;
}
