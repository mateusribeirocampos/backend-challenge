import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { MetricName } from '../../../src/application/ports/metrics.js';
import { openMigratedDatabase } from '../schema/support/schema-sql.js';
import { integrationConfig } from '../support/integration-config.js';
import { type RunningTestApp, startTestApp } from '../support/test-app.js';
import { openWallet, submit, wager } from '../wagering/support/wagering-api.js';

/** Spec 12: the counters and the latency histogram, read the way Prometheus reads them. */
describe('GET /metrics (spec 12)', () => {
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

  test('after a BET, its replay and a rejected BET: counters by status, the duplicate and the latency histogram', async () => {
    const wallet = await openWallet(app.baseUrl, '100.00');
    const bet = wager(wallet, { money: { amount: '30.00', currency: 'BRL' } });
    expect((await submit(app.baseUrl, bet)).status).toBe(201);
    expect((await submit(app.baseUrl, bet)).status).toBe(200); // replay
    expect((await submit(app.baseUrl, wager(wallet, { money: { amount: '500.00', currency: 'BRL' } }))).status).toBe(422);

    // Open like the health checks: no provider credentials.
    const response = await fetch(`${app.baseUrl}/metrics`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toStartWith('text/plain');
    expect(response.headers.get('content-type')).toContain('version=0.0.4');
    const lines = body.split('\n');
    expect(lines).toContain('wager_http_transactions_total{status="PROCESSED"} 1');
    expect(lines).toContain('wager_http_transactions_total{status="REJECTED"} 1');
    expect(lines).toContain('wager_duplicates_detected_total{layer="idempotency_key",source="http"} 1');
    expect(lines).toContain('# TYPE wager_processing_duration_seconds histogram');
    expect(lines).toContain('wager_processing_duration_seconds_bucket{source="http",le="+Inf"} 3');
    expect(lines).toContain('wager_processing_duration_seconds_count{source="http"} 3');
    // The money of these requests never appears: metrics carry statuses and durations only.
    expect(body).not.toContain('30.00');
    expect(body).not.toContain('500.00');
  });

  test('a BET that waited for the wallet lock shows up in the lock wait histogram, not only as a conflict', async () => {
    // Its own app, so the histogram holds only what this test did.
    const fresh = await startTestApp(integrationConfig());
    try {
      const wallet = await openWallet(fresh.baseUrl, '100.00');
      // Another transaction holds the wallet row for ~300 ms while the BET arrives.
      // Wrapped in an object: a promise returned bare would be awaited before the COMMIT that releases the row.
      const { answer } = await orm.em.fork().transactional(async (em) => {
        await em.execute('select id from wallets where id = ? for no key update', [wallet.id]);
        const pending = submit(fresh.baseUrl, wager(wallet, { money: { amount: '80.00', currency: 'BRL' } }));
        await Bun.sleep(300);
        return { answer: pending };
      });
      expect((await answer).status).toBe(201);

      const lines = (await (await fetch(`${fresh.baseUrl}/metrics`)).text()).split('\n');
      const sample = (prefix: string) => Number(lines.find((line) => line.startsWith(prefix))?.split(' ').at(-1));
      expect(lines).toContain('# TYPE wager_wallet_lock_wait_seconds histogram');
      // At least one wait longer than 0.25 s: the BET that queued behind the held row.
      expect(sample('wager_wallet_lock_wait_seconds_count') - sample('wager_wallet_lock_wait_seconds_bucket{le="0.25"}')).toBeGreaterThanOrEqual(1);
      // It waited and then got the lock: no lock was lost, so the conflict counter stays at 0.
      expect(fresh.metrics.value(MetricName.LockConflicts, { source: 'http' })).toBe(0);
    } finally {
      await fresh.close();
    }
  });

  test('every processed HTTP operation is logged with the spec 12 identifiers and without the amount', async () => {
    const wallet = await openWallet(app.baseUrl, '100.00');
    const bet = wager(wallet, { money: { amount: '41.17', currency: 'BRL' } });
    const response = await submit(app.baseUrl, bet, undefined, { 'x-correlation-id': 'corr-metrics-1' });

    const line = app.logs.events('wager_http.processed').find((entry) => entry.fields.correlationId === 'corr-metrics-1');
    expect(line?.fields).toEqual(
      expect.objectContaining({
        correlationId: 'corr-metrics-1',
        transactionId: response.body.transactionId,
        walletId: wallet.id,
        providerId: 'provider-a',
        status: 'PROCESSED',
      }),
    );
    expect(JSON.stringify(app.logs.lines)).not.toContain('41.17');
  });
});
