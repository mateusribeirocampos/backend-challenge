import { describe, expect, test } from 'bun:test';
import { type DatabaseConnection, PostgresDriver } from 'kysely';
import { releaseDeadConnectionsOnRollback } from '../../../../src/infrastructure/persistence/release-dead-connections.js';

function connectionFailingWith(error: Error): DatabaseConnection {
  return {
    executeQuery: async () => {
      throw error;
    },
    streamQuery: () => {
      throw error;
    },
  } as unknown as DatabaseConnection;
}

/** The ROLLBACK that kysely runs before releasing a connection to the pool. */
describe('releaseDeadConnectionsOnRollback', () => {
  releaseDeadConnectionsOnRollback();
  const driver = new PostgresDriver({ pool: {} as never });

  test('a ROLLBACK on a dead connection resolves, so kysely goes on to release it', async () => {
    const dead = connectionFailingWith(new Error('Client has encountered a connection error and is not queryable'));
    await expect(driver.rollbackTransaction(dead)).resolves.toBeUndefined();
  });

  test('any other ROLLBACK error still propagates', async () => {
    const broken = connectionFailingWith(new TypeError('x is undefined'));
    await expect(driver.rollbackTransaction(broken)).rejects.toThrow('x is undefined');
  });

  test('installing twice wraps once', () => {
    const wrapped = PostgresDriver.prototype.rollbackTransaction;
    releaseDeadConnectionsOnRollback();
    expect(PostgresDriver.prototype.rollbackTransaction).toBe(wrapped);
  });
});
