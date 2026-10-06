import { randomUUID } from 'node:crypto';
import { expect } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { query } from '../../schema/support/schema-sql.js';

/**
 * Helpers for the HTTP tests of Slice 2: real requests to the real Nest app, and
 * direct reads of wagering_test to check what was (or was not) written.
 */

export interface HttpResult<T = Record<string, unknown>> {
  readonly status: number;
  readonly headers: Headers;
  readonly body: T;
}

export async function request<T = Record<string, unknown>>(
  baseUrl: string,
  method: 'GET' | 'POST',
  path: string,
  options: { body?: unknown; rawBody?: string; headers?: Record<string, string> } = {},
): Promise<HttpResult<T>> {
  const hasBody = options.body !== undefined || options.rawBody !== undefined;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(hasBody ? { 'content-type': 'application/json' } : {}), ...options.headers },
    ...(hasBody ? { body: options.rawBody ?? JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: (text === '' ? {} : JSON.parse(text)) as T };
}

export interface OpenedWallet {
  readonly id: string;
  readonly playerId: string;
}

export async function openWallet(baseUrl: string, amount: string, currency = 'BRL'): Promise<OpenedWallet> {
  const playerId = randomUUID();
  const response = await request(baseUrl, 'POST', '/wallets', {
    body: { playerId, initialBalance: { amount, currency } },
  });
  expect(response.status).toBe(201);
  return { id: String(response.body.id), playerId };
}

export interface WagerBody {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string | null;
}

/** A valid BET body for the wallet; override any field. */
export function wager(wallet: OpenedWallet, overrides: Partial<WagerBody> = {}): WagerBody {
  return {
    providerId: 'provider-a',
    externalTransactionId: `ext-${randomUUID()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: `round-${randomUUID()}`,
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

/** Default key of spec 9: "{providerId}:{externalTransactionId}". */
export function defaultKey(body: WagerBody): string {
  return `${body.providerId}:${body.externalTransactionId}`;
}

export function submit(
  baseUrl: string,
  body: WagerBody,
  idempotencyKey: string | null = defaultKey(body),
  headers: Record<string, string> = {},
): Promise<HttpResult> {
  return request(baseUrl, 'POST', '/wagering/transactions', {
    body,
    headers: { ...(idempotencyKey === null ? {} : { 'idempotency-key': idempotencyKey }), ...headers },
  });
}

// ---- database reads ----

export interface WalletRowState {
  readonly balance: string;
  readonly version: number;
}

export async function walletState(orm: MikroORM, walletId: string): Promise<WalletRowState> {
  const [row] = await query<{ balance: string; version: number }>(
    orm,
    `select balance_amount::text as balance, version from wallets where id = '${walletId}'`,
  );
  if (row === undefined) throw new Error(`wallet ${walletId} not found`);
  return row;
}

export async function ledgerEntries(
  orm: MikroORM,
  walletId: string,
): Promise<{ direction: string; amount: string; transaction_id: string; wallet_version: number }[]> {
  return query(
    orm,
    `select direction, amount::text as amount, transaction_id, wallet_version
       from wallet_ledger_entries where wallet_id = '${walletId}' order by wallet_version`,
  );
}

export async function outboxEvents(
  orm: MikroORM,
  walletId: string,
): Promise<{ event_type: string; payload: Record<string, unknown> }[]> {
  return query(
    orm,
    `select event_type, payload from outbox_messages where aggregate_id = '${walletId}' order by occurred_at, event_type`,
  );
}

export async function countRows(orm: MikroORM, table: string, where: string): Promise<number> {
  const [row] = await query<{ count: string }>(orm, `select count(*)::text as count from ${table} where ${where}`);
  return Number.parseInt(row?.count ?? '0', 10);
}

/**
 * The final invariant of spec 13, checked at the end of every test:
 * wallet.balance == balance rebuilt from the ledger (sum of credits minus debits),
 * and the API answers the same balance as the table.
 */
export async function expectBalanceMatchesLedger(
  orm: MikroORM,
  baseUrl: string,
  walletId: string,
  expectedBalance: string,
): Promise<void> {
  const [row] = await query<{ stored: string; rebuilt: string }>(
    orm,
    `select w.balance_amount::text as stored,
            coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)::numeric(20, 2)::text as rebuilt
       from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
      where w.id = '${walletId}'
      group by w.balance_amount`,
  );
  expect(row).toEqual({ stored: expectedBalance, rebuilt: expectedBalance });

  const api = await request(baseUrl, 'GET', `/wallets/${walletId}`);
  expect(api.status).toBe(200);
  expect((api.body.balance as { amount: string }).amount).toBe(expectedBalance);
}
