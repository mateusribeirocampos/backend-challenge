import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { openMigratedDatabase } from '../schema/support/schema-sql.js';
import { integrationConfig } from '../support/integration-config.js';
import { type RunningTestApp, startTestApp } from '../support/test-app.js';
import { countRows, expectBalanceMatchesLedger, request } from './support/wagering-api.js';

/**
 * Money accepts any ISO-4217 code (XAU, HRK, USN included). Which ones the platform
 * operates is configuration: here the app runs with BRL only, as in production.
 */
describe('POST /wallets with SUPPORTED_CURRENCIES=BRL', () => {
  let orm: MikroORM;
  let app: RunningTestApp;

  beforeAll(async () => {
    orm = await openMigratedDatabase();
    app = await startTestApp({ ...integrationConfig(), wallets: { supportedCurrencies: ['BRL'] } });
  });

  afterAll(async () => {
    await app.close();
    await orm.close(true);
  });

  test.each(['USD', 'XAU', 'HRK'])('%p is a valid ISO-4217 code but not operated: 422 and no wallet', async (currency) => {
    const playerId = randomUUID();

    const response = await request(app.baseUrl, 'POST', '/wallets', {
      body: { playerId, initialBalance: { amount: '10.00', currency } },
    });

    expect(response.status).toBe(422);
    expect(response.body.errorCode).toBe('CURRENCY_NOT_SUPPORTED');
    expect(typeof response.body.correlationId).toBe('string');
    expect(await countRows(orm, 'wallets', `player_id = '${playerId}'`)).toBe(0);
  });

  test('an unknown code is still a 400 contract error from Money, before the platform rule', async () => {
    const response = await request(app.baseUrl, 'POST', '/wallets', {
      body: { playerId: randomUUID(), initialBalance: { amount: '10.00', currency: 'ABC' } },
    });

    expect(response.status).toBe(400);
  });

  test('BRL is operated: 201 and the balance matches the ledger', async () => {
    const response = await request(app.baseUrl, 'POST', '/wallets', {
      body: { playerId: randomUUID(), initialBalance: { amount: '10.00', currency: 'BRL' } },
    });

    expect(response.status).toBe(201);
    await expectBalanceMatchesLedger(orm, app.baseUrl, String(response.body.id), '10.00');
  });
});
