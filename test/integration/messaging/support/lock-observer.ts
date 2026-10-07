import type { MikroORM } from '@mikro-orm/postgresql';
import type { DedicatedConnection } from '../../schema/support/dedicated-connection.js';
import { query } from '../../schema/support/schema-sql.js';

/**
 * Reads PostgreSQL's own view of who waits for whom (pg_blocking_pids), so a test can
 * move on exactly when a wait exists instead of sleeping and hoping.
 */

/** True while some backend waits for a lock held by `holder`. */
export async function someoneWaitsFor(orm: MikroORM, holder: DedicatedConnection): Promise<boolean> {
  const [row] = await query<{ waiting: boolean }>(
    orm,
    `select exists (select 1 from pg_stat_activity where ${holder.pid} = any(pg_blocking_pids(pid))) as waiting`,
  );
  return row?.waiting === true;
}

/** True while a backend A waits for `holder` AND another backend B waits for A. */
export async function chainOfTwoWaitsFor(orm: MikroORM, holder: DedicatedConnection): Promise<boolean> {
  const [row] = await query<{ chained: boolean }>(
    orm,
    `select exists (
       select 1
         from pg_stat_activity first, pg_stat_activity second
        where ${holder.pid} = any(pg_blocking_pids(first.pid))
          and first.pid = any(pg_blocking_pids(second.pid))
     ) as chained`,
  );
  return row?.chained === true;
}
