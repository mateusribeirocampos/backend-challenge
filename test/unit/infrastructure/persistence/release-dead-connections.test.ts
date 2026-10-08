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

  test('a BEGIN that fails on a dead connection gives the client back to the pool, then fails as before', async () => {
    const released: string[] = [];
    const dead = connectionFailingWith(new Error('Client has encountered a connection error and is not queryable'));
    const tracking = new PostgresDriver({ pool: {} as never });
    tracking.releaseConnection = async (connection) => {
      released.push(connection === dead ? 'dead' : 'other');
    };

    await expect(tracking.beginTransaction(dead, {})).rejects.toThrow('not queryable');
    expect(released).toEqual(['dead']);
  });

  test('a BEGIN that fails for another reason keeps the connection (kysely did not change here)', async () => {
    const released: string[] = [];
    const tracking = new PostgresDriver({ pool: {} as never });
    tracking.releaseConnection = async () => {
      released.push('released');
    };

    await expect(tracking.beginTransaction(connectionFailingWith(new TypeError('x is undefined')), {})).rejects.toThrow('x is undefined');
    expect(released).toEqual([]);
  });

  test('installing twice wraps once', () => {
    const rollback = PostgresDriver.prototype.rollbackTransaction;
    const begin = PostgresDriver.prototype.beginTransaction;
    releaseDeadConnectionsOnRollback();
    expect(PostgresDriver.prototype.rollbackTransaction).toBe(rollback);
    expect(PostgresDriver.prototype.beginTransaction).toBe(begin);
  });
});
