import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { DedicatedConnection, settle, waitUntilBlocked } from './support/dedicated-connection.js';
import {
  createEmptyWallet,
  expectDatabaseError,
  expectViolation,
  insert,
  ledgerRow,
  movementStatements,
  openMigratedDatabase,
  openWalletWithBalance,
  processed,
  query,
  type Row,
  runInOneTransaction,
  SqlState,
  transactionRow,
  update,
  type WalletRef,
} from './support/schema-sql.js';

let orm: MikroORM;

beforeAll(async () => {
  orm = await openMigratedDatabase();
});

afterAll(async () => {
  await orm.close(true);
});

/** Wallet opened with 100.00: OPENING entry 0.00 -> 100.00 at version 1. */
async function walletWith100(): Promise<WalletRef & { openingId: string }> {
  return openWalletWithBalance(orm, '100.00');
}

/** A PROCESSED BET of 25.00 on the wallet, with no entry yet. */
async function storedBet(wallet: WalletRef, overrides: Row = {}): Promise<string> {
  const row = transactionRow(wallet, { amount: '25.00', ...processed('75.00'), ...overrides });
  await runInOneTransaction(orm, insert('wager_transactions', row));
  return String(row.id);
}

function debitEntry(wallet: WalletRef, transactionId: string, overrides: Row = {}): Row {
  return ledgerRow({
    wallet_id: wallet.id,
    transaction_id: transactionId,
    direction: 'DEBIT',
    amount: '25.00',
    balance_before: '100.00',
    balance_after: '75.00',
    wallet_version: 2,
    ...overrides,
  });
}

describe('wallet_ledger_entries: append-only', () => {
  test('UPDATE is refused (wallet_ledger_entries_append_only)', async () => {
    const wallet = await walletWith100();

    await expectViolation(
      runInOneTransaction(orm, `update wallet_ledger_entries set amount = 1000.00 where wallet_id = '${wallet.id}'`),
      { code: SqlState.RestrictViolation, constraint: 'wallet_ledger_entries_append_only' },
    );
  });

  test('DELETE is refused (wallet_ledger_entries_append_only)', async () => {
    const wallet = await walletWith100();

    await expectViolation(runInOneTransaction(orm, `delete from wallet_ledger_entries where wallet_id = '${wallet.id}'`), {
      code: SqlState.RestrictViolation,
      constraint: 'wallet_ledger_entries_append_only',
    });
  });

  test('TRUNCATE is refused (wallet_ledger_entries_append_only)', async () => {
    await expectViolation(runInOneTransaction(orm, 'truncate wallet_ledger_entries cascade'), {
      code: SqlState.RestrictViolation,
      constraint: 'wallet_ledger_entries_append_only',
    });
  });
});

describe('wallet_ledger_entries: arithmetic and sign', () => {
  test('balance_before - amount must equal balance_after (wallet_ledger_entries_arithmetic)', async () => {
    const wallet = await walletWith100();
    const betId = await storedBet(wallet);

    await expectViolation(
      runInOneTransaction(orm, insert('wallet_ledger_entries', debitEntry(wallet, betId, { balance_after: '80.00' }))),
      { code: SqlState.CheckViolation, constraint: 'wallet_ledger_entries_arithmetic' },
    );
  });

  test('a DEBIT written as CREDIT does not add up either', async () => {
    const wallet = await walletWith100();
    const betId = await storedBet(wallet);

    await expectViolation(
      runInOneTransaction(orm, insert('wallet_ledger_entries', debitEntry(wallet, betId, { direction: 'CREDIT' }))),
      { code: SqlState.CheckViolation, constraint: 'wallet_ledger_entries_arithmetic' },
    );
  });

  test('amount must be positive (wallet_ledger_entries_amount_positive)', async () => {
    const wallet = await walletWith100();
    const lossId = await storedBet(wallet, { kind: 'LOSS', amount: '0.00' });

    await expectViolation(
      runInOneTransaction(
        orm,
        insert('wallet_ledger_entries', debitEntry(wallet, lossId, { amount: '0.00', balance_after: '100.00' })),
      ),
      { code: SqlState.CheckViolation, constraint: 'wallet_ledger_entries_amount_positive' },
    );
  });

  test('balance_after can never be negative (wallet_ledger_entries_balance_after_non_negative)', async () => {
    const wallet = await walletWith100();
    const betId = await storedBet(wallet, { amount: '150.00' });

    await expectViolation(
      runInOneTransaction(
        orm,
        insert('wallet_ledger_entries', debitEntry(wallet, betId, { amount: '150.00', balance_after: '-50.00' })),
      ),
      { code: SqlState.CheckViolation, constraint: 'wallet_ledger_entries_balance_after_non_negative' },
    );
  });
});

