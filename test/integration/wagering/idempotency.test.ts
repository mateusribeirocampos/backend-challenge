import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { openMigratedDatabase } from '../schema/support/schema-sql.js';
import { integrationConfig } from '../support/integration-config.js';
import { type RunningTestApp, startTestApp } from '../support/test-app.js';
import {
  countRows,
  expectBalanceMatchesLedger,
  ledgerEntries,
  openWallet,
  outboxEvents,
  submit,
  wager,
  walletState,
} from './support/wagering-api.js';

/** ADR-003 over HTTP: the database row is the idempotency record, not memory. */
describe('idempotency (spec 9, ADR-003)', () => {
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

  test('a replay returns the identical body plus idempotentReplay, with the balance observed back then', async () => {
    const wallet = await openWallet(app.baseUrl, '100.00');
    const bet = wager(wallet, { money: { amount: '25.00', currency: 'BRL' } });
    const first = await submit(app.baseUrl, bet);
    // Later operations move the balance: 75 -> 85 -> 45.
    await submit(app.baseUrl, wager(wallet, { kind: 'WIN', money: { amount: '10.00', currency: 'BRL' } }));
    await submit(app.baseUrl, wager(wallet, { money: { amount: '40.00', currency: 'BRL' } }));

    const replay = await submit(app.baseUrl, bet);

    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(replay.body.balance).toEqual({ amount: '75.00', currency: 'BRL' });
    await expectBalanceMatchesLedger(orm, app.baseUrl, wallet.id, '45.00');
  });

  test('any Idempotency-Key is accepted: a bare UUID behaves like the recommended "{providerId}:{externalTransactionId}"', async () => {
    const wallet = await openWallet(app.baseUrl, '100.00');
    const bet = wager(wallet, { money: { amount: '25.00', currency: 'BRL' } });
    const key = randomUUID();

    const first = await submit(app.baseUrl, bet, key);
    const replay = await submit(app.baseUrl, bet, key);

    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    await expectBalanceMatchesLedger(orm, app.baseUrl, wallet.id, '75.00');
  });

  test('the same key from two providers: two independent operations, neither blocks nor replays the other', async () => {
    const wallet = await openWallet(app.baseUrl, '100.00');
    const key = `shared-${randomUUID()}`;
    const fromA = wager(wallet, { providerId: 'provider-a', money: { amount: '25.00', currency: 'BRL' } });
    const fromB = wager(wallet, { providerId: 'provider-b', money: { amount: '30.00', currency: 'BRL' } });

    const a = await submit(app.baseUrl, fromA, key);
    const b = await submit(app.baseUrl, fromB, key);

    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.body.transactionId).not.toBe(a.body.transactionId);
    // Inside one provider the key still means one operation: replay, or conflict with another payload.
    expect((await submit(app.baseUrl, fromA, key)).status).toBe(200);
    expect((await submit(app.baseUrl, { ...fromA, money: { amount: '26.00', currency: 'BRL' } }, key)).status).toBe(409);
    await expectBalanceMatchesLedger(orm, app.baseUrl, wallet.id, '45.00');
  });

  test('the same operation with the amount written differently ("25" vs "25.00") is a replay, not a conflict', async () => {
    const wallet = await openWallet(app.baseUrl, '100.00');
    const bet = wager(wallet, { money: { amount: '25.00', currency: 'BRL' } });
    await submit(app.baseUrl, bet);

    const replay = await submit(app.baseUrl, { ...bet, money: { amount: '25', currency: 'BRL' } });

    expect(replay.status).toBe(200);
    expect(replay.body.idempotentReplay).toBe(true);
    await expectBalanceMatchesLedger(orm, app.baseUrl, wallet.id, '75.00');
  });

  test('"referenceExternalTransactionId": null is the same as leaving it out: accepted, and the other form is a replay', async () => {
    const wallet = await openWallet(app.baseUrl, '100.00');
    const bet = wager(wallet);

    const withNull = await submit(app.baseUrl, { ...bet, referenceExternalTransactionId: null });
    const withoutField = await submit(app.baseUrl, bet);

    expect(withNull.status).toBe(201);
    expect(withoutField.status).toBe(200);
    expect(withoutField.body).toEqual({ ...withNull.body, idempotentReplay: true });
    await expectBalanceMatchesLedger(orm, app.baseUrl, wallet.id, '75.00');
  });

  test('same key with a different payload is 409 IDEMPOTENCY_KEY_CONFLICT and changes nothing', async () => {
    const wallet = await openWallet(app.baseUrl, '100.00');
    const bet = wager(wallet, { money: { amount: '25.00', currency: 'BRL' } });
    const first = await submit(app.baseUrl, bet);
    const outboxBefore = (await outboxEvents(orm, wallet.id)).length;

    const conflict = await submit(app.baseUrl, { ...bet, money: { amount: '30.00', currency: 'BRL' } });

    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ errorCode: 'IDEMPOTENCY_KEY_CONFLICT' });
    expect(typeof conflict.body.correlationId).toBe('string');
    expect(await walletState(orm, wallet.id)).toEqual({ balance: '75.00', version: 2 });
    expect(await ledgerEntries(orm, wallet.id)).toHaveLength(2);
    expect((await outboxEvents(orm, wallet.id)).length).toBe(outboxBefore);
    expect(await countRows(orm, 'wager_transactions', `id = '${String(first.body.transactionId)}' and amount = 25`)).toBe(1);
    await expectBalanceMatchesLedger(orm, app.baseUrl, wallet.id, '75.00');
  });

  test('a key that differs only in the walletId (now pointing to a missing wallet) is still a conflict, not 404', async () => {
    const wallet = await openWallet(app.baseUrl, '100.00');
    const bet = wager(wallet);
    await submit(app.baseUrl, bet);

    const conflict = await submit(app.baseUrl, { ...bet, walletId: randomUUID() });

    expect(conflict.status).toBe(409);
    expect(conflict.body.errorCode).toBe('IDEMPOTENCY_KEY_CONFLICT');
    await expectBalanceMatchesLedger(orm, app.baseUrl, wallet.id, '75.00');
  });

  test('the same externalTransactionId under another key is 409 EXTERNAL_TRANSACTION_ID_CONFLICT', async () => {
    const wallet = await openWallet(app.baseUrl, '100.00');
    const bet = wager(wallet);
    await submit(app.baseUrl, bet);

    const conflict = await submit(app.baseUrl, bet, `provider-a:another-key-${randomUUID()}`);

    expect(conflict.status).toBe(409);
    expect(conflict.body.errorCode).toBe('EXTERNAL_TRANSACTION_ID_CONFLICT');
    expect((await ledgerEntries(orm, wallet.id)).filter((entry) => entry.direction === 'DEBIT')).toHaveLength(1);
    await expectBalanceMatchesLedger(orm, app.baseUrl, wallet.id, '75.00');
  });

  test('WALLET_NOT_FOUND is answered with 404 and no row is stored (wallet_id is a foreign key)', async () => {
    const wallet = await openWallet(app.baseUrl, '100.00');
    const bet = wager(wallet, { walletId: randomUUID() });

    const response = await submit(app.baseUrl, bet);

    expect(response.status).toBe(404);
    expect(response.body.errorCode).toBe('WALLET_NOT_FOUND');
    expect(await countRows(orm, 'wager_transactions', `idempotency_key = 'provider-a:${bet.externalTransactionId}'`)).toBe(0);
    // Not stored, so not "used": once the wallet id is right, the same key works.
    const fixed = await submit(app.baseUrl, { ...bet, walletId: wallet.id });
    expect(fixed.status).toBe(201);
    await expectBalanceMatchesLedger(orm, app.baseUrl, wallet.id, '75.00');
  });

  test('a rejection is replayed as 422 again with idempotentReplay true, even after the balance would allow it', async () => {
    const wallet = await openWallet(app.baseUrl, '10.00');
    const bet = wager(wallet, { money: { amount: '50.00', currency: 'BRL' } });
    const first = await submit(app.baseUrl, bet);
    await submit(app.baseUrl, wager(wallet, { kind: 'WIN', money: { amount: '100.00', currency: 'BRL' } }));

    const replay = await submit(app.baseUrl, bet);

    expect(first.status).toBe(422);
    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(replay.body).toMatchObject({ failureCode: 'INSUFFICIENT_FUNDS', balance: { amount: '10.00' } });
    await expectBalanceMatchesLedger(orm, app.baseUrl, wallet.id, '110.00');
  });
});
