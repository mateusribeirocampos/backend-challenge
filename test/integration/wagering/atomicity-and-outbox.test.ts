import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { openMigratedDatabase, query } from '../schema/support/schema-sql.js';
import { integrationConfig } from '../support/integration-config.js';
import { type RunningTestApp, startTestApp } from '../support/test-app.js';
import {
  countRows,
  expectBalanceMatchesLedger,
  ledgerEntries,
  openWallet,
  outboxEvents,
  request,
  submit,
  wager,
  walletState,
} from './support/wagering-api.js';

/**
 * Spec 11: transaction, balance, ledger and the integration events are written in ONE
 * SQL transaction. These tests read outbox_messages directly; nothing is published
 * yet (the publisher worker comes later).
 */
describe('outbox written with the change (spec 11, ADR-005)', () => {
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

  async function eventsOf(walletId: string, transactionId: unknown): Promise<{ event_type: string; payload: Record<string, unknown> }[]> {
    return (await outboxEvents(orm, walletId)).filter(
      (event) => (event.payload.data as { transactionId?: unknown }).transactionId === transactionId,
    );
  }

  test('opening a wallet with balance: OPENING processed + balance changed, in the same commit as the wallet', async () => {
    const wallet = await openWallet(app.baseUrl, '100.00');

    const events = await outboxEvents(orm, wallet.id);

    expect(events.map((event) => event.event_type)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect(events[0]?.payload.data).toMatchObject({ kind: 'OPENING', providerId: 'internal', balance: { amount: '100.00' } });
    expect(events[1]?.payload.data).toMatchObject({
      direction: 'CREDIT',
      balanceBefore: { amount: '0.00', currency: 'BRL' },
      balanceAfter: { amount: '100.00', currency: 'BRL' },
      walletVersion: 1,
    });
    expect(await ledgerEntries(orm, wallet.id)).toHaveLength(1);
    await expectBalanceMatchesLedger(orm, app.baseUrl, wallet.id, '100.00');
  });

  test('opening a wallet with 0.00: no OPENING, no ledger entry, no event', async () => {
    const wallet = await openWallet(app.baseUrl, '0.00');

    expect(await outboxEvents(orm, wallet.id)).toEqual([]);
    expect(await countRows(orm, 'wager_transactions', `wallet_id = '${wallet.id}'`)).toBe(0);
    expect(await walletState(orm, wallet.id)).toEqual({ balance: '0.00', version: 1 });
    await expectBalanceMatchesLedger(orm, app.baseUrl, wallet.id, '0.00');
  });

  test('BET processed: WagerTransactionProcessed + WalletBalanceChanged, full envelope, pending for the publisher', async () => {
    const wallet = await openWallet(app.baseUrl, '100.00');
    const response = await submit(app.baseUrl, wager(wallet, { money: { amount: '30.00', currency: 'BRL' } }), undefined, {
      'x-correlation-id': 'corr-bet',
    });

    const events = await eventsOf(wallet.id, response.body.transactionId);

    expect(events.map((event) => event.event_type)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    for (const { event_type, payload } of events) {
      expect(payload).toMatchObject({
        eventId: expect.any(String),
        eventType: event_type,
        aggregateId: wallet.id,
        correlationId: 'corr-bet',
        version: 1,
        occurredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      });
    }
    expect(events[1]?.payload.data).toEqual({
      walletId: wallet.id,
      transactionId: response.body.transactionId,
      direction: 'DEBIT',
      money: { amount: '30.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '70.00', currency: 'BRL' },
      walletVersion: 2,
    });
    const rows = await query<{ same_id: boolean; attempts: number; published: boolean; due_now: boolean }>(
      orm,
      `select id::text = payload->>'eventId' as same_id, attempts, published_at is not null as published,
              next_attempt_at = occurred_at as due_now
         from outbox_messages where aggregate_id = '${wallet.id}'`,
    );
    expect(rows.every((row) => row.same_id && row.attempts === 0 && !row.published && row.due_now)).toBe(true);
    await expectBalanceMatchesLedger(orm, app.baseUrl, wallet.id, '70.00');
  });

  test('LOSS is processed but the balance does not change: no WalletBalanceChanged, no ledger entry', async () => {
    const wallet = await openWallet(app.baseUrl, '100.00');

    const response = await submit(app.baseUrl, wager(wallet, { kind: 'LOSS', money: { amount: '0.00', currency: 'BRL' } }));

    expect(response.status).toBe(201);
    expect((await eventsOf(wallet.id, response.body.transactionId)).map((event) => event.event_type)).toEqual([
      'WagerTransactionProcessed',
    ]);
    expect(await walletState(orm, wallet.id)).toEqual({ balance: '100.00', version: 1 });
    await expectBalanceMatchesLedger(orm, app.baseUrl, wallet.id, '100.00');
  });

  test('a rejection writes only WagerTransactionRejected', async () => {
    const wallet = await openWallet(app.baseUrl, '10.00');

    const response = await submit(app.baseUrl, wager(wallet, { money: { amount: '50.00', currency: 'BRL' } }));

    const events = await eventsOf(wallet.id, response.body.transactionId);
    expect(events.map((event) => event.event_type)).toEqual(['WagerTransactionRejected']);
    expect(events[0]?.payload.data).toMatchObject({ failureCode: 'INSUFFICIENT_FUNDS', balance: { amount: '10.00' } });
    await expectBalanceMatchesLedger(orm, app.baseUrl, wallet.id, '10.00');
  });

  test('a pending reference writes only WagerTransactionPendingReference', async () => {
    const wallet = await openWallet(app.baseUrl, '10.00');

    const response = await submit(
      app.baseUrl,
      wager(wallet, { kind: 'REFUND', money: { amount: '5.00', currency: 'BRL' }, referenceExternalTransactionId: 'bet-later' }),
    );

    const events = await eventsOf(wallet.id, response.body.transactionId);
    expect(events.map((event) => event.event_type)).toEqual(['WagerTransactionPendingReference']);
    expect(events[0]?.payload.data).toMatchObject({ referenceExternalTransactionId: 'bet-later' });
    await expectBalanceMatchesLedger(orm, app.baseUrl, wallet.id, '10.00');
  });

  test('a replay writes no event at all', async () => {
    const wallet = await openWallet(app.baseUrl, '100.00');
    const bet = wager(wallet);
    await submit(app.baseUrl, bet);
    const before = (await outboxEvents(orm, wallet.id)).length;

    await Promise.all([submit(app.baseUrl, bet), submit(app.baseUrl, bet), submit(app.baseUrl, bet)]);

    expect((await outboxEvents(orm, wallet.id)).length).toBe(before);
    await expectBalanceMatchesLedger(orm, app.baseUrl, wallet.id, '75.00');
  });

  test('REFUND of a processed BET: credit, reference resolved, both events', async () => {
    const wallet = await openWallet(app.baseUrl, '100.00');
    const bet = wager(wallet, { money: { amount: '40.00', currency: 'BRL' } });
    const betResponse = await submit(app.baseUrl, bet);

    const refund = await submit(
      app.baseUrl,
      wager(wallet, {
        kind: 'REFUND',
        roundId: bet.roundId,
        money: { amount: '40.00', currency: 'BRL' },
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );

    expect(refund.status).toBe(201);
    expect(refund.body.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    const events = await eventsOf(wallet.id, refund.body.transactionId);
    expect(events[0]?.payload.data).toMatchObject({ kind: 'REFUND', referenceTransactionId: betResponse.body.transactionId });
    expect(events.map((event) => event.event_type)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);

    // A second reversal of the same BET is refused (ADR-008), resolved under the wallet lock.
    const rollback = await submit(
      app.baseUrl,
      wager(wallet, {
        kind: 'ROLLBACK',
        roundId: bet.roundId,
        money: { amount: '40.00', currency: 'BRL' },
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );
    expect(rollback.status).toBe(422);
    expect(rollback.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    await expectBalanceMatchesLedger(orm, app.baseUrl, wallet.id, '100.00');
  });

  test('parallel duplicate wallet creation: exactly one 201, the others 409', async () => {
    const playerId = randomUUID();
    const body = { playerId, initialBalance: { amount: '50.00', currency: 'BRL' } };

    const responses = await Promise.all(Array.from({ length: 5 }, () => request(app.baseUrl, 'POST', '/wallets', { body })));

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409, 409, 409, 409]);
    const created = responses.find((response) => response.status === 201);
    expect(await countRows(orm, 'wallets', `player_id = '${playerId}'`)).toBe(1);
    await expectBalanceMatchesLedger(orm, app.baseUrl, String(created?.body.id), '50.00');
  });
});

/**
 * All or nothing: a failure AFTER the ledger insert must leave no trace. A temporary
 * trigger makes the outbox insert of one wallet fail, but only once that wallet's
 * ledger entry for the transaction already exists in the same SQL transaction (so the
 * test also proves the order: wallet, transaction, ledger, then outbox).
 */
describe('atomicity: wallet, transaction, ledger and outbox commit together or not at all', () => {
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

  async function failOutboxAfterLedgerFor(walletId: string): Promise<void> {
    await orm.em.getConnection().execute(`
      create function test_fail_outbox_after_ledger() returns trigger language plpgsql as $$
      begin
        if new.aggregate_id = '${walletId}' and exists (
             select 1 from wallet_ledger_entries
              where wallet_id = new.aggregate_id
                and transaction_id = (new.payload->'data'->>'transactionId')::uuid) then
          raise exception 'forced failure after the ledger insert';
        end if;
        return new;
      end $$;
      create trigger test_fail_outbox_after_ledger before insert on outbox_messages
        for each row execute function test_fail_outbox_after_ledger();`);
  }

  async function removeForcedFailure(): Promise<void> {
    await orm.em.getConnection().execute(`
      drop trigger if exists test_fail_outbox_after_ledger on outbox_messages;
      drop function if exists test_fail_outbox_after_ledger();`);
  }

  test('a failure after the ledger insert rolls back everything; the same request then succeeds', async () => {
    const wallet = await openWallet(app.baseUrl, '100.00');
    const bet = wager(wallet, { money: { amount: '25.00', currency: 'BRL' } });
    const outboxBefore = (await outboxEvents(orm, wallet.id)).length;

    let failed: Awaited<ReturnType<typeof submit>>;
    await failOutboxAfterLedgerFor(wallet.id);
    try {
      failed = await submit(app.baseUrl, bet);
    } finally {
      await removeForcedFailure();
    }

    expect(failed.status).toBe(500);
    expect(failed.body.errorCode).toBe('INTERNAL_ERROR');
    expect(await walletState(orm, wallet.id)).toEqual({ balance: '100.00', version: 1 });
    expect(await ledgerEntries(orm, wallet.id)).toHaveLength(1);
    expect((await outboxEvents(orm, wallet.id)).length).toBe(outboxBefore);
    expect(await countRows(orm, 'wager_transactions', `external_transaction_id = '${bet.externalTransactionId}'`)).toBe(0);

    const retried = await submit(app.baseUrl, bet);
    expect(retried.status).toBe(201);
    expect(retried.body.idempotentReplay).toBe(false);
    await expectBalanceMatchesLedger(orm, app.baseUrl, wallet.id, '75.00');
  });
});