describe('wallet_ledger_entries: links to wallet and transaction', () => {
  test('a second entry of the same transaction for the same wallet is refused', async () => {
    const wallet = await walletWith100();
    const { transactionId, statements } = movementStatements(wallet, {
      direction: 'DEBIT',
      amount: '25.00',
      before: '100.00',
      after: '75.00',
      version: 2,
    });
    await runInOneTransaction(orm, ...statements);

    await expectViolation(
      runInOneTransaction(
        orm,
        insert('wallet_ledger_entries', debitEntry(wallet, transactionId, { balance_before: '75.00', balance_after: '50.00', wallet_version: 3 })),
        update('wallets', wallet.id, { balance_amount: '50.00', version: 3 }),
      ),
      { code: SqlState.UniqueViolation, constraint: 'wallet_ledger_entries_one_per_transaction_and_wallet' },
    );
  });

  test('entry amount must equal the transaction amount (wallet_ledger_entries_transaction_fk)', async () => {
    const wallet = await walletWith100();
    const betId = await storedBet(wallet, { amount: '25.00' });

    await expectViolation(
      runInOneTransaction(
        orm,
        insert('wallet_ledger_entries', debitEntry(wallet, betId, { amount: '30.00', balance_after: '70.00' })),
      ),
      { code: SqlState.ForeignKeyViolation, constraint: 'wallet_ledger_entries_transaction_fk' },
    );
  });

  test('entry currency must be the wallet currency (wallet_ledger_entries_wallet_fk)', async () => {
    const wallet = await walletWith100();
    const betId = await storedBet(wallet, { currency: 'USD' });

    await expectViolation(
      runInOneTransaction(orm, insert('wallet_ledger_entries', debitEntry(wallet, betId, { currency: 'USD' }))),
      { code: SqlState.ForeignKeyViolation, constraint: 'wallet_ledger_entries_wallet_fk' },
    );
  });
});

describe('wallet_ledger_entries: a continuous chain per wallet (trigger wallet_ledger_entries_chain)', () => {
  test('an entry that skips a version is refused, even with the right balance', async () => {
    const wallet = await walletWith100();
    const betId = await storedBet(wallet);

    await expectViolation(
      runInOneTransaction(orm, insert('wallet_ledger_entries', debitEntry(wallet, betId, { wallet_version: 3 }))),
      { code: SqlState.CheckViolation, constraint: 'wallet_ledger_entries_chain' },
    );
  });

  test('the first entry of a wallet opened at 0.00 must be version 2, not 1', async () => {
    const wallet = await createEmptyWallet(orm);
    const winId = await storedBet(wallet, { kind: 'WIN', amount: '10.00', ...processed('10.00') });
    const firstEntry = (version: number) =>
      insert(
        'wallet_ledger_entries',
        ledgerRow({
          wallet_id: wallet.id,
          transaction_id: winId,
          direction: 'CREDIT',
          amount: '10.00',
          balance_before: '0.00',
          balance_after: '10.00',
          wallet_version: version,
        }),
      );

    await expectViolation(
      runInOneTransaction(orm, firstEntry(1), update('wallets', wallet.id, { balance_amount: '10.00', version: 1 })),
      { code: SqlState.CheckViolation, constraint: 'wallet_ledger_entries_chain' },
    );
    await runInOneTransaction(orm, firstEntry(2), update('wallets', wallet.id, { balance_amount: '10.00', version: 2 }));
  });

  test('the OPENING entry must be version 1', async () => {
    const wallet = await createEmptyWallet(orm);
    const openingId = await storedBet(wallet, {
      provider_id: 'internal',
      payload_hash: null,
      round_id: null,
      game_id: null,
      kind: 'OPENING',
      amount: '50.00',
      ...processed('50.00'),
    });

    await expectViolation(
      runInOneTransaction(
        orm,
        insert(
          'wallet_ledger_entries',
          ledgerRow({
            wallet_id: wallet.id,
            transaction_id: openingId,
            direction: 'CREDIT',
            amount: '50.00',
            balance_before: '0.00',
            balance_after: '50.00',
            wallet_version: 2,
          }),
        ),
      ),
      { code: SqlState.CheckViolation, constraint: 'wallet_ledger_entries_chain' },
    );
  });

  test('an entry written without updating the wallet is refused at COMMIT (wallets_balance_matches_ledger)', async () => {
    const wallet = await walletWith100();
    const betId = await storedBet(wallet);

    await expectViolation(runInOneTransaction(orm, insert('wallet_ledger_entries', debitEntry(wallet, betId))), {
      code: SqlState.CheckViolation,
      constraint: 'wallets_balance_matches_ledger',
    });
  });

  test('after a valid history, the balance rebuilt from the ledger equals the stored balance', async () => {
    const wallet = await walletWith100();
    await runInOneTransaction(
      orm,
      ...movementStatements(wallet, { direction: 'DEBIT', amount: '25.00', before: '100.00', after: '75.00', version: 2 })
        .statements,
    );
    await runInOneTransaction(
      orm,
      ...movementStatements(wallet, { direction: 'CREDIT', amount: '60.10', before: '75.00', after: '135.10', version: 3 })
        .statements,
    );

    const [row] = await query<{ stored: string; rebuilt: string; last_after: string; versions: string }>(
      orm,
      `select w.balance_amount as stored,
              sum(case l.direction when 'CREDIT' then l.amount else -l.amount end) as rebuilt,
              (array_agg(l.balance_after order by l.wallet_version desc))[1] as last_after,
              string_agg(l.wallet_version::text, ',' order by l.wallet_version) as versions
         from wallets w join wallet_ledger_entries l on l.wallet_id = w.id
        where w.id = '${wallet.id}'
        group by w.balance_amount`,
    );
    expect(row).toEqual({ stored: '135.10', rebuilt: '135.10', last_after: '135.10', versions: '1,2,3' });
  });
});

