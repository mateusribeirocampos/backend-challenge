import { afterAll, beforeAll, describe, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
  AT,
  createEmptyWallet,
  expectViolation,
  insert,
  newId,
  openMigratedDatabase,
  processed,
  type Row,
  runInOneTransaction,
  SqlState,
  transactionRow,
  update,
  type WalletRef,
} from './support/schema-sql.js';

let orm: MikroORM;
let wallet: WalletRef;

beforeAll(async () => {
  orm = await openMigratedDatabase();
  wallet = await createEmptyWallet(orm);
});

afterAll(async () => {
  await orm.close(true);
});

function insertTransaction(overrides: Row = {}): Promise<void> {
  return runInOneTransaction(orm, insert('wager_transactions', transactionRow(wallet, overrides)));
}

async function storedTransaction(overrides: Row = {}): Promise<string> {
  const row = transactionRow(wallet, overrides);
  await runInOneTransaction(orm, insert('wager_transactions', row));
  return String(row.id);
}

/** A PROCESSED BET and a reversal row pointing to it, the shape of a REFUND or ROLLBACK. */
function reversalOf(betId: string, betExternalId: string, kind: 'REFUND' | 'ROLLBACK', overrides: Row = {}): Row {
  return transactionRow(wallet, {
    kind,
    reference_external_transaction_id: betExternalId,
    reference_transaction_id: betId,
    ...processed(),
    ...overrides,
  });
}

async function processedBet(): Promise<{ id: string; externalId: string }> {
  const externalId = `bet-${newId()}`;
  const id = await storedTransaction({
    external_transaction_id: externalId,
    idempotency_key: `provider-a:${externalId}`,
    ...processed(),
  });
  return { id, externalId };
}

describe('wager_transactions: idempotency (ADR-003)', () => {
  test('the same idempotency key twice for one provider is refused (wager_transactions_provider_idempotency_key_unique)', async () => {
    const key = `key-${newId()}`;
    await insertTransaction({ idempotency_key: key });

    await expectViolation(insertTransaction({ idempotency_key: key }), {
      code: SqlState.UniqueViolation,
      constraint: 'wager_transactions_provider_idempotency_key_unique',
    });
  });

  test('the same idempotency key under another provider is another operation', async () => {
    const key = `key-${newId()}`;
    await insertTransaction({ idempotency_key: key });

    await insertTransaction({ provider_id: 'provider-b', idempotency_key: key });
  });

  test('the same provider + external id twice is refused (wager_transactions_provider_external_unique)', async () => {
    const externalId = `ext-${newId()}`;
    await insertTransaction({ external_transaction_id: externalId, idempotency_key: `k1-${externalId}` });

    await expectViolation(insertTransaction({ external_transaction_id: externalId, idempotency_key: `k2-${externalId}` }), {
      code: SqlState.UniqueViolation,
      constraint: 'wager_transactions_provider_external_unique',
    });
  });

  test('the same external id from another provider is a different transaction', async () => {
    const externalId = `ext-${newId()}`;
    await insertTransaction({ external_transaction_id: externalId, idempotency_key: `a-${externalId}` });

    await insertTransaction({ provider_id: 'provider-b', external_transaction_id: externalId, idempotency_key: `b-${externalId}` });
  });
});

describe('wager_transactions: kind, status and amount', () => {
  test.each([
    ['unknown kind', { kind: 'JACKPOT' }, 'wager_transactions_kind_valid'],
    ['unknown status', { status: 'DONE' }, 'wager_transactions_status_valid'],
    ['negative amount', { amount: '-1.00' }, 'wager_transactions_amount_non_negative'],
    ['BET of 0.00', { amount: '0.00' }, 'wager_transactions_amount_positive_when_moving'],
    ['currency not ISO-4217', { currency: 'R$' }, 'wager_transactions_currency_format'],
  ])('%s is refused (%p)', async (_label, overrides, constraint) => {
    await expectViolation(insertTransaction(overrides), { code: SqlState.CheckViolation, constraint });
  });

  test('LOSS of 0.00 is accepted (informational)', async () => {
    await insertTransaction({ kind: 'LOSS', amount: '0.00' });
  });
});

