import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { openMigratedDatabase } from '../schema/support/schema-sql.js';
import { integrationConfig } from '../support/integration-config.js';
import { type RunningTestApp, startTestApp } from '../support/test-app.js';
import {
  expectBalanceMatchesLedger,
  ledgerEntries,
  type OpenedWallet,
  openWallet,
  request,
  submit,
  wager,
} from './support/wagering-api.js';

interface LedgerEntryBody {
  readonly id: string;
  readonly transactionId: string;
  readonly direction: string;
  readonly money: { amount: string; currency: string };
  readonly balanceBefore: { amount: string; currency: string };
  readonly balanceAfter: { amount: string; currency: string };
  readonly walletVersion: number;
  readonly createdAt: string;
}

interface LedgerPageBody {
  readonly walletId: string;
  readonly entries: LedgerEntryBody[];
  readonly nextCursor: string | null;
}

/** Spec 9: GET /wallets/:walletId/ledger?cursor=...&limit=50, a stable and opaque cursor. */
describe('GET /wallets/:walletId/ledger', () => {
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

  async function bet(wallet: OpenedWallet, amount: string): Promise<void> {
    expect((await submit(app.baseUrl, wager(wallet, { money: { amount, currency: 'BRL' } }))).status).toBe(201);
  }

  async function page(walletId: string, query: string): Promise<LedgerPageBody> {
    const response = await request<LedgerPageBody>(app.baseUrl, 'GET', `/wallets/${walletId}/ledger${query}`);
    expect(response.status).toBe(200);
    return response.body;
  }

  test('pages of 2 concatenate to the whole ledger, oldest first, with entries appended between pages', async () => {
    const wallet = await openWallet(app.baseUrl, '100.00');
    for (const amount of ['5.00', '5.00', '5.00', '5.00']) await bet(wallet, amount); // versions 1 to 5

    const first = await page(wallet.id, '?limit=2');
    expect(first.walletId).toBe(wallet.id);
    expect(first.entries.map((entry) => entry.walletVersion)).toEqual([1, 2]);
    expect(first.entries[0]).toEqual({
      id: expect.any(String),
      transactionId: expect.any(String),
      direction: 'CREDIT',
      money: { amount: '100.00', currency: 'BRL' },
      balanceBefore: { amount: '0.00', currency: 'BRL' },
      balanceAfter: { amount: '100.00', currency: 'BRL' },
      walletVersion: 1,
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
    });
    expect(first.nextCursor).toEqual(expect.any(String));

    // Two more entries while the client is paging (versions 6 and 7).
    await bet(wallet, '10.00');
    await bet(wallet, '10.00');

    const pages = [first];
    let cursor = first.nextCursor;
    while (cursor !== null) {
      const next = await page(wallet.id, `?limit=2&cursor=${cursor}`);
      pages.push(next);
      cursor = next.nextCursor;
    }

    const concatenated = pages.flatMap((each) => each.entries);
    expect(pages.map((each) => each.entries.length)).toEqual([2, 2, 2, 1]);
    // No gap, no duplicate: exactly the ledger in the database, in the same order.
    expect(concatenated.map((entry) => entry.walletVersion)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(concatenated.map((entry) => entry.transactionId)).toEqual(
      (await ledgerEntries(orm, wallet.id)).map((entry) => entry.transaction_id),
    );
    expect(concatenated.at(-1)?.balanceAfter).toEqual({ amount: '60.00', currency: 'BRL' });
    await expectBalanceMatchesLedger(orm, app.baseUrl, wallet.id, '60.00');
  });

  test('the same cursor asked twice returns the same page (stable)', async () => {
    const wallet = await openWallet(app.baseUrl, '50.00');
    await bet(wallet, '1.00');
    await bet(wallet, '2.00');
    const first = await page(wallet.id, '?limit=1');

    const again = await page(wallet.id, `?limit=1&cursor=${first.nextCursor}`);
    const once = await page(wallet.id, `?limit=1&cursor=${first.nextCursor}`);

    expect(again).toEqual(once);
    expect(again.entries.map((entry) => entry.walletVersion)).toEqual([2]);
    await expectBalanceMatchesLedger(orm, app.baseUrl, wallet.id, '47.00');
  });

  test('without parameters: the first page with the default size, and no next cursor when it is all', async () => {
    const wallet = await openWallet(app.baseUrl, '10.00');

    const only = await page(wallet.id, '');

    expect(only.entries).toHaveLength(1);
    expect(only.nextCursor).toBeNull();
  });

  test('a wallet opened at 0.00 has an empty ledger', async () => {
    const wallet = await openWallet(app.baseUrl, '0.00');

    expect(await page(wallet.id, '')).toEqual({ walletId: wallet.id, entries: [], nextCursor: null });
  });

  test.each([
    ['?cursor=not-a-cursor', 'cursor'],
    ['?cursor=Nw', 'cursor'], // base64url of "7": a version, but not a cursor of this API
    ['?limit=0', 'limit'],
    ['?limit=101', 'limit'],
    ['?limit=ten', 'limit'],
  ])('%s is a 400 that names the %s parameter', async (query, field) => {
    const wallet = await openWallet(app.baseUrl, '10.00');

    const response = await request(app.baseUrl, 'GET', `/wallets/${wallet.id}/ledger${query}`);

    expect(response.status).toBe(400);
    expect(response.body).toEqual(
      expect.objectContaining({ errorCode: 'VALIDATION_ERROR', details: [expect.objectContaining({ field })] }),
    );
  });

  test('an unknown wallet is a 404; a walletId that is not a UUID is a 400', async () => {
    const unknown = await request(app.baseUrl, 'GET', `/wallets/${randomUUID()}/ledger`);
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual(expect.objectContaining({ errorCode: 'WALLET_NOT_FOUND' }));

    expect((await request(app.baseUrl, 'GET', '/wallets/not-a-uuid/ledger')).status).toBe(400);
  });
});