describe('wallet_ledger_entries: lost update guards (two writers computing from balance 100.00 at version 1)', () => {
  /** Two PROCESSED BETs of 80.00 and the entry each writer would compute: 100.00 -> 20.00 at version 2. */
  async function twoStaleWriters() {
    const wallet = await walletWith100();
    const firstBet = await storedBet(wallet, { amount: '80.00', ...processed('20.00') });
    const secondBet = await storedBet(wallet, { amount: '80.00', ...processed('20.00') });
    const entryFor = (betId: string) =>
      insert('wallet_ledger_entries', debitEntry(wallet, betId, { amount: '80.00', balance_after: '20.00' }));
    const walletUpdate = update('wallets', wallet.id, { balance_amount: '20.00', version: 2 });
    return { wallet, entryFor, walletUpdate, firstBet, secondBet };
  }

  async function debitCount(walletId: string): Promise<string | undefined> {
    const [row] = await query<{ count: string }>(
      orm,
      `select count(*)::text as count from wallet_ledger_entries where wallet_id = '${walletId}' and direction = 'DEBIT'`,
    );
    return row?.count;
  }

  test('concurrent: the second INSERT waits on the unique index and fails with 23505 when the first commits', async () => {
    const { wallet, entryFor, walletUpdate, firstBet, secondBet } = await twoStaleWriters();
    const first = await DedicatedConnection.open();
    const second = await DedicatedConnection.open();
    try {
      await first.run('begin');
      await first.run(entryFor(firstBet));
      await second.run('begin');
      // Starts now, but cannot finish: the first entry (same wallet_version) is not committed yet.
      const secondInsert = settle(second.run(entryFor(secondBet)));
      await waitUntilBlocked(orm, second, first);

      await first.run(walletUpdate);
      await first.run('commit');

      const result = await secondInsert;
      expectDatabaseError(result.ok ? undefined : result.error, {
        code: SqlState.UniqueViolation,
        constraint: 'wallet_ledger_entries_wallet_version_unique',
      });
      await second.run('rollback');
      expect(await debitCount(wallet.id)).toBe('1');
    } finally {
      await first.close();
      await second.close();
    }
  });

  test('sequential: after the first commit, the stale entry is refused by the chain with 23514', async () => {
    const { wallet, entryFor, walletUpdate, firstBet, secondBet } = await twoStaleWriters();
    await runInOneTransaction(orm, entryFor(firstBet), walletUpdate);

    await expectViolation(runInOneTransaction(orm, entryFor(secondBet), walletUpdate), {
      code: SqlState.CheckViolation,
      constraint: 'wallet_ledger_entries_chain',
    });
    expect(await debitCount(wallet.id)).toBe('1');
  });
});