describe('wager_transactions: references', () => {
  test.each(['REFUND', 'ROLLBACK'])('%s without reference is refused (wager_transactions_reference_required)', async (kind) => {
    await expectViolation(insertTransaction({ kind }), {
      code: SqlState.CheckViolation,
      constraint: 'wager_transactions_reference_required',
    });
  });

  test('BET with a reference is refused (wager_transactions_reference_not_allowed)', async () => {
    await expectViolation(insertTransaction({ reference_external_transaction_id: 'b1' }), {
      code: SqlState.CheckViolation,
      constraint: 'wager_transactions_reference_not_allowed',
    });
  });

  test('a PROCESSED reversal must name the transaction it reverted', async () => {
    await expectViolation(insertTransaction({ kind: 'REFUND', reference_external_transaction_id: 'b1', ...processed() }), {
      code: SqlState.CheckViolation,
      constraint: 'wager_transactions_processed_reversal_has_reference',
    });
  });

  test('a reference to a transaction that does not exist is refused (wager_transactions_reference_fk)', async () => {
    await expectViolation(
      insertTransaction({ kind: 'REFUND', reference_external_transaction_id: 'b1', reference_transaction_id: newId(), ...processed() }),
      { code: SqlState.ForeignKeyViolation, constraint: 'wager_transactions_reference_fk' },
    );
  });
});

describe('wager_transactions: single reversal of any kind (ADR-008)', () => {
  test('second PROCESSED REFUND of the same BET is refused (wager_transactions_single_reversal)', async () => {
    const bet = await processedBet();
    await runInOneTransaction(orm, insert('wager_transactions', reversalOf(bet.id, bet.externalId, 'REFUND')));

    await expectViolation(
      runInOneTransaction(orm, insert('wager_transactions', reversalOf(bet.id, bet.externalId, 'REFUND'))),
      { code: SqlState.UniqueViolation, constraint: 'wager_transactions_single_reversal' },
    );
  });

  test('PROCESSED ROLLBACK after a PROCESSED REFUND of the same BET is refused too (cross kind)', async () => {
    const bet = await processedBet();
    await runInOneTransaction(orm, insert('wager_transactions', reversalOf(bet.id, bet.externalId, 'REFUND')));

    await expectViolation(
      runInOneTransaction(orm, insert('wager_transactions', reversalOf(bet.id, bet.externalId, 'ROLLBACK'))),
      { code: SqlState.UniqueViolation, constraint: 'wager_transactions_single_reversal' },
    );
  });

  test('the losing reversal can still be stored as REJECTED for audit', async () => {
    const bet = await processedBet();
    await runInOneTransaction(orm, insert('wager_transactions', reversalOf(bet.id, bet.externalId, 'REFUND')));

    await runInOneTransaction(
      orm,
      insert(
        'wager_transactions',
        reversalOf(bet.id, bet.externalId, 'ROLLBACK', {
          status: 'REJECTED',
          failure_code: 'REFERENCE_ALREADY_REVERSED',
          processed_at: null,
        }),
      ),
    );
  });

  test('promoting a second reversal to PROCESSED later is refused as well', async () => {
    const bet = await processedBet();
    await runInOneTransaction(orm, insert('wager_transactions', reversalOf(bet.id, bet.externalId, 'REFUND')));
    const pending = reversalOf(bet.id, bet.externalId, 'ROLLBACK', {
      status: 'PENDING',
      processed_at: null,
      result_balance_amount: null,
      result_balance_currency: null,
      reference_transaction_id: null,
    });
    await runInOneTransaction(orm, insert('wager_transactions', pending));

    await expectViolation(
      runInOneTransaction(
        orm,
        update('wager_transactions', String(pending.id), { reference_transaction_id: bet.id, ...processed() }),
      ),
      { code: SqlState.UniqueViolation, constraint: 'wager_transactions_single_reversal' },
    );
  });
});

describe('wager_transactions: outcome columns follow the status', () => {
  test.each([
    ['failure_code on a PROCESSED row', { ...processed(), failure_code: 'INSUFFICIENT_FUNDS' }],
    ['failure_code on a PENDING row', { failure_code: 'INSUFFICIENT_FUNDS' }],
    ['REJECTED without failure_code', { status: 'REJECTED' }],
    ['FAILED without failure_code', { status: 'FAILED' }],
  ])('%s is refused (wager_transactions_failure_code_iff_failed)', async (_label, overrides) => {
    await expectViolation(insertTransaction(overrides), {
      code: SqlState.CheckViolation,
      constraint: 'wager_transactions_failure_code_iff_failed',
    });
  });

  test('PROCESSED without the balance observed is refused (needed for replay)', async () => {
    await expectViolation(insertTransaction({ status: 'PROCESSED', processed_at: AT }), {
      code: SqlState.CheckViolation,
      constraint: 'wager_transactions_result_balance_when_processed',
    });
  });

  test('PENDING_REFERENCE without a next check is refused (the worker would never see it)', async () => {
    await expectViolation(insertTransaction({ status: 'PENDING_REFERENCE' }), {
      code: SqlState.CheckViolation,
      constraint: 'wager_transactions_pending_reference_scheduled',
    });
  });
});

