import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { MetricName } from '../../../src/application/ports/metrics.js';
import { ResolvePendingReferences } from '../../../src/application/wagering/resolve-pending-references.js';
import { someoneWaitsFor } from '../messaging/support/lock-observer.js';
import { DedicatedConnection } from '../schema/support/dedicated-connection.js';
import { openMigratedDatabase, query } from '../schema/support/schema-sql.js';
import { integrationConfig } from '../support/integration-config.js';
import { type RunningTestApp, startTestApp } from '../support/test-app.js';
import { waitUntil } from '../support/wait-until.js';
import {
  betAndReversal,
  eventTypesOf,
  parkOtherPendingReferences,
  referenceWaitOf,
  scheduleCheck,
  workerConfig,
} from './support/pending-references.js';
import { expectBalanceMatchesLedger, ledgerEntries, openWallet, request, submit, wager } from './support/wagering-api.js';

setDefaultTimeout(20_000);

/**
 * Spec 7.1 and spec 13 item 7, over HTTP: a REFUND that arrives before its BET waits in
 * PENDING_REFERENCE, and the worker (ADR-008) decides it later through the same rules.
 */
describe('PENDING_REFERENCE worker', () => {
  let orm: MikroORM;
  let apps: RunningTestApp[] = [];

  beforeAll(async () => {
    orm = await openMigratedDatabase();
  });

  afterAll(async () => {
    await orm.close(true);
  });

  beforeEach(async () => {
    await parkOtherPendingReferences(orm);
  });

  afterEach(async () => {
    await Promise.all(apps.map((app) => app.close()));
    apps = [];
  });

  async function start(config = workerConfig()): Promise<RunningTestApp> {
    const app = await startTestApp(config);
    apps.push(app);
    return app;
  }

  test('REFUND before its BET (item 7): 202, the BET arrives, the worker processes the REFUND, and a replay returns that result', async () => {
    const app = await start();
    const wallet = await openWallet(app.baseUrl, '100.00');
    const { bet, reversal: refund } = betAndReversal(wallet, 'REFUND');

    const waiting = await submit(app.baseUrl, refund);
    expect(waiting.status).toBe(202);
    expect(waiting.body).toEqual({ transactionId: expect.any(String), status: 'PENDING_REFERENCE', idempotentReplay: false });

    const placed = await submit(app.baseUrl, bet);
    expect(placed.status).toBe(201);
    expect(placed.body.balance).toEqual({ amount: '75.00', currency: 'BRL' });

    await waitUntil('the worker processed the REFUND', async () =>
      (await referenceWaitOf(orm, refund.externalTransactionId))?.status === 'PROCESSED',
    );
    const stored = await referenceWaitOf(orm, refund.externalTransactionId);
    expect(stored).toEqual(
      expect.objectContaining({ failure_code: null, scheduled: false, reference_transaction_id: String(placed.body.transactionId) }),
    );
    expect(stored?.reference_attempts).toBeGreaterThanOrEqual(1);

    const replay = await submit(app.baseUrl, refund);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({
      transactionId: waiting.body.transactionId,
      status: 'PROCESSED',
      balance: { amount: '100.00', currency: 'BRL' },
      idempotentReplay: true,
    });
    expect((await ledgerEntries(orm, wallet.id)).map((entry) => [entry.direction, entry.amount])).toEqual([
      ['CREDIT', '100.00'],
      ['DEBIT', '25.00'],
      ['CREDIT', '25.00'],
    ]);
    // Announced once when it started waiting, then once when it was decided.
    expect(await eventTypesOf(orm, String(waiting.body.transactionId))).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    expect(app.metrics.value(MetricName.PendingReferencesResolved, { status: 'PROCESSED' })).toBe(1);
    await expectBalanceMatchesLedger(orm, app.baseUrl, wallet.id, '100.00');
  });

  test('the reference never arrives: after the configured checks, REJECTED with REFERENCE_NOT_FOUND and a WagerTransactionRejected event', async () => {
    const app = await start(workerConfig({ maxAttempts: 3, baseDelayMs: 20, maxDelayMs: 40 }));
    const wallet = await openWallet(app.baseUrl, '100.00');
    const { bet, reversal: refund } = betAndReversal(wallet, 'REFUND');

    const waiting = await submit(app.baseUrl, refund);
    expect(waiting.status).toBe(202);

    await waitUntil('the worker gave up on the REFUND', async () =>
      (await referenceWaitOf(orm, refund.externalTransactionId))?.status === 'REJECTED',
    );
    expect(await referenceWaitOf(orm, refund.externalTransactionId)).toEqual(
      expect.objectContaining({ failure_code: 'REFERENCE_NOT_FOUND', reference_attempts: 3, scheduled: false }),
    );
    expect(await eventTypesOf(orm, String(waiting.body.transactionId))).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
    expect(app.metrics.value(MetricName.PendingReferencesExpired)).toBe(1);
    expect(app.logs.events('pending_reference.expired')[0]?.fields).toEqual(
      expect.objectContaining({
        transactionId: waiting.body.transactionId,
        correlationId: waiting.body.transactionId,
        walletId: wallet.id,
        attempt: 3,
      }),
    );

    const replay = await submit(app.baseUrl, refund);
    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({
      transactionId: waiting.body.transactionId,
      status: 'REJECTED',
      balance: { amount: '100.00', currency: 'BRL' },
      failureCode: 'REFERENCE_NOT_FOUND',
      idempotentReplay: true,
    });

    // The BET that finally arrives is a normal BET; the rejected REFUND stays rejected.
    expect((await submit(app.baseUrl, bet)).status).toBe(201);
    await app.get(ResolvePendingReferences).resolveBatch();
    expect((await referenceWaitOf(orm, refund.externalTransactionId))?.status).toBe('REJECTED');
    await expectBalanceMatchesLedger(orm, app.baseUrl, wallet.id, '75.00');
  });

  test('two workers on the same pending row: the second skips it, the REFUND is credited once', async () => {
    // Two app instances (two connection pools), workers driven by the test.
    const [first, second] = await Promise.all([start(integrationConfig()), start(integrationConfig())]);
    if (first === undefined || second === undefined) throw new Error('two apps');
    const wallet = await openWallet(first.baseUrl, '100.00');
    const { bet, reversal: refund } = betAndReversal(wallet, 'REFUND');
    expect((await submit(first.baseUrl, refund)).status).toBe(202);
    expect((await submit(first.baseUrl, bet)).status).toBe(201);

    // The test holds the wallet row: worker 1 takes the pending row and then waits for the wallet.
    const holder = await DedicatedConnection.open();
    try {
      await holder.run('begin');
      await holder.run(`select id from wallets where id = '${wallet.id}' for no key update`);
      const firstRun = first.get(ResolvePendingReferences).resolveBatch();
      await waitUntil('worker 1 holds the pending row and waits for the wallet', () => someoneWaitsFor(orm, holder));

      // Worker 2 does not wait for worker 1 (SKIP LOCKED): it finds nothing it may take.
      expect(await second.get(ResolvePendingReferences).resolveBatch()).toEqual({
        checked: 0,
        resolved: 0,
        stillWaiting: 0,
        expired: 0,
        failed: 0,
      });

      await holder.run('commit');
      expect(await firstRun).toEqual({ checked: 1, resolved: 1, stillWaiting: 0, expired: 0, failed: 0 });
    } finally {
      await holder.close();
    }

    expect((await referenceWaitOf(orm, refund.externalTransactionId))?.status).toBe('PROCESSED');
    expect((await ledgerEntries(orm, wallet.id)).filter((entry) => entry.direction === 'CREDIT')).toHaveLength(2);
    const refundId = String((await referenceWaitOf(orm, refund.externalTransactionId))?.id);
    expect(await eventTypesOf(orm, refundId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    const view = await request(first.baseUrl, 'GET', `/wagering/transactions/${refundId}`);
    expect(view.body).toEqual(expect.objectContaining({ status: 'PROCESSED', balance: { amount: '100.00', currency: 'BRL' } }));
    await expectBalanceMatchesLedger(orm, first.baseUrl, wallet.id, '100.00');
  });

  test('a pending row whose wallet stays locked (lock timeout) does not block the pending rows of other wallets', async () => {
    const app = await start(integrationConfig()); // worker driven by the test
    const busy = await openWallet(app.baseUrl, '100.00');
    const other = await openWallet(app.baseUrl, '100.00');
    const onBusy = betAndReversal(busy, 'REFUND');
    const onOther = betAndReversal(other, 'REFUND');
    // The busy wallet's REFUND is stored first, so it is the most overdue row.
    expect((await submit(app.baseUrl, onBusy.reversal)).status).toBe(202);
    expect((await submit(app.baseUrl, onOther.reversal)).status).toBe(202);
    expect((await submit(app.baseUrl, onBusy.bet)).status).toBe(201);
    expect((await submit(app.baseUrl, onOther.bet)).status).toBe(201);

    const holder = await DedicatedConnection.open();
    try {
      await holder.run('begin');
      await holder.run(`select id from wallets where id = '${busy.id}' for no key update`);

      // The check of the busy wallet's REFUND hits the 2 s lock_timeout and rolls back; the batch moves on.
      const result = await app.get(ResolvePendingReferences).resolveBatch();

      expect(result).toEqual({ checked: 1, resolved: 1, stillWaiting: 0, expired: 0, failed: 1 });
      expect(app.logs.events('pending_reference.check_failed')[0]?.fields).toEqual(
        expect.objectContaining({ walletId: busy.id, errorClass: 'LockContentionError', causeCode: '55P03' }),
      );
    } finally {
      await holder.run('rollback');
      await holder.close();
    }
    expect((await referenceWaitOf(orm, onOther.reversal.externalTransactionId))?.status).toBe('PROCESSED');
    // Rolled back entirely: still waiting, the failed check not even counted.
    expect(await referenceWaitOf(orm, onBusy.reversal.externalTransactionId)).toEqual(
      expect.objectContaining({ status: 'PENDING_REFERENCE', reference_attempts: 0 }),
    );

    // Once the wallet is free, the next batch resolves it.
    expect((await app.get(ResolvePendingReferences).resolveBatch()).resolved).toBe(1);
    await expectBalanceMatchesLedger(orm, app.baseUrl, busy.id, '100.00');
    await expectBalanceMatchesLedger(orm, app.baseUrl, other.id, '100.00');
  });

  test('a pending row whose COMMIT fails (deferred trigger) is skipped: the other due rows are still resolved', async () => {
    const app = await start(integrationConfig()); // worker driven by the test
    const brokenWallet = await openWallet(app.baseUrl, '100.00');
    const otherWallet = await openWallet(app.baseUrl, '100.00');
    const broken = betAndReversal(brokenWallet, 'REFUND');
    const other = betAndReversal(otherWallet, 'REFUND');
    // The broken REFUND is stored first, so it is the most overdue row.
    expect((await submit(app.baseUrl, broken.reversal)).status).toBe(202);
    expect((await submit(app.baseUrl, other.reversal)).status).toBe(202);
    expect((await submit(app.baseUrl, broken.bet)).status).toBe(201);
    expect((await submit(app.baseUrl, other.bet)).status).toBe(201);
    const brokenId = String((await referenceWaitOf(orm, broken.reversal.externalTransactionId))?.id);

    // Test only: a constraint trigger checked at COMMIT that refuses any update of that one row.
    await query(orm, `create function test_refuse_commit() returns trigger language plpgsql as $$
      begin raise exception 'test: commit refused for %', new.id; end $$`);
    await query(orm, `create constraint trigger test_refuse_commit after update on wager_transactions
      deferrable initially deferred for each row when (new.id = '${brokenId}'::uuid)
      execute function test_refuse_commit()`);
    try {
      const result = await app.get(ResolvePendingReferences).resolveBatch();

      expect(result).toEqual({ checked: 1, resolved: 1, stillWaiting: 0, expired: 0, failed: 1 });
      expect(app.logs.events('pending_reference.check_failed')[0]?.fields).toEqual(
        expect.objectContaining({ transactionId: brokenId, errorClass: 'DatabaseError', errorCode: 'P0001' }),
      );
    } finally {
      await query(orm, 'drop trigger if exists test_refuse_commit on wager_transactions');
      await query(orm, 'drop function if exists test_refuse_commit()');
    }
    expect((await referenceWaitOf(orm, other.reversal.externalTransactionId))?.status).toBe('PROCESSED');
    expect(await referenceWaitOf(orm, broken.reversal.externalTransactionId)).toEqual(
      expect.objectContaining({ status: 'PENDING_REFERENCE', reference_attempts: 0 }),
    );

    // Without the trigger, the next batch resolves it.
    expect((await app.get(ResolvePendingReferences).resolveBatch()).resolved).toBe(1);
    await expectBalanceMatchesLedger(orm, app.baseUrl, brokenWallet.id, '100.00');
    await expectBalanceMatchesLedger(orm, app.baseUrl, otherWallet.id, '100.00');
  });

  test('chain: a ROLLBACK waits for a REFUND that waits for a late BET; past its last check the ROLLBACK keeps waiting and is then processed', async () => {
    const app = await start(workerConfig({ enabled: false, maxAttempts: 2 })); // worker driven by the test
    const worker = app.get(ResolvePendingReferences);
    const wallet = await openWallet(app.baseUrl, '100.00');
    const { bet, reversal: refund } = betAndReversal(wallet, 'REFUND');
    const rollback = wager(wallet, {
      kind: 'ROLLBACK',
      roundId: bet.roundId,
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: refund.externalTransactionId,
    });
    expect((await submit(app.baseUrl, rollback)).status).toBe(202); // its REFUND does not exist yet
    expect((await submit(app.baseUrl, refund)).status).toBe(202); // its BET does not exist yet
    await scheduleCheck(orm, refund.externalTransactionId, 'parked');

    // Three checks of the ROLLBACK: the 2nd is its last one (maxAttempts 2), the 3rd goes past it.
    for (let check = 0; check < 3; check++) {
      await scheduleCheck(orm, rollback.externalTransactionId, 'due');
      expect((await worker.resolveBatch()).stillWaiting).toBe(1);
    }
    // The REFUND exists (still waiting), so the ROLLBACK is not rejected: it keeps waiting.
    expect(await referenceWaitOf(orm, rollback.externalTransactionId)).toEqual(
      expect.objectContaining({ status: 'PENDING_REFERENCE', failure_code: null, reference_attempts: 3, scheduled: true }),
    );

    expect((await submit(app.baseUrl, bet)).status).toBe(201); // the BET arrives late: 75.00
    await scheduleCheck(orm, rollback.externalTransactionId, 'parked');
    await scheduleCheck(orm, refund.externalTransactionId, 'due');
    expect((await worker.resolveBatch()).resolved).toBe(1); // REFUND: 100.00
    await scheduleCheck(orm, rollback.externalTransactionId, 'due');
    expect((await worker.resolveBatch()).resolved).toBe(1); // ROLLBACK of the REFUND: 75.00

    expect((await referenceWaitOf(orm, rollback.externalTransactionId))?.status).toBe('PROCESSED');
    expect((await ledgerEntries(orm, wallet.id)).map((entry) => [entry.direction, entry.amount])).toEqual([
      ['CREDIT', '100.00'],
      ['DEBIT', '25.00'],
      ['CREDIT', '25.00'],
      ['DEBIT', '25.00'],
    ]);
    const rollbackId = String((await referenceWaitOf(orm, rollback.externalTransactionId))?.id);
    expect(await eventTypesOf(orm, rollbackId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    await expectBalanceMatchesLedger(orm, app.baseUrl, wallet.id, '75.00');
  });
});
