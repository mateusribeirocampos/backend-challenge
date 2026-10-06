import { SQL } from 'bun';
import type { MikroORM } from '@mikro-orm/postgresql';
import { integrationConfig } from '../../support/integration-config.js';
import { query } from './schema-sql.js';

/**
 * One PostgreSQL session that the test drives statement by statement (BEGIN, INSERT,
 * ..., COMMIT), so two of them can interleave exactly like two application instances.
 * Bun's SQL client with max: 1 keeps every statement on the same connection.
 */
export class DedicatedConnection {
  private constructor(
    private readonly sql: SQL,
    /** Backend process id, used to ask PostgreSQL who is waiting for whom. */
    readonly pid: number,
  ) {}

  static async open(): Promise<DedicatedConnection> {
    const database = integrationConfig().database;
    const sql = new SQL({
      hostname: database.host,
      port: database.port,
      username: database.user,
      password: database.password,
      database: database.dbName,
      max: 1,
    });
    const [row] = (await sql.unsafe('select pg_backend_pid() as pid')) as { pid: number }[];
    if (row === undefined) throw new Error('could not read pg_backend_pid()');
    return new DedicatedConnection(sql, row.pid);
  }

  async run<T = Record<string, unknown>>(statement: string): Promise<T[]> {
    return (await this.sql.unsafe(statement)) as T[];
  }

  async close(): Promise<void> {
    await this.sql.close();
  }
}

/** Result of a statement that may still be running: never rejects, so it can be awaited later. */
export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

export function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

/**
 * Waits until PostgreSQL reports that `blocked` is waiting for a lock held by `blocker`
 * (pg_blocking_pids). This is the deterministic replacement for "sleep and hope":
 * the next step only runs once the wait really exists.
 */
export async function waitUntilBlocked(
  observer: MikroORM,
  blocked: DedicatedConnection,
  blocker: DedicatedConnection,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await query<{ blocked: boolean }>(
      observer,
      `select ${blocker.pid} = any(pg_blocking_pids(${blocked.pid})) as blocked`,
    );
    if (row?.blocked === true) return;
    await Bun.sleep(5);
  }
  throw new Error(`backend ${blocked.pid} never waited for backend ${blocker.pid}`);
}
