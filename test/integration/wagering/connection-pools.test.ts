import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import type { AppConfig, DatabaseConfig } from '../../../src/infrastructure/config/app-config.js';
import { openMigratedDatabase } from '../schema/support/schema-sql.js';
import { integrationConfig } from '../support/integration-config.js';
import { startTestApp } from '../support/test-app.js';
import { waitUntil } from '../support/wait-until.js';
import { openWallet, submit, wager } from './support/wagering-api.js';

/**
 * Finding 2 of the load test (docs/teste-de-carga.md): the main pool must fail fast
 * when it has no free connection.
 */
describe('connection pools under overload', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await openMigratedDatabase();
  });

  afterAll(async () => {
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
});

function withDatabase(config: AppConfig, database: Partial<DatabaseConfig>): AppConfig {
  return { ...config, database: { ...config.database, ...database } };
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
