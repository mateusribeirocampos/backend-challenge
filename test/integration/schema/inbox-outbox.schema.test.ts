import { afterAll, beforeAll, describe, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
  AT,
  expectViolation,
  HASH,
  insert,
  newId,
  openMigratedDatabase,
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
