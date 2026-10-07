import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
  createEmptyWallet,
  expectViolation,
  insert,
  ledgerRow,
  openMigratedDatabase,
  openWalletWithBalance,
  processed,
  query,
  runInOneTransaction,
  SqlState,
  transactionRow,
  update,
  walletRow,
} from './support/schema-sql.js';

/**
 * PostgreSQL numeric accepts 'NaN' and sorts it above every number, so "balance >= 0"
 * lets it through. The domain can never rehydrate such a row (Money.from refuses NaN).
 * Every monetary column refuses it explicitly.
 */
let orm: MikroORM;

beforeAll(async () => {
  orm = await openMigratedDatabase();
});

afterAll(async () => {
  await orm.close(true);
});

const nanViolation = (constraint: string) => ({ code: SqlState.CheckViolation, constraint });

describe('monetary columns refuse NaN', () => {
  test('wallets.balance_amount on insert and on update (wallets_balance_not_nan)', async () => {
    await expectViolation(
      runInOneTransaction(orm, insert('wallets', walletRow({ balance_amount: 'NaN' }))),
      nanViolation('wallets_balance_not_nan'),
    );
    const wallet = await createEmptyWallet(orm);
    await expectViolation(
      runInOneTransaction(orm, update('wallets', wallet.id, { balance_amount: 'NaN' })),
      nanViolation('wallets_balance_not_nan'),
    );
  });

  test('wager_transactions.amount (wager_transactions_amount_not_nan)', async () => {
    const wallet = await createEmptyWallet(orm);
    await expectViolation(
      runInOneTransaction(orm, insert('wager_transactions', transactionRow(wallet, { amount: 'NaN' }))),
      nanViolation('wager_transactions_amount_not_nan'),
    );
  });

  test('wager_transactions.result_balance_amount on insert and on update (wager_transactions_result_balance_not_nan)', async () => {
    const wallet = await createEmptyWallet(orm);
    await expectViolation(
      runInOneTransaction(orm, insert('wager_transactions', transactionRow(wallet, { kind: 'LOSS', amount: '0.00', ...processed('NaN') }))),
      nanViolation('wager_transactions_result_balance_not_nan'),
    );
    const pending = transactionRow(wallet);
    await runInOneTransaction(orm, insert('wager_transactions', pending));
    await expectViolation(
      runInOneTransaction(orm, update('wager_transactions', String(pending.id), processed('NaN'))),
      nanViolation('wager_transactions_result_balance_not_nan'),
    );
  });

  // Ledger rows are append-only (a trigger refuses any UPDATE), so insert is the only way in.
  test('wallet_ledger_entries.amount: the reviewed case, a CREDIT of NaN ending at NaN (wallet_ledger_entries_amount_not_nan)', async () => {
    // The older checks all hold for this row: NaN > 0, NaN >= 0 and 100 + NaN = NaN are true in
    // PostgreSQL. The new check fires before the FK to the transaction's amount (25.00) does.
    const wallet = await openWalletWithBalance(orm, '100.00');
    const win = transactionRow(wallet, { kind: 'WIN', amount: '25.00' });
    const entry = ledgerRow({
      wallet_id: wallet.id,
      transaction_id: String(win.id),
      direction: 'CREDIT',
      amount: 'NaN',
      balance_before: '100.00',
      balance_after: 'NaN',
      wallet_version: 2,
    });
    await expectViolation(
      runInOneTransaction(orm, insert('wager_transactions', win), insert('wallet_ledger_entries', entry)),
      nanViolation('wallet_ledger_entries_amount_not_nan'),
    );
  });

  // balance_before and balance_after cannot be NaN alone without first breaking the chain
  // trigger or the arithmetic check, which fire before; so the catalog proves their checks exist.
  test('every monetary column has its validated NaN check', async () => {
    const rows = await query<{ conname: string; definition: string }>(
      orm,
      `select conname, pg_get_constraintdef(oid) as definition from pg_constraint
       where conname like '%not_nan' and convalidated order by conname`,
    );
    expect(rows.map((row) => [row.conname, row.definition])).toEqual([
      ['wager_transactions_amount_not_nan', "CHECK ((amount <> 'NaN'::numeric))"],
      ['wager_transactions_result_balance_not_nan', "CHECK ((result_balance_amount <> 'NaN'::numeric))"],
      ['wallet_ledger_entries_amount_not_nan', "CHECK ((amount <> 'NaN'::numeric))"],
      ['wallet_ledger_entries_balance_after_not_nan', "CHECK ((balance_after <> 'NaN'::numeric))"],
      ['wallet_ledger_entries_balance_before_not_nan', "CHECK ((balance_before <> 'NaN'::numeric))"],
      ['wallets_balance_not_nan', "CHECK ((balance_amount <> 'NaN'::numeric))"],
    ]);
  });
});