describe('wager_transactions: state machine and immutability (trigger wager_transactions_guard)', () => {
  test.each([
    ['PROCESSED -> REJECTED', processed(), { status: 'REJECTED', failure_code: 'AMOUNT_MISMATCH', processed_at: null }],
    ['REJECTED -> PROCESSED', { status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' }, { ...processed(), failure_code: null }],
    ['FAILED -> PENDING', { status: 'FAILED', failure_code: 'PERMANENT_INFRASTRUCTURE_ERROR' }, { status: 'PENDING', failure_code: null }],
    ['PROCESSED, change of result balance', processed('10.00'), { result_balance_amount: '99.00' }],
  ])('terminal row cannot change: %s (wager_transactions_terminal_immutable)', async (_label, initial, change) => {
    const id = await storedTransaction(initial);

    await expectViolation(runInOneTransaction(orm, update('wager_transactions', id, change)), {
      code: SqlState.RestrictViolation,
      constraint: 'wager_transactions_terminal_immutable',
    });
  });

  test('PENDING_REFERENCE cannot go back to PENDING (wager_transactions_valid_transition)', async () => {
    const id = await storedTransaction({ status: 'PENDING_REFERENCE', next_reference_check_at: AT });

    await expectViolation(
      runInOneTransaction(orm, update('wager_transactions', id, { status: 'PENDING', next_reference_check_at: null })),
      { code: SqlState.CheckViolation, constraint: 'wager_transactions_valid_transition' },
    );
  });

  test('allowed path: PENDING -> PENDING_REFERENCE -> PROCESSED', async () => {
    const id = await storedTransaction();

    await runInOneTransaction(orm, update('wager_transactions', id, { status: 'PENDING_REFERENCE', next_reference_check_at: AT }));
    await runInOneTransaction(orm, update('wager_transactions', id, { ...processed(), next_reference_check_at: null }));
  });

  test('business fields cannot change even while PENDING (wager_transactions_business_fields_immutable)', async () => {
    const id = await storedTransaction();

    await expectViolation(runInOneTransaction(orm, update('wager_transactions', id, { amount: '250.00' })), {
      code: SqlState.RestrictViolation,
      constraint: 'wager_transactions_business_fields_immutable',
    });
  });

  test('a transaction cannot be deleted (wager_transactions_no_delete)', async () => {
    const id = await storedTransaction();

    await expectViolation(runInOneTransaction(orm, `delete from wager_transactions where id = '${id}'`), {
      code: SqlState.RestrictViolation,
      constraint: 'wager_transactions_no_delete',
    });
  });
});

describe('wager_transactions: OPENING is internal', () => {
  const opening = (overrides: Row = {}): Row => ({
    provider_id: 'internal',
    payload_hash: null,
    round_id: null,
    game_id: null,
    kind: 'OPENING',
    ...processed('25.00'),
    ...overrides,
  });

  test('OPENING from a real provider is refused', async () => {
    await expectViolation(insertTransaction(opening({ provider_id: 'provider-a' })), {
      code: SqlState.CheckViolation,
      constraint: 'wager_transactions_internal_provider_only_for_opening',
    });
  });

  test('a BET under the reserved provider "internal" is refused', async () => {
    await expectViolation(insertTransaction({ provider_id: 'internal' }), {
      code: SqlState.CheckViolation,
      constraint: 'wager_transactions_internal_provider_only_for_opening',
    });
  });

  test('OPENING with a round is refused, and a BET without one too (wager_transactions_opening_shape)', async () => {
    await expectViolation(insertTransaction(opening({ round_id: 'round-1' })), {
      code: SqlState.CheckViolation,
      constraint: 'wager_transactions_opening_shape',
    });
    await expectViolation(insertTransaction({ round_id: null }), {
      code: SqlState.CheckViolation,
      constraint: 'wager_transactions_opening_shape',
    });
  });

  test('OPENING is born PROCESSED', async () => {
    await expectViolation(
      insertTransaction(opening({ status: 'PENDING', processed_at: null, result_balance_amount: null, result_balance_currency: null })),
      { code: SqlState.CheckViolation, constraint: 'wager_transactions_opening_born_processed' },
    );
  });

  test('a second OPENING for the same wallet is refused (wager_transactions_single_opening)', async () => {
    const other = await createEmptyWallet(orm);
    const row = (externalId: string) =>
      insert(
        'wager_transactions',
        transactionRow(other, opening({ external_transaction_id: externalId, idempotency_key: `internal:${externalId}` })),
      );
    await runInOneTransaction(orm, row(`opening-${other.id}`));

    await expectViolation(runInOneTransaction(orm, row(`opening-again-${other.id}`)), {
      code: SqlState.UniqueViolation,
      constraint: 'wager_transactions_single_opening',
    });
  });
});
