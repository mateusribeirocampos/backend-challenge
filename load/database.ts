import type { MikroORM } from '@mikro-orm/postgresql';

/**
 * Direct reads of the load database. The ids put into SQL here come from the API
 * (UUIDs) and are checked first; nothing typed by a user reaches these statements.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function query<T>(orm: MikroORM, sql: string): Promise<T[]> {
  return orm.em.getConnection().execute<T[]>(sql);
}

/** `('id1', 'id2')` for an IN clause, refusing anything that is not a UUID. */
export function uuidList(ids: readonly string[]): string {
  for (const id of ids) {
    if (!UUID.test(id)) throw new Error(`not a UUID: ${id}`);
  }
  return `(${ids.map((id) => `'${id}'`).join(', ')})`;
}

export async function totalEvents(orm: MikroORM): Promise<number> {
  const [row] = await query<{ count: number }>(orm, 'select count(*)::int as count from outbox_messages');
  return row?.count ?? 0;
}

export async function unpublishedEvents(orm: MikroORM): Promise<number> {
  const [row] = await query<{ count: number }>(orm, 'select count(*)::int as count from outbox_messages where published_at is null');
  return row?.count ?? 0;
}

/**
 * published_at - occurred_at, in ms, of every event written between the two instants.
 * occurred_at comes from the app clock and published_at from the publisher: on one
 * machine both read the same clock.
 */
export async function eventLagsMs(orm: MikroORM, fromMs: number, toMs: number): Promise<number[]> {
  const rows = await query<{ lag_ms: number }>(
    orm,
    `select (extract(epoch from (published_at - occurred_at)) * 1000)::float8 as lag_ms
       from outbox_messages
      where occurred_at >= to_timestamp(${fromMs / 1000}) and occurred_at < to_timestamp(${toMs / 1000})
        and published_at is not null`,
  );
  return rows.map((row) => row.lag_ms);
}

export async function eventsWritten(orm: MikroORM, fromMs: number, toMs: number): Promise<number> {
  const [row] = await query<{ count: number }>(
    orm,
    `select count(*)::int as count from outbox_messages
      where occurred_at >= to_timestamp(${fromMs / 1000}) and occurred_at < to_timestamp(${toMs / 1000})`,
  );
  return row?.count ?? 0;
}

/** When each SQS message of this run was processed (inbox), by the envelope messageId. */
export async function inboxProcessedAtMs(orm: MikroORM, messageIdPrefix: string): Promise<Map<string, number>> {
  const rows = await query<{ message_id: string; processed_ms: number }>(
    orm,
    `select message_id, (extract(epoch from processed_at) * 1000)::float8 as processed_ms
       from inbox_messages
      where message_id like '${messageIdPrefix.replaceAll("'", "''")}%' and processed_at is not null`,
  );
  return new Map(rows.map((row) => [row.message_id, row.processed_ms]));
}

/** Polls until the condition holds; returns false when the time is up (the caller reports it). */
export async function pollUntil(condition: () => Promise<boolean>, timeoutMs: number, intervalMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await Bun.sleep(intervalMs);
  }
  return false;
}

export async function inboxProcessedCount(orm: MikroORM, messageIdPrefix: string): Promise<number> {
  const [row] = await query<{ count: number }>(
    orm,
    `select count(*)::int as count from inbox_messages
      where message_id like '${messageIdPrefix.replaceAll("'", "''")}%' and processed_at is not null`,
  );
  return row?.count ?? 0;
}

/** Transactions whose externalTransactionId starts with the prefix, by status. */
export async function statusesByExternalPrefix(orm: MikroORM, prefix: string): Promise<Record<string, number>> {
  const rows = await query<{ status: string; count: number }>(
    orm,
    `select status, count(*)::int as count from wager_transactions
      where external_transaction_id like '${prefix.replaceAll("'", "''")}%' group by status`,
  );
  return Object.fromEntries(rows.map((row) => [row.status, row.count]));
}

export async function eventsPublished(orm: MikroORM, fromMs: number, toMs: number): Promise<number> {
  const [row] = await query<{ count: number }>(
    orm,
    `select count(*)::int as count from outbox_messages
      where published_at >= to_timestamp(${fromMs / 1000}) and published_at < to_timestamp(${toMs / 1000})`,
  );
  return row?.count ?? 0;
}
