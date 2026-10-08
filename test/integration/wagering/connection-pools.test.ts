import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { PublishOutbox } from '../../../src/application/outbox/publish-outbox.js';
import type { AppConfig, DatabaseConfig } from '../../../src/infrastructure/config/app-config.js';
import { createSqsClient } from '../../../src/infrastructure/messaging/sqs-client.provider.js';
import {
  allPublished,
  createEventsQueue,
  deleteEventsQueue,
  markEveryPendingEventPublished,
  outboxRowsOf,
  publisherConfig,
} from '../messaging/support/outbox-events.js';
import { DedicatedConnection } from '../schema/support/dedicated-connection.js';
import { openMigratedDatabase, query } from '../schema/support/schema-sql.js';
import { integrationConfig } from '../support/integration-config.js';
import { startTestApp } from '../support/test-app.js';
import { waitUntil } from '../support/wait-until.js';
import { openWallet, submit, wager } from './support/wagering-api.js';

/**
 * Findings 1 and 2 of the load test (docs/teste-de-carga.md): the main pool must fail
 * fast when it has no free connection, and the background loops must not depend on it.
 */
describe('connection pools under overload', () => {
  let orm: MikroORM;
  let sqs: SQSClient;

  beforeAll(async () => {
    orm = await openMigratedDatabase();
    sqs = createSqsClient(integrationConfig().sqs);
  });

  afterAll(async () => {
    sqs.destroy();
    await orm.close(true);
  });

  test('a request that finds the pool busy fails within the acquisition timeout: 503 + Retry-After, not an endless wait', async () => {
    const app = await startTestApp(withDatabase(integrationConfig(), { poolSize: 1, acquireTimeoutMs: 500 }));
    try {
      const wallet = await openWallet(app.baseUrl, '100.00');
      const bet = wager(wallet);
      // The only connection of the main pool, inside a transaction that does not end.
      const busy = await holdConnections(app.get<MikroORM>(MikroORM), 1, 'select 1');

      const started = performance.now();
      const response = await submit(app.baseUrl, bet).finally(() => busy.release());
      const elapsedMs = performance.now() - started;

      expect(response.status).toBe(503);
      expect(response.body.errorCode).toBe('TRANSIENT_FAILURE');
      expect(response.headers.get('retry-after')).toBe('1');
      expect(elapsedMs).toBeGreaterThanOrEqual(450);
      expect(elapsedMs).toBeLessThan(1_500);
      // Once a connection is free, resending with the same key is processed normally.
      expect((await submit(app.baseUrl, bet)).status).toBe(201);
    } finally {
      await app.close();
    }
  }, 10_000);

  test('with every main pool connection waiting on a locked wallet, the publisher still publishes another wallet', async () => {
    const queue = await createEventsQueue(sqs);
    // The publisher loop is off: the test runs one batch itself, while the main pool is stuck.
    const config = publisherConfig(queue.name, { enabled: false });
    const app = await startTestApp(withDatabase(config, { poolSize: 2 }));
    const blocker = await DedicatedConnection.open();
    let stuck: HeldConnections | undefined;
    try {
      const hot = await openWallet(app.baseUrl, '100.00');
      const other = await openWallet(app.baseUrl, '100.00');
      await markEveryPendingEventPublished(orm);
      expect((await submit(app.baseUrl, wager(other))).status).toBe(201);
      const pendingOfOther = (await outboxRowsOf(orm, [other.id])).filter((row) => !row.published).length;
      expect(pendingOfOther).toBeGreaterThan(0);

      // Like the hot wallet of the load test: another transaction holds the wallet row, and
      // both main pool connections wait for it (no lock_timeout here, so they wait for good).
      await blocker.run('begin');
      await blocker.run(lockWallet(hot.id));
      stuck = await holdConnections(app.get<MikroORM>(MikroORM), 2, lockWallet(hot.id), waitingForWalletLock(hot.id, 2));

      const result = await app.get(PublishOutbox).publishBatch();

      expect(result.published).toBe(pendingOfOther);
      expect(await allPublished(orm, [other.id])).toBe(true);
    } finally {
      await blocker.run('rollback');
      await blocker.close();
      await stuck?.release();
      await app.close();
      await deleteEventsQueue(sqs, queue);
    }
  }, 15_000);

  function waitingForWalletLock(walletId: string, count: number): () => Promise<boolean> {
    return async () => {
      const [row] = await query<{ waiting: number }>(
        orm,
        `select count(*)::int as waiting from pg_stat_activity
          where wait_event_type = 'Lock' and query like '%${walletId}%for no key update%'`,
      );
      return row?.waiting === count;
    };
  }
});

function withDatabase(config: AppConfig, database: Partial<DatabaseConfig>): AppConfig {
  return { ...config, database: { ...config.database, ...database } };
}

function lockWallet(walletId: string): string {
  return `select id from wallets where id = '${walletId}' for no key update`;
}

interface HeldConnections {
  /** Ends the held transactions (they commit) and gives the connections back to the pool. */
  release(): Promise<void>;
}

/**
 * Takes `count` connections of this ORM's pool, each one inside a transaction that runs
 * `statement` and then stays open until release(). Returns once `isHolding` is true
 * (by default: once every statement has returned).
 */
async function holdConnections(
  orm: MikroORM,
  count: number,
  statement: string,
  isHolding?: () => Promise<boolean>,
): Promise<HeldConnections> {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let ran = 0;
  const transactions = Array.from({ length: count }, () =>
    orm.em.fork().transactional(async (em) => {
      await em.execute(statement);
      ran += 1;
      await gate;
    }),
  );
  await waitUntil(`${count} held connections`, isHolding ?? (() => ran === count), 5_000);
  return {
    release: async () => {
      open();
      await Promise.all(transactions);
    },
  };
}
