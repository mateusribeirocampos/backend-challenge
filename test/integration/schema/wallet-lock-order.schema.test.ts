import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { Money } from '../../../src/domain/money/money.js';
import { DedicatedConnection, settle, waitUntilBlocked } from './support/dedicated-connection.js';
import {
  AT,
  expectDatabaseError,
  insert,
  ledgerRow,
  openMigratedDatabase,
  openWalletWithBalance,
  processed,
  query,
  SqlState,
  transactionRow,
  update,
  type WalletRef,
} from './support/schema-sql.js';

/**
 * ADR-002 regression: the lock mode on the wallet row must be FOR NO KEY UPDATE.
 *
 * Slice 2 writes in this order, inside one transaction per request:
 *   1. INSERT the wager_transaction  (its FK to wallets takes FOR KEY SHARE on the wallet row)
 *   2. SELECT the wallet ... FOR <lock mode>
 *   3. UPDATE the balance, INSERT the ledger entry, UPDATE the transaction status
 *   4. COMMIT
 * Two different BETs on the same wallet both reach step 2 holding KEY SHARE.
 * FOR UPDATE conflicts with KEY SHARE, so each one waits for the other: deadlock.
 * FOR NO KEY UPDATE does not conflict with KEY SHARE, so the second simply waits for the
 * first to commit, then reads the new balance.
 */

let orm: MikroORM;

beforeAll(async () => {
  orm = await openMigratedDatabase();
});

afterAll(async () => {
  await orm.close(true);
});

const BET = '80.00';

interface LockedWallet {
  readonly balance_amount: string;
  readonly version: number;
}

/** Step 1: a PENDING BET of 80.00, inserted inside an open transaction. */
async function beginWithPendingBet(connection: DedicatedConnection, wallet: WalletRef): Promise<string> {
  const row = transactionRow(wallet, { amount: BET });
  await connection.run('begin');
  await connection.run(insert('wager_transactions', row));
  return String(row.id);
}

function lockWallet(connection: DedicatedConnection, wallet: WalletRef, mode: 'for update' | 'for no key update') {
  return connection.run<LockedWallet>(`select balance_amount, version from wallets where id = '${wallet.id}' ${mode}`);
}

/** Step 3 and 4 with the balance read under the lock: debit if it fits, otherwise reject. */
async function applyBetAndCommit(
  connection: DedicatedConnection,
  wallet: WalletRef,
  betId: string,
  locked: LockedWallet,
): Promise<void> {
  const balance = Money.from({ amount: locked.balance_amount, currency: 'BRL' });
  const bet = Money.from({ amount: BET, currency: 'BRL' });
  if (balance.isLessThan(bet)) {
    await connection.run(
      update('wager_transactions', betId, {
        status: 'REJECTED',
        failure_code: 'INSUFFICIENT_FUNDS',
        result_balance_amount: balance.amount,
        result_balance_currency: 'BRL',
        updated_at: AT,
      }),
    );
  } else {
    const after = balance.subtract(bet);
    const version = locked.version + 1;
    await connection.run(update('wallets', wallet.id, { balance_amount: after.amount, version, updated_at: AT }));
    await connection.run(
      insert(
        'wallet_ledger_entries',
        ledgerRow({
          wallet_id: wallet.id,
          transaction_id: betId,
          direction: 'DEBIT',
          amount: BET,
          balance_before: balance.amount,
          balance_after: after.amount,
          wallet_version: version,
        }),
      ),
    );
    await connection.run(update('wager_transactions', betId, { ...processed(after.amount), updated_at: AT }));
  }
  await connection.run('commit');
}

async function withTwoConnections(
  body: (first: DedicatedConnection, second: DedicatedConnection) => Promise<void>,
): Promise<void> {
  const first = await DedicatedConnection.open();
  const second = await DedicatedConnection.open();
  try {
    await body(first, second);
  } finally {
    await first.run('rollback').catch(() => undefined);
    await second.run('rollback').catch(() => undefined);
    await first.close();
    await second.close();
  }
}

describe('wallet lock order: two BETs of 80.00 on a wallet with 100.00', () => {
  test('FOR NO KEY UPDATE: both commit one after the other, no deadlock, balance equals the ledger', async () => {
    const wallet = await openWalletWithBalance(orm, '100.00');

    await withTwoConnections(async (first, second) => {
      const firstBet = await beginWithPendingBet(first, wallet);
      const secondBet = await beginWithPendingBet(second, wallet);

      // The first lock is granted at once: NO KEY UPDATE does not conflict with the
      // KEY SHARE the second transaction holds from its INSERT.
      const [firstLocked] = await lockWallet(first, wallet, 'for no key update');
      const secondLock = settle(lockWallet(second, wallet, 'for no key update'));
      await waitUntilBlocked(orm, second, first);

      await applyBetAndCommit(first, wallet, firstBet, firstLocked!);

      const secondLocked = await secondLock;
      expect(secondLocked.ok).toBe(true);
      const [row] = secondLocked.ok ? secondLocked.value : [];
      // READ COMMITTED: after waiting, the locked row is the one the first transaction committed.
      expect(row).toEqual({ balance_amount: '20.00', version: 2 });
      await applyBetAndCommit(second, wallet, secondBet, row!);

      const statuses = await query<{ id: string; status: string; failure_code: string | null }>(
        orm,
        `select id, status, failure_code from wager_transactions where id in ('${firstBet}', '${secondBet}')`,
      );
      expect(statuses).toContainEqual({ id: firstBet, status: 'PROCESSED', failure_code: null });
      expect(statuses).toContainEqual({ id: secondBet, status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
    });

    const [state] = await query<{ stored: string; version: number; rebuilt: string; debits: string }>(
      orm,
      `select w.balance_amount as stored, w.version,
              sum(case l.direction when 'CREDIT' then l.amount else -l.amount end) as rebuilt,
              count(*) filter (where l.direction = 'DEBIT')::text as debits
         from wallets w join wallet_ledger_entries l on l.wallet_id = w.id
        where w.id = '${wallet.id}'
        group by w.balance_amount, w.version`,
    );
    expect(state).toEqual({ stored: '20.00', version: 2, rebuilt: '20.00', debits: '1' });
  });

  test('FOR UPDATE (what JPA PESSIMISTIC_WRITE emits): the same order deadlocks, one side gets 40P01', async () => {
    const wallet = await openWalletWithBalance(orm, '100.00');

    await withTwoConnections(async (first, second) => {
      await beginWithPendingBet(first, wallet);
      await beginWithPendingBet(second, wallet);

      // FOR UPDATE conflicts with the KEY SHARE taken by the other INSERT: the first waits.
      const firstLock = settle(lockWallet(first, wallet, 'for update'));
      await waitUntilBlocked(orm, first, second);
      // Now the second waits for the first's KEY SHARE: a cycle, broken by the deadlock detector.
      const secondLock = settle(lockWallet(second, wallet, 'for update'));

      const results = await Promise.all([firstLock, secondLock]);
      const failures = results.filter((result) => !result.ok);
      expect(failures).toHaveLength(1);
      expectDatabaseError(failures[0]?.ok === false ? failures[0].error : undefined, {
        code: SqlState.DeadlockDetected,
      });
    });
  });
});
