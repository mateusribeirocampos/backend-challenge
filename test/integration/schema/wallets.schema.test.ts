import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
  AT,
  createEmptyWallet,
  expectViolation,
  insert,
  movementStatements,
  openMigratedDatabase,
  openWalletWithBalance,
  query,
  runInOneTransaction,
  SqlState,
  transactionRow,
  update,
  walletRow,
} from './support/schema-sql.js';

let orm: MikroORM;

beforeAll(async () => {
  orm = await openMigratedDatabase();
});

afterAll(async () => {
  await orm.close(true);
});

describe('wallets: uniqueness and non-negativity', () => {
  test('a negative balance is refused (wallets_balance_non_negative)', async () => {
    await expectViolation(runInOneTransaction(orm, insert('wallets', walletRow({ balance_amount: '-0.01' }))), {
      code: SqlState.CheckViolation,
      constraint: 'wallets_balance_non_negative',
    });
  });

  test('a second wallet for the same player and currency is refused (wallets_player_currency_unique)', async () => {
    const first = walletRow();
    await runInOneTransaction(orm, insert('wallets', first));

    await expectViolation(runInOneTransaction(orm, insert('wallets', walletRow({ player_id: first.player_id ?? null }))), {
      code: SqlState.UniqueViolation,
      constraint: 'wallets_player_currency_unique',
    });
  });

  test('the same player may have a wallet in another currency', async () => {
    const first = walletRow();
    await runInOneTransaction(orm, insert('wallets', first));

    await runInOneTransaction(orm, insert('wallets', walletRow({ player_id: first.player_id ?? null, currency: 'USD' })));
  });

  test('currency must look like ISO-4217 (wallets_currency_format)', async () => {
    await expectViolation(runInOneTransaction(orm, insert('wallets', walletRow({ currency: 'brl' }))), {
      code: SqlState.CheckViolation,
      constraint: 'wallets_currency_format',
    });
  });

  test('version 0 is refused (wallets_version_positive)', async () => {
    await expectViolation(runInOneTransaction(orm, insert('wallets', walletRow({ version: 0 }))), {
      code: SqlState.CheckViolation,
      constraint: 'wallets_version_positive',
    });
  });
});

describe('wallets: balance and version must match the ledger at COMMIT (deferred check)', () => {
  test('a wallet created with a balance but no OPENING entry is refused', async () => {
    await expectViolation(runInOneTransaction(orm, insert('wallets', walletRow({ balance_amount: '100.00' }))), {
      code: SqlState.CheckViolation,
      constraint: 'wallets_balance_matches_ledger',
    });
  });

  test('a wallet created at version 2 is refused (a new wallet is version 1)', async () => {
    await expectViolation(runInOneTransaction(orm, insert('wallets', walletRow({ version: 2 }))), {
      code: SqlState.CheckViolation,
      constraint: 'wallets_balance_matches_ledger',
    });
  });

  test('a balance change without a ledger entry is refused, with or without a version bump', async () => {
    const wallet = await openWalletWithBalance(orm, '100.00');

    for (const change of [{ balance_amount: '75.00' }, { balance_amount: '75.00', version: 2 }]) {
      await expectViolation(runInOneTransaction(orm, update('wallets', wallet.id, { ...change, updated_at: AT })), {
        code: SqlState.CheckViolation,
        constraint: 'wallets_balance_matches_ledger',
      });
    }
    const [row] = await query<{ balance_amount: string }>(orm, `select balance_amount from wallets where id = '${wallet.id}'`);
    expect(row?.balance_amount).toBe('100.00');
  });

  test('a version change without a balance change is refused', async () => {
    const wallet = await createEmptyWallet(orm);

    await expectViolation(runInOneTransaction(orm, update('wallets', wallet.id, { version: 2 })), {
      code: SqlState.CheckViolation,
      constraint: 'wallets_balance_matches_ledger',
    });
  });

  test('updated_at alone may change', async () => {
    const wallet = await createEmptyWallet(orm);

    await runInOneTransaction(orm, update('wallets', wallet.id, { updated_at: '2026-10-07T00:00:00.000Z' }));
  });

  test('the wallet UPDATE may come before the ledger INSERT: the check only runs at COMMIT', async () => {
    const wallet = await openWalletWithBalance(orm, '100.00');
    const [insertTransaction, insertEntry, updateWallet] = movementStatements(wallet, {
      direction: 'DEBIT',
      amount: '25.00',
      before: '100.00',
      after: '75.00',
      version: 2,
    }).statements;

    // INSERTs still follow the foreign keys (transaction before entry); only the
    // wallet UPDATE moves ahead of the entry.
    await runInOneTransaction(orm, insertTransaction!, updateWallet!, insertEntry!);

    const [row] = await query<{ balance_amount: unknown; version: number }>(
      orm,
      `select balance_amount, version from wallets where id = '${wallet.id}'`,
    );
    expect(row).toEqual({ balance_amount: '75.00', version: 2 });
  });

  test('money columns come back as exact strings, never as JavaScript numbers', async () => {
    const wallet = await openWalletWithBalance(orm, '0.30');

    const [row] = await query<{ balance_amount: unknown }>(orm, `select balance_amount from wallets where id = '${wallet.id}'`);

    expect(typeof row?.balance_amount).toBe('string');
    expect(row?.balance_amount).toBe('0.30');
  });
});

describe('wallets: history is protected by the foreign keys', () => {
  test('a wallet with transactions cannot be deleted (wager_transactions_wallet_fk)', async () => {
    const wallet = await createEmptyWallet(orm);
    await runInOneTransaction(orm, insert('wager_transactions', transactionRow(wallet)));

    await expectViolation(runInOneTransaction(orm, `delete from wallets where id = '${wallet.id}'`), {
      code: SqlState.ForeignKeyViolation,
      constraint: 'wager_transactions_wallet_fk',
    });
  });

  test('the currency of a wallet with ledger entries cannot change (wallet_ledger_entries_wallet_fk)', async () => {
    const wallet = await openWalletWithBalance(orm, '100.00');

    await expectViolation(runInOneTransaction(orm, update('wallets', wallet.id, { currency: 'USD' })), {
      code: SqlState.ForeignKeyViolation,
      constraint: 'wallet_ledger_entries_wallet_fk',
    });
  });
});
