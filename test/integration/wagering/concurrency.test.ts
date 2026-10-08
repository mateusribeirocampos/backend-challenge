import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { DedicatedConnection } from '../schema/support/dedicated-connection.js';
import { openMigratedDatabase } from '../schema/support/schema-sql.js';
import { integrationConfig } from '../support/integration-config.js';
import { type RunningTestApp, startTestApp } from '../support/test-app.js';
import {
  countRows,
  expectBalanceMatchesLedger,
  ledgerEntries,
  openWallet,
  submit,
  wager,
  walletState,
} from './support/wagering-api.js';

/**
 * Spec 13, concurrency tests 1 to 3, over real HTTP against real PostgreSQL. The
 * requests are fired together with Promise.all: nothing is serialized by the test.
 */
describe('concurrency over HTTP (spec 13)', () => {
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

  test('1. the same BET sent 50 times in parallel debits once', async () => {
    const wallet = await openWallet(app.baseUrl, '100.00');
    const bet = wager(wallet, { money: { amount: '25.00', currency: 'BRL' } });

    const responses = await Promise.all(Array.from({ length: 50 }, () => submit(app.baseUrl, bet)));

    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 200)).toHaveLength(49);
    // Every answer, first or replay, is the same transaction with the same balance.
    const transactionIds = new Set(responses.map((response) => response.body.transactionId));
    expect(transactionIds.size).toBe(1);
    for (const response of responses) {
      expect(response.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '75.00', currency: 'BRL' } });
      expect(response.body.idempotentReplay).toBe(response.status === 200);
    }

    const debits = (await ledgerEntries(orm, wallet.id)).filter((entry) => entry.direction === 'DEBIT');
    expect(debits).toHaveLength(1);
    expect(await countRows(orm, 'wager_transactions', `idempotency_key = 'provider-a:${bet.externalTransactionId}'`)).toBe(1);
    expect(await walletState(orm, wallet.id)).toEqual({ balance: '75.00', version: 2 });
    await expectBalanceMatchesLedger(orm, app.baseUrl, wallet.id, '75.00');
  });

  test('2. balance 100, two different BETs of 80 in parallel: one PROCESSED, one INSUFFICIENT_FUNDS, final 20.00', async () => {
    const wallet = await openWallet(app.baseUrl, '100.00');
    const first = wager(wallet, { money: { amount: '80.00', currency: 'BRL' } });
    const second = wager(wallet, { money: { amount: '80.00', currency: 'BRL' } });

    const responses = await Promise.all([submit(app.baseUrl, first), submit(app.baseUrl, second)]);

    const processed = responses.filter((response) => response.status === 201);
    const rejected = responses.filter((response) => response.status === 422);
    expect(processed).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(processed[0]?.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '20.00' } });
    expect(rejected[0]?.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: { amount: '20.00' },
      idempotentReplay: false,
    });

    const entries = await ledgerEntries(orm, wallet.id);
    expect(entries.filter((entry) => entry.direction === 'DEBIT')).toHaveLength(1);
    expect(await walletState(orm, wallet.id)).toEqual({ balance: '20.00', version: 2 });

    // "No retry duplicates the debit": both are resent, each gets its original answer.
    const retries = await Promise.all([submit(app.baseUrl, first), submit(app.baseUrl, second)]);
    expect(retries.map((response) => response.body.idempotentReplay)).toEqual([true, true]);
    expect(retries.map((response) => response.status).sort()).toEqual([200, 422]);
    expect((await ledgerEntries(orm, wallet.id)).filter((entry) => entry.direction === 'DEBIT')).toHaveLength(1);
    await expectBalanceMatchesLedger(orm, app.baseUrl, wallet.id, '20.00');
  });

  test('2b. ten BETs of 15 against 100 in parallel: exactly six debits, final 10.00, never negative', async () => {
    const wallet = await openWallet(app.baseUrl, '100.00');
    const bets = Array.from({ length: 10 }, () => wager(wallet, { money: { amount: '15.00', currency: 'BRL' } }));

    const responses = await Promise.all(bets.map((bet) => submit(app.baseUrl, bet)));

    expect(responses.filter((response) => response.status === 201)).toHaveLength(6);
    const rejected = responses.filter((response) => response.status === 422);
    expect(rejected).toHaveLength(4);
    for (const response of rejected) {
      expect(response.body.failureCode).toBe('INSUFFICIENT_FUNDS');
    }
    expect(await walletState(orm, wallet.id)).toEqual({ balance: '10.00', version: 7 });
    await expectBalanceMatchesLedger(orm, app.baseUrl, wallet.id, '10.00');
  });

  test('2c. REFUND and ROLLBACK of the same BET in parallel: exactly one reversal, never 125', async () => {
    const wallet = await openWallet(app.baseUrl, '100.00');
    const bet = wager(wallet, { money: { amount: '25.00', currency: 'BRL' } });
    expect((await submit(app.baseUrl, bet)).status).toBe(201);
    const reversal = (kind: string) =>
      wager(wallet, {
        kind,
        roundId: bet.roundId,
        money: { amount: '25.00', currency: 'BRL' },
        referenceExternalTransactionId: bet.externalTransactionId,
      });

    const responses = await Promise.all([submit(app.baseUrl, reversal('REFUND')), submit(app.baseUrl, reversal('ROLLBACK'))]);

    expect(responses.map((response) => response.status).sort()).toEqual([201, 422]);
    expect(responses.find((response) => response.status === 422)?.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    expect((await ledgerEntries(orm, wallet.id)).filter((entry) => entry.direction === 'CREDIT')).toHaveLength(2);
    await expectBalanceMatchesLedger(orm, app.baseUrl, wallet.id, '100.00');
  });

  test('3. different wallets in parallel: each one ends with its own correct balance', async () => {
    const wallets = await Promise.all(Array.from({ length: 5 }, () => openWallet(app.baseUrl, '100.00')));
    const requests = wallets.flatMap((wallet) =>
      Array.from({ length: 4 }, () => wager(wallet, { money: { amount: '10.00', currency: 'BRL' } })),
    );

    const responses = await Promise.all(requests.map((bet) => submit(app.baseUrl, bet)));

    expect(responses.every((response) => response.status === 201)).toBe(true);
    for (const wallet of wallets) {
      expect(await walletState(orm, wallet.id)).toEqual({ balance: '60.00', version: 5 });
      await expectBalanceMatchesLedger(orm, app.baseUrl, wallet.id, '60.00');
    }
  });

  test('3b. no global lock: wallet B is processed while wallet A is locked by another session', async () => {
    const walletA = await openWallet(app.baseUrl, '100.00');
    const walletB = await openWallet(app.baseUrl, '100.00');
    const blocker = await DedicatedConnection.open();
    try {
      await blocker.run('begin');
      await blocker.run(`select id from wallets where id = '${walletA.id}' for no key update`);

      // Wallet A's row is held by the blocker; a BET on B must not wait for it.
      const onB = await submit(app.baseUrl, wager(walletB));

      expect(onB.status).toBe(201);
      expect(onB.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '75.00' } });
    } finally {
      await blocker.run('rollback');
      await blocker.close();
    }
    await expectBalanceMatchesLedger(orm, app.baseUrl, walletA.id, '100.00');
    await expectBalanceMatchesLedger(orm, app.baseUrl, walletB.id, '75.00');
  });
});
