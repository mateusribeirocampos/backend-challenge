import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { openMigratedDatabase } from '../schema/support/schema-sql.js';
import { integrationConfig } from '../support/integration-config.js';
import { TcpProxy } from '../support/tcp-proxy.js';
import { type RunningTestApp, startTestApp } from '../support/test-app.js';
import { waitUntil } from '../support/wait-until.js';
import {
  countRows,
  expectBalanceMatchesLedger,
  type HttpResult,
  openWallet,
  submit,
  type WagerBody,
  wager,
} from '../wagering/support/wagering-api.js';

setDefaultTimeout(30_000);

/** Resends the same request (same key) until the answer is not a 503, as a provider would. */
async function resendUntilAnswered(baseUrl: string, body: WagerBody): Promise<HttpResult> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await submit(baseUrl, body);
    if (response.status !== 503) return response;
    await Bun.sleep(100);
  }
  throw new Error(`still 503 after 40 attempts: ${body.externalTransactionId}`);
}

/**
 * Spec 3: "PostgreSQL e SQS podem ficar temporariamente indisponíveis". Here PostgreSQL
 * goes away while requests are inside their transactions and comes back, and the SAME
 * process has to recover: no restart, no manual step. The test reaches the database
 * through a TCP proxy it controls, and checks the outcome on a direct connection.
 */
describe('PostgreSQL goes down in the middle of the processing (extra: infrastructure failures)', () => {
  let orm: MikroORM;
  let proxy: TcpProxy;
  let app: RunningTestApp;

  beforeAll(async () => {
    orm = await openMigratedDatabase();
    const config = integrationConfig();
    proxy = TcpProxy.start(config.database.host, config.database.port);
    app = await startTestApp({ ...config, database: { ...config.database, host: '127.0.0.1', port: proxy.port } });
  });

  afterAll(async () => {
    await app.close();
    proxy.stop();
    await orm.close(true);
  });

  test('connections die mid-transaction: 503 (never 500), readiness down, and after it comes back every resend has exactly one effect', async () => {
    const wallets = [await openWallet(app.baseUrl, '100.00'), await openWallet(app.baseUrl, '100.00')];
    // 10 BETs of 10.00, 5 per wallet: fits the 10 connections of the main pool.
    const bets = Array.from({ length: 10 }, (_, index) =>
      wager(wallets[index % 2] as (typeof wallets)[number], { money: { amount: '10.00', currency: 'BRL' } }),
    );

    // A direct connection holds both wallet rows, so every BET stops inside its transaction
    // (after its insert, waiting for the lock) when the database goes away.
    const firstAnswers = await orm.em.fork().transactional(async (em) => {
      await em.execute('select id from wallets where id in (?, ?) for no key update', wallets.map((wallet) => wallet.id));
      const answers = Promise.all(bets.map((body) => submit(app.baseUrl, body)));
      await waitUntil('the 10 BETs wait for the wallet lock', async () => {
        // Another connection: inside a transaction pg_stat_activity is a snapshot taken on first read.
        const [row] = await orm.em.fork().execute<{ waiting: number }[]>(
          `select count(*)::int as waiting from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock' and query like 'select id, player_id%'`,
        );
        return (row?.waiting ?? 0) === bets.length;
      });
      proxy.down();
      // Wrapped: a promise returned bare would be awaited before this COMMIT.
      return { answers };
    });

    // The database is "down" for the application: transient for everyone, the process stays alive.
    const duringOutage = await firstAnswers.answers;
    expect(duringOutage.map((answer) => answer.status)).toEqual(bets.map(() => 503));
    expect(duringOutage.every((answer) => answer.headers.get('retry-after') !== null)).toBe(true);
    expect((await fetch(`${app.baseUrl}/health/ready`)).status).toBe(503);
    expect((await fetch(`${app.baseUrl}/health/live`)).status).toBe(200);
    expect((await submit(app.baseUrl, wager(wallets[0] as (typeof wallets)[number]))).status).toBe(503);
    // Nothing of the interrupted transactions survived: PostgreSQL rolled them back.
    const ids = bets.map((body) => `'${body.externalTransactionId}'`).join(', ');
    expect(await countRows(orm, 'wager_transactions', `external_transaction_id in (${ids})`)).toBe(0);

    proxy.restore();

    // The provider resends each operation with the same key; the pool opens new connections.
    const afterRecovery = await Promise.all(bets.map((body) => resendUntilAnswered(app.baseUrl, body)));
    expect(afterRecovery.map((answer) => answer.status)).toEqual(bets.map(() => 201));
    // A second resend is a replay: one effect per operation, whatever the client does.
    expect((await submit(app.baseUrl, bets[0] as WagerBody)).status).toBe(200);
    for (const wallet of wallets) {
      expect(await countRows(orm, 'wager_transactions', `wallet_id = '${wallet.id}' and kind = 'BET' and status = 'PROCESSED'`)).toBe(5);
      await expectBalanceMatchesLedger(orm, app.baseUrl, wallet.id, '50.00');
    }
    expect((await fetch(`${app.baseUrl}/health/ready`)).status).toBe(200);
  });
});
