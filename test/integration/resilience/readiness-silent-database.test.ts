import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { openMigratedDatabase } from '../schema/support/schema-sql.js';
import { integrationConfig } from '../support/integration-config.js';
import { TcpProxy } from '../support/tcp-proxy.js';
import { type RunningTestApp, startTestApp } from '../support/test-app.js';
import { waitUntil } from '../support/wait-until.js';
import { expectBalanceMatchesLedger, type OpenedWallet, openWallet, submit, wager } from '../wagering/support/wagering-api.js';

setDefaultTimeout(30_000);

/**
 * A database that accepts connections and never answers. /health/ready must say 503
 * within its deadline AND leave nothing behind: a probe that kept a pool connection busy
 * with a query nobody will answer would take that connection from the money path.
 */
describe('readiness against a silent PostgreSQL (extra: infrastructure failures)', () => {
  let orm: MikroORM;
  let proxy: TcpProxy;
  let app: RunningTestApp;

  beforeAll(async () => {
    orm = await openMigratedDatabase();
    const config = integrationConfig();
    proxy = TcpProxy.start(config.database.host, config.database.port);
    // A small pool makes a leak visible: two stuck connections are the whole pool.
    app = await startTestApp({
      ...config,
      database: { ...config.database, host: '127.0.0.1', port: proxy.port, poolSize: 2, acquireTimeoutMs: 1_000 },
    });
  });

  afterAll(async () => {
    // Kill whatever is still waiting on the silent database first, so a failed assertion
    // above cannot leave the shutdown waiting for a connection that never comes back.
    proxy.unmute();
    proxy.cut();
    await app.close();
    proxy.stop();
    await orm.close(true);
  });

  test('two probes time out with 503, close what they opened, and the pool still serves a BET once the database answers', async () => {
    const wallets = [await openWallet(app.baseUrl, '100.00'), await openWallet(app.baseUrl, '100.00')];
    const before = proxy.openConnections;

    proxy.mute();
    const started = performance.now();
    const probes = await Promise.all([fetch(`${app.baseUrl}/health/ready`), fetch(`${app.baseUrl}/health/ready`)]);
    expect(probes.map((probe) => probe.status)).toEqual([503, 503]);
    expect(performance.now() - started).toBeLessThan(3_500);
    expect((await fetch(`${app.baseUrl}/health/live`)).status).toBe(200);
    // Whatever the probes opened is closed again: no socket waits for an answer that never comes.
    expect(proxy.openConnections).toBeLessThanOrEqual(before);

    // No pool connection was taken by the probes: the money path keeps all of them.
    const pool = (await app.get<MikroORM>(MikroORM).em.getConnection().getNativeClient()) as {
      totalCount: number;
      idleCount: number;
    };
    expect(pool.totalCount - pool.idleCount).toBe(0);

    proxy.unmute();
    const [first, second] = wallets as [OpenedWallet, OpenedWallet];
    // Both pool connections are usable at the same time: the first BET holds one (it waits
    // for a wallet lock the test keeps), and the second BET must finish on the other one
    // BEFORE the lock is released.
    const { held } = await orm.em.fork().transactional(async (em) => {
      await em.execute('select id from wallets where id = ? for no key update', [first.id]);
      const heldBet = submit(app.baseUrl, wager(first, { money: { amount: '10.00', currency: 'BRL' } }));
      await waitUntil('the first BET waits for the wallet lock, holding a pool connection', async () => {
        const [row] = await orm.em.fork().execute<{ waiting: number }[]>(
          `select count(*)::int as waiting from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock' and query like 'select id, player_id%'`,
        );
        return (row?.waiting ?? 0) === 1;
      });
      const other = await submit(app.baseUrl, wager(second, { money: { amount: '10.00', currency: 'BRL' } }));
      expect(other.status).toBe(201);
      // Wrapped: a promise returned bare would be awaited before this COMMIT releases the lock.
      return { held: heldBet };
    });
    expect((await held).status).toBe(201);
    for (const wallet of wallets) {
      await expectBalanceMatchesLedger(orm, app.baseUrl, wallet.id, '90.00');
    }
    expect((await fetch(`${app.baseUrl}/health/ready`)).status).toBe(200);
  });
});
