import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
  AT,
  expectDatabaseError,
  expectViolation,
  HASH,
  insert,
  newId,
  openMigratedDatabase,
  query,
  type Row,
  runInOneTransaction,
  SqlState,
} from './support/schema-sql.js';

let orm: MikroORM;

beforeAll(async () => {
  orm = await openMigratedDatabase();
});

afterAll(async () => {
  await orm.close(true);
});

function inboxRow(overrides: Row = {}): Row {
  return { consumer_name: 'wager-transactions', message_id: `msg-${newId()}`, payload_hash: HASH, received_at: AT, ...overrides };
}

function outboxRow(overrides: Row = {}): Row {
  const id = newId();
  return {
    id,
    aggregate_id: newId(),
    event_type: 'WagerTransactionProcessed',
    payload: JSON.stringify({ eventId: id, eventType: 'WagerTransactionProcessed' }),
    occurred_at: AT,
    next_attempt_at: AT,
    ...overrides,
  };
}

describe('inbox_messages', () => {
  test('the same message for the same consumer is stored once (inbox_messages_pkey)', async () => {
    const row = inboxRow();
    await runInOneTransaction(orm, insert('inbox_messages', row));

    await expectViolation(runInOneTransaction(orm, insert('inbox_messages', row)), {
      code: SqlState.UniqueViolation,
      constraint: 'inbox_messages_pkey',
    });
  });

  test('the same message id for another consumer is a different row', async () => {
    const row = inboxRow();
    await runInOneTransaction(orm, insert('inbox_messages', row));

    await runInOneTransaction(orm, insert('inbox_messages', { ...row, consumer_name: 'another-consumer' }));
  });
});

describe('outbox_messages', () => {
  test('an event id is stored once (outbox_messages_pkey)', async () => {
    const row = outboxRow();
    await runInOneTransaction(orm, insert('outbox_messages', row));

    await expectViolation(runInOneTransaction(orm, insert('outbox_messages', row)), {
      code: SqlState.UniqueViolation,
      constraint: 'outbox_messages_pkey',
    });
  });

  test('attempts cannot be negative', async () => {
    await expectViolation(runInOneTransaction(orm, insert('outbox_messages', outboxRow({ attempts: -1 }))), {
      code: SqlState.CheckViolation,
      constraint: 'outbox_messages_attempts_non_negative',
    });
  });
});

describe('outbox_messages: publication order and lease (Slice 4)', () => {
  test('sequence_number follows the insert order, also inside one statement', async () => {
    const first = outboxRow();
    const second = outboxRow();
    await runInOneTransaction(orm, `${insert('outbox_messages', first)}, (${valuesOf(second)})`);

    const rows = await query<{ id: string; sequence_number: string }>(
      orm,
      `select id, sequence_number::text from outbox_messages where id in ('${first.id}', '${second.id}') order by sequence_number`,
    );
    expect(rows.map((row) => row.id)).toEqual([String(first.id), String(second.id)]);
  });

  test('sequence_number cannot be chosen by the writer (generated always)', async () => {
    const error = await runInOneTransaction(orm, insert('outbox_messages', outboxRow({ sequence_number: 1 }))).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expectDatabaseError(error, { code: SqlState.GeneratedAlways });
  });

  test('a lease has an owner and an expiry, or neither (outbox_messages_lease_pair)', async () => {
    await expectViolation(runInOneTransaction(orm, insert('outbox_messages', outboxRow({ lease_token: newId() }))), {
      code: SqlState.CheckViolation,
      constraint: 'outbox_messages_lease_pair',
    });
  });
});

describe('outbox_messages: a confirmed event is never lost nor rewritten', () => {
  test('the event itself (payload, type, wallet, time, order) cannot change (outbox_messages_event_immutable)', async () => {
    const row = outboxRow();
    await runInOneTransaction(orm, insert('outbox_messages', row));

    await expectViolation(
      runInOneTransaction(orm, `update outbox_messages set payload = '{"changed":true}' where id = '${row.id}'`),
      { code: SqlState.RestrictViolation, constraint: 'outbox_messages_event_immutable' },
    );
  });

  test('a published event cannot change again, not even back to unpublished (outbox_messages_published_immutable)', async () => {
    const row = outboxRow({ published_at: AT });
    await runInOneTransaction(orm, insert('outbox_messages', row));

    await expectViolation(
      runInOneTransaction(orm, `update outbox_messages set published_at = null where id = '${row.id}'`),
      { code: SqlState.RestrictViolation, constraint: 'outbox_messages_published_immutable' },
    );
  });

  test('an unpublished event cannot be deleted (outbox_messages_no_delete_unpublished)', async () => {
    const row = outboxRow();
    await runInOneTransaction(orm, insert('outbox_messages', row));

    await expectViolation(runInOneTransaction(orm, `delete from outbox_messages where id = '${row.id}'`), {
      code: SqlState.RestrictViolation,
      constraint: 'outbox_messages_no_delete_unpublished',
    });
  });

  test('allowed: lease, retry and publication of a pending event; deleting it once published', async () => {
    const row = outboxRow();
    const id = String(row.id);
    await runInOneTransaction(orm, insert('outbox_messages', row));

    await runInOneTransaction(
      orm,
      `update outbox_messages set lease_token = '${newId()}', locked_until = now() + interval '30 seconds' where id = '${id}'`,
      `update outbox_messages set attempts = 1, next_attempt_at = now(), lease_token = null, locked_until = null where id = '${id}'`,
      `update outbox_messages set published_at = now() where id = '${id}'`,
      `delete from outbox_messages where id = '${id}'`,
    );
  });
});

/** "(v1, v2, ...)" of a row, in the column order of outboxRow, for a multi-row insert. */
function valuesOf(row: Row): string {
  return insert('outbox_messages', row).split(' values (')[1]?.slice(0, -1) ?? '';
}
