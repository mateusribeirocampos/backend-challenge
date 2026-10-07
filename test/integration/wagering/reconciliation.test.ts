import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { MetricName } from '../../../src/application/ports/metrics.js';
import { DedicatedConnection } from '../schema/support/dedicated-connection.js';
import { openMigratedDatabase } from '../schema/support/schema-sql.js';
import { integrationConfig } from '../support/integration-config.js';
import { type RunningTestApp, startTestApp } from '../support/test-app.js';
import {
  expectBalanceMatchesLedger,
  ledgerEntries,
  openWallet,
  request,
  submit,
  wager,
  walletState,
} from './support/wagering-api.js';

/**
 * Spec 9: POST /wallets/:walletId/reconciliation compares the stored balance with the
 * balance rebuilt from the ledger. A divergence is logged, counted and flagged, and
 * NEVER corrected.
 */
describe('POST /wallets/:walletId/reconciliation', () => {
  let orm: MikroORM;
  let app: RunningTestApp;

  beforeAll(async () => {
    orm = await openMigratedDatabase();
    app = await startTestApp(integrationConfig());
  });

  afterAll(async () => {
    await app.close();
    await orm.close(true);
  });

  function reconcile(walletId: string) {
    return request(app.baseUrl, 'POST', `/wallets/${walletId}/reconciliation`);
  }

  test('a consistent wallet: stored = calculated, difference 0.00, every entry checked', async () => {
    const wallet = await openWallet(app.baseUrl, '100.00');
    expect((await submit(app.baseUrl, wager(wallet, { money: { amount: '25.00', currency: 'BRL' } }))).status).toBe(201);
    const win = wager(wallet, { kind: 'WIN', money: { amount: '10.00', currency: 'BRL' } });
    expect((await submit(app.baseUrl, win)).status).toBe(201);

    const response = await reconcile(wallet.id);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: '85.00', currency: 'BRL' },
      calculatedBalance: { amount: '85.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 3,
    });
    expect(app.logs.events('wallet.reconciliation_divergence').filter((line) => line.fields.walletId === wallet.id)).toEqual([]);
    await expectBalanceMatchesLedger(orm, app.baseUrl, wallet.id, '85.00');
  });

  test('a corrupted wallet: flagged with the right difference, logged, counted, and left exactly as it was', async () => {
    const wallet = await openWallet(app.baseUrl, '100.00');
    expect((await submit(app.baseUrl, wager(wallet, { money: { amount: '25.00', currency: 'BRL' } }))).status).toBe(201);
    await corruptBalance(wallet.id, '80.00'); // the ledger still says 75.00
    const divergencesBefore = app.metrics.value(MetricName.ReconciliationDivergences);

    const response = await reconcile(wallet.id);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: '80.00', currency: 'BRL' },
      calculatedBalance: { amount: '75.00', currency: 'BRL' },
      difference: { amount: '5.00', currency: 'BRL' },
      consistent: false,
      checkedEntries: 2,
    });
    const logged = app.logs.events('wallet.reconciliation_divergence').filter((line) => line.fields.walletId === wallet.id);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toEqual({
      level: 'error',
      event: 'wallet.reconciliation_divergence',
      fields: expect.objectContaining({ walletId: wallet.id, currency: 'BRL', difference: '5.00', checkedEntries: 2 }),
    });
    expect(app.metrics.value(MetricName.ReconciliationDivergences)).toBe(divergencesBefore + 1);

    // Not corrected: same balance and version, same ledger; asking again gives the same answer.
    expect(await walletState(orm, wallet.id)).toEqual({ balance: '80.00', version: 2 });
    expect((await ledgerEntries(orm, wallet.id)).map((entry) => [entry.direction, entry.amount])).toEqual([
      ['CREDIT', '100.00'],
      ['DEBIT', '25.00'],
    ]);
    expect((await reconcile(wallet.id)).body).toEqual(response.body);
    expect(app.metrics.value(MetricName.ReconciliationDivergences)).toBe(divergencesBefore + 2);
  });

  test('an unknown wallet is a 404; a walletId that is not a UUID is a 400', async () => {
    const unknown = await reconcile(randomUUID());
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual(expect.objectContaining({ errorCode: 'WALLET_NOT_FOUND' }));

    expect((await reconcile('not-a-uuid')).status).toBe(400);
  });
});

/**
 * Writes a balance the ledger does not explain. The schema refuses that at commit
 * (constraint trigger wallets_balance_matches_ledger), so this session turns user
 * triggers off for this one transaction only (SET LOCAL session_replication_role =
 * replica, which needs a superuser: the local test database user is one). CHECK
 * constraints still apply.
 */
async function corruptBalance(walletId: string, balance: string): Promise<void> {
  const session = await DedicatedConnection.open();
  try {
    await session.run('begin');
    await session.run('set local session_replication_role = replica');
    await session.run(`update wallets set balance_amount = '${balance}' where id = '${walletId}'`);
    await session.run('commit');
  } finally {
    await session.close();
  }
}
