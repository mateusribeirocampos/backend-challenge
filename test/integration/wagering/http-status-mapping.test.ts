import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { DedicatedConnection } from '../schema/support/dedicated-connection.js';
import { openMigratedDatabase, query } from '../schema/support/schema-sql.js';
import { integrationConfig } from '../support/integration-config.js';
import { type RunningTestApp, startTestApp } from '../support/test-app.js';
import {
  countRows,
  defaultKey,
  expectBalanceMatchesLedger,
  type HttpResult,
  ledgerEntries,
  openWallet,
  type OpenedWallet,
  request,
  submit,
  wager,
  type WagerBody,
} from './support/wagering-api.js';

/**
 * ADR-007: the provider decides "resend, fix or give up" from the status code alone,
 * and the same situation has the same code on every endpoint.
 */
describe('HTTP status mapping (ADR-007)', () => {
  let orm: MikroORM;
  let app: RunningTestApp;
  let wallet: OpenedWallet;

  beforeAll(async () => {
    orm = await openMigratedDatabase();
    app = await startTestApp(integrationConfig());
    wallet = await openWallet(app.baseUrl, '1000.00');
  });

  afterAll(async () => {
    await app.close();
    await orm.close(true);
  });

  function expectErrorEnvelope(response: HttpResult, status: number, errorCode: string): void {
    expect(response.status).toBe(status);
    expect(response.body.errorCode).toBe(errorCode);
    expect(typeof response.body.message).toBe('string');
    expect(typeof response.body.correlationId).toBe('string');
    expect(Object.keys(response.body).every((key) => ['errorCode', 'message', 'details', 'correlationId'].includes(key))).toBe(
      true,
    );
  }

  describe('POST /wagering/transactions', () => {
    test('201 processed, and both GET endpoints answer 200 with the same transaction', async () => {
      const bet = wager(wallet, { money: { amount: '10.00', currency: 'BRL' } });

      const created = await submit(app.baseUrl, bet);

      expect(created.status).toBe(201);
      expect(created.body).toEqual({
        transactionId: expect.any(String),
        status: 'PROCESSED',
        balance: { amount: '990.00', currency: 'BRL' },
        idempotentReplay: false,
      });
      const byId = await request(app.baseUrl, 'GET', `/wagering/transactions/${String(created.body.transactionId)}`);
      const byExternalId = await request(
        app.baseUrl,
        'GET',
        `/providers/provider-a/wagering/transactions/${bet.externalTransactionId}`,
      );
      expect(byId.status).toBe(200);
      expect(byExternalId.status).toBe(200);
      expect(byExternalId.body).toEqual(byId.body);
      expect(byId.body).toMatchObject({
        transactionId: created.body.transactionId,
        providerId: 'provider-a',
        externalTransactionId: bet.externalTransactionId,
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
        status: 'PROCESSED',
        failureCode: null,
        balance: { amount: '990.00', currency: 'BRL' },
      });
      await expectBalanceMatchesLedger(orm, app.baseUrl, wallet.id, '990.00');
    });

    test('202 pending reference: ROLLBACK before its BET is stored and scheduled, nothing moves; replay is 202 again', async () => {
      const own = await openWallet(app.baseUrl, '100.00');
      const rollback = wager(own, {
        kind: 'ROLLBACK',
        referenceExternalTransactionId: `bet-not-arrived-${randomUUID()}`,
      });

      const accepted = await submit(app.baseUrl, rollback);
      const replay = await submit(app.baseUrl, rollback);

      expect(accepted.status).toBe(202);
      expect(accepted.body).toEqual({
        transactionId: expect.any(String),
        status: 'PENDING_REFERENCE',
        idempotentReplay: false,
      });
      expect(replay.status).toBe(202);
      expect(replay.body).toEqual({ ...accepted.body, idempotentReplay: true });
      const [row] = await query<{ status: string; scheduled: boolean }>(
        orm,
        `select status, next_reference_check_at is not null as scheduled from wager_transactions
          where id = '${String(accepted.body.transactionId)}'`,
      );
      expect(row).toEqual({ status: 'PENDING_REFERENCE', scheduled: true });
      expect(await ledgerEntries(orm, own.id)).toHaveLength(1);
      await expectBalanceMatchesLedger(orm, app.baseUrl, own.id, '100.00');
    });

    test('422 business rejection carries the failureCode (currency of another wallet)', async () => {
      const response = await submit(app.baseUrl, wager(wallet, { money: { amount: '5.00', currency: 'USD' } }));

      expect(response.status).toBe(422);
      expect(response.body).toMatchObject({ status: 'REJECTED', failureCode: 'CURRENCY_MISMATCH', idempotentReplay: false });
      await expectBalanceMatchesLedger(orm, app.baseUrl, wallet.id, '990.00');
    });

    test('422 without the balance when the wallet belongs to another player', async () => {
      const response = await submit(app.baseUrl, wager(wallet, { playerId: randomUUID() }));

      expect(response.status).toBe(422);
      expect(response.body.failureCode).toBe('WALLET_PLAYER_MISMATCH');
      expect('balance' in response.body).toBe(false);
      await expectBalanceMatchesLedger(orm, app.baseUrl, wallet.id, '990.00');
    });

    const invalidRequests: { name: string; change: (body: WagerBody) => { body: unknown; key: string | null }; code: string }[] = [
      { name: 'missing Idempotency-Key', change: (body) => ({ body, key: null }), code: 'MISSING_FIELD' },
      { name: 'blank Idempotency-Key', change: (body) => ({ body, key: '   ' }), code: 'MISSING_FIELD' },
      { name: 'walletId not a UUID', change: (body) => ({ body: { ...body, walletId: 'wallet-1' }, key: defaultKey(body) }), code: 'INVALID_FORMAT' },
      { name: 'playerId not a UUID', change: (body) => ({ body: { ...body, playerId: '123' }, key: defaultKey(body) }), code: 'INVALID_FORMAT' },
      { name: 'kind OPENING', change: (body) => ({ body: { ...body, kind: 'OPENING' }, key: defaultKey(body) }), code: 'INTERNAL_KIND_NOT_ALLOWED' },
      { name: 'unknown kind', change: (body) => ({ body: { ...body, kind: 'JACKPOT' }, key: defaultKey(body) }), code: 'UNKNOWN_KIND' },
      {
        name: 'amount in scientific notation',
        change: (body) => ({ body: { ...body, money: { amount: '1e3', currency: 'BRL' } }, key: defaultKey(body) }),
        code: 'INVALID_MONEY',
      },
      {
        name: 'amount as a JSON number',
        change: (body) => ({ body: { ...body, money: { amount: 25, currency: 'BRL' } }, key: defaultKey(body) }),
        code: 'INVALID_MONEY',
      },
      {
        name: 'amount with three decimals',
        change: (body) => ({ body: { ...body, money: { amount: '1.234', currency: 'BRL' } }, key: defaultKey(body) }),
        code: 'INVALID_MONEY',
      },
      {
        name: 'roundId missing',
        change: (body) => ({ body: { ...body, roundId: undefined }, key: defaultKey(body) }),
        code: 'MISSING_FIELD',
      },
      {
        name: 'REFUND without reference (domain contract rule)',
        change: (body) => ({ body: { ...body, kind: 'REFUND' }, key: defaultKey(body) }),
        code: 'REFERENCE_REQUIRED',
      },
      {
        name: 'zero BET (domain contract rule)',
        change: (body) => ({ body: { ...body, money: { amount: '0.00', currency: 'BRL' } }, key: defaultKey(body) }),
        code: 'INVALID_AMOUNT',
      },
      {
        name: 'NUL byte in externalTransactionId (PostgreSQL would answer 08P01)',
        change: (body) => ({ body: { ...body, externalTransactionId: `${body.externalTransactionId}\u0000x` }, key: defaultKey(body) }),
        code: 'INVALID_FORMAT',
      },
      {
        name: 'control character in roundId',
        change: (body) => ({ body: { ...body, roundId: 'round\u0007' }, key: defaultKey(body) }),
        code: 'INVALID_FORMAT',
      },
      {
        name: 'NUL byte in gameId',
        change: (body) => ({ body: { ...body, gameId: 'game\u0000' }, key: defaultKey(body) }),
        code: 'INVALID_FORMAT',
      },
      {
        name: 'reserved providerId',
        change: (body) => ({ body: { ...body, providerId: 'internal' }, key: `internal:${body.externalTransactionId}` }),
        code: 'RESERVED_PROVIDER_ID',
      },
    ];

    for (const { name, change, code } of invalidRequests) {
      test(`400 VALIDATION_ERROR, details code ${code}: ${name}; nothing is stored`, async () => {
        const original = wager(wallet);
        const { body, key } = change(original);

        const response = await request(app.baseUrl, 'POST', '/wagering/transactions', {
          body,
          headers: key === null ? {} : { 'idempotency-key': key },
        });

        expectErrorEnvelope(response, 400, 'VALIDATION_ERROR');
        const details = response.body.details as { code: string }[];
        expect(details.map((detail) => detail.code)).toContain(code);
        expect(
          await countRows(orm, 'wager_transactions', `external_transaction_id = '${original.externalTransactionId}'`),
        ).toBe(0);
        await expectBalanceMatchesLedger(orm, app.baseUrl, wallet.id, '990.00');
      });
    }

    test('413 PAYLOAD_TOO_LARGE for a body over the parser limit, in the error envelope (not 500)', async () => {
      const response = await request(app.baseUrl, 'POST', '/wagering/transactions', {
        rawBody: JSON.stringify({ providerId: 'x'.repeat(200_000) }),
        headers: { 'idempotency-key': 'provider-a:x' },
      });

      expectErrorEnvelope(response, 413, 'PAYLOAD_TOO_LARGE');
    });

    test('422 BALANCE_LIMIT_EXCEEDED for a credit past numeric(20,2), stored and replayed', async () => {
      const own = await openWallet(app.baseUrl, '999999999999999990.00');
      const win = wager(own, { kind: 'WIN', money: { amount: '10.00', currency: 'BRL' } });

      const first = await submit(app.baseUrl, win);
      const replay = await submit(app.baseUrl, win);

      expect(first.status).toBe(422);
      expect(first.body).toMatchObject({
        status: 'REJECTED',
        failureCode: 'BALANCE_LIMIT_EXCEEDED',
        balance: { amount: '999999999999999990.00' },
      });
      expect(replay.status).toBe(422);
      expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
      const exact = await submit(app.baseUrl, wager(own, { kind: 'WIN', money: { amount: '9.99', currency: 'BRL' } }));
      expect(exact.status).toBe(201);
      await expectBalanceMatchesLedger(orm, app.baseUrl, own.id, '999999999999999999.99');
    });

    test('400 VALIDATION_ERROR for a body that is not JSON', async () => {
      const response = await request(app.baseUrl, 'POST', '/wagering/transactions', {
        rawBody: '{"providerId": ',
        headers: { 'idempotency-key': 'provider-a:x' },
      });

      expectErrorEnvelope(response, 400, 'VALIDATION_ERROR');
    });

    test('503 TRANSIENT_FAILURE with Retry-After when the wallet lock is not granted in time; nothing is stored', async () => {
      const own = await openWallet(app.baseUrl, '100.00');
      const bet = wager(own);
      const blocker = await DedicatedConnection.open();
      let response: HttpResult;
      try {
        await blocker.run('begin');
        await blocker.run(`select id from wallets where id = '${own.id}' for no key update`);

        response = await submit(app.baseUrl, bet);
      } finally {
        await blocker.run('rollback');
        await blocker.close();
      }

      expectErrorEnvelope(response, 503, 'TRANSIENT_FAILURE');
      expect(response.headers.get('retry-after')).toBe('1');
      expect(await countRows(orm, 'wager_transactions', `external_transaction_id = '${bet.externalTransactionId}'`)).toBe(0);
      // Resending with the same key is exactly what 503 tells the provider to do.
      const retry = await submit(app.baseUrl, bet);
      expect(retry.status).toBe(201);
      await expectBalanceMatchesLedger(orm, app.baseUrl, own.id, '75.00');
    }, 10_000);
  });

  describe('wallets', () => {
    test('POST /wallets: 201 with the spec body; GET /wallets/:id answers the same', async () => {
      const playerId = randomUUID();

      const created = await request(app.baseUrl, 'POST', '/wallets', {
        body: { playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } },
      });

      expect(created.status).toBe(201);
      expect(created.body).toEqual({
        id: expect.any(String),
        playerId,
        balance: { amount: '1000.00', currency: 'BRL' },
        version: 1,
      });
      const fetched = await request(app.baseUrl, 'GET', `/wallets/${String(created.body.id)}`);
      expect(fetched.status).toBe(200);
      expect(fetched.body).toEqual(created.body);
      await expectBalanceMatchesLedger(orm, app.baseUrl, String(created.body.id), '1000.00');
    });

    test('409 WALLET_ALREADY_EXISTS for the same player and currency; another currency is fine', async () => {
      const playerId = randomUUID();
      const original = await request(app.baseUrl, 'POST', '/wallets', {
        body: { playerId, initialBalance: { amount: '1.00', currency: 'BRL' } },
      });

      const duplicate = await request(app.baseUrl, 'POST', '/wallets', {
        body: { playerId, initialBalance: { amount: '5.00', currency: 'BRL' } },
      });
      const otherCurrency = await request(app.baseUrl, 'POST', '/wallets', {
        body: { playerId, initialBalance: { amount: '5.00', currency: 'USD' } },
      });

      expectErrorEnvelope(duplicate, 409, 'WALLET_ALREADY_EXISTS');
      expect(otherCurrency.status).toBe(201);
      expect(await countRows(orm, 'wallets', `player_id = '${playerId}'`)).toBe(2);
      await expectBalanceMatchesLedger(orm, app.baseUrl, String(original.body.id), '1.00');
      await expectBalanceMatchesLedger(orm, app.baseUrl, String(otherCurrency.body.id), '5.00');
    });

    test.each([
      ['playerId missing', { initialBalance: { amount: '1.00', currency: 'BRL' } }, 'MISSING_FIELD'],
      ['playerId not a UUID', { playerId: 'p1', initialBalance: { amount: '1.00', currency: 'BRL' } }, 'INVALID_FORMAT'],
      ['negative balance', { playerId: randomUUID(), initialBalance: { amount: '-1.00', currency: 'BRL' } }, 'INVALID_MONEY'],
      ['lower case currency', { playerId: randomUUID(), initialBalance: { amount: '1.00', currency: 'brl' } }, 'INVALID_MONEY'],
    ])('400 VALIDATION_ERROR: %s', async (_name, body, code) => {
      const response = await request(app.baseUrl, 'POST', '/wallets', { body });

      expectErrorEnvelope(response, 400, 'VALIDATION_ERROR');
      expect((response.body.details as { code: string }[]).map((detail) => detail.code)).toContain(code);
    });
  });

  describe('lookups', () => {
    test.each([
      ['/wallets/:id', () => `/wallets/${randomUUID()}`, 'WALLET_NOT_FOUND'],
      ['/wagering/transactions/:id', () => `/wagering/transactions/${randomUUID()}`, 'TRANSACTION_NOT_FOUND'],
      ['/providers/:p/wagering/transactions/:ext', () => `/providers/provider-a/wagering/transactions/${randomUUID()}`, 'TRANSACTION_NOT_FOUND'],
      ['an unknown route', () => '/no-such-route', 'NOT_FOUND'],
    ])('404 %s', async (_name, path, errorCode) => {
      expectErrorEnvelope(await request(app.baseUrl, 'GET', path()), 404, errorCode);
    });

    test.each([
      ['/providers/provider-a/wagering/transactions/a%00b'],
      ['/providers/provider%00a/wagering/transactions/ext-1'],
      ['/providers/provider-a/wagering/transactions/a%07b'],
    ])('400 VALIDATION_ERROR INVALID_FORMAT for a control character in a path parameter: %s', async (path) => {
      const response = await request(app.baseUrl, 'GET', path);

      expectErrorEnvelope(response, 400, 'VALIDATION_ERROR');
      expect((response.body.details as { code: string }[])[0]?.code).toBe('INVALID_FORMAT');
    });

    test.each([
      ['/wallets/not-a-uuid'],
      ['/wagering/transactions/not-a-uuid'],
    ])('400 VALIDATION_ERROR for an id that is not a UUID: %s', async (path) => {
      const response = await request(app.baseUrl, 'GET', path);

      expectErrorEnvelope(response, 400, 'VALIDATION_ERROR');
      expect((response.body.details as { code: string }[])[0]?.code).toBe('INVALID_FORMAT');
    });
  });

  describe('correlation id', () => {
    test('X-Correlation-Id is echoed in the response header and in the error body', async () => {
      const response = await request(app.baseUrl, 'GET', `/wallets/${randomUUID()}`, {
        headers: { 'x-correlation-id': 'trace-abc-123' },
      });

      expect(response.headers.get('x-correlation-id')).toBe('trace-abc-123');
      expect(response.body.correlationId).toBe('trace-abc-123');
    });

    test('generated when the client sends none, and reaches the outbox events', async () => {
      const own = await openWallet(app.baseUrl, '10.00');
      const response = await submit(app.baseUrl, wager(own, { money: { amount: '1.00', currency: 'BRL' } }), undefined, {
        'x-correlation-id': 'trace-to-outbox',
      });
      const generated = await request(app.baseUrl, 'GET', `/wallets/${randomUUID()}`);

      expect(response.status).toBe(201);
      expect(generated.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
      expect(generated.body.correlationId).toBe(generated.headers.get('x-correlation-id'));
      const [row] = await query<{ count: string }>(
        orm,
        `select count(*)::text as count from outbox_messages
          where aggregate_id = '${own.id}' and payload->>'correlationId' = 'trace-to-outbox'`,
      );
      expect(row?.count).toBe('2');
      await expectBalanceMatchesLedger(orm, app.baseUrl, own.id, '9.00');
    });
  });
});
