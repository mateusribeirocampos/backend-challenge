import type { MikroORM } from '@mikro-orm/postgresql';

/**
 * Text fingerprint of everything a migration can create in the public schema:
 * columns, constraints (CHECK, UNIQUE, FK), indexes (including partial ones),
 * triggers, functions, sequences, views and custom types. Migration bookkeeping
 * tables (mikro_orm_migrations*) are left out because they change on purpose.
 */
const SCHEMA_FINGERPRINT_SQL = `
  select 'column ' || table_name || '.' || column_name || ' ' || data_type || ' nullable=' || is_nullable
         || ' default=' || coalesce(column_default, '') as item
    from information_schema.columns
   where table_schema = 'public' and table_name not like 'mikro_orm_migrations%'
  union all
  select 'constraint ' || conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid)
    from pg_constraint
   where connamespace = 'public'::regnamespace and conrelid::regclass::text not like 'mikro_orm_migrations%'
  union all
  select 'index ' || indexdef
    from pg_indexes
   where schemaname = 'public' and tablename not like 'mikro_orm_migrations%'
  union all
  select 'trigger ' || pg_get_triggerdef(t.oid)
    from pg_trigger t join pg_class c on c.oid = t.tgrelid
   where not t.tgisinternal and c.relnamespace = 'public'::regnamespace
  union all
  select 'function ' || p.oid::regprocedure::text || ' md5=' || md5(pg_get_functiondef(p.oid))
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.prokind in ('f', 'p')
  union all
  select 'sequence ' || sequence_name
    from information_schema.sequences
   where sequence_schema = 'public' and sequence_name not like 'mikro_orm_migrations%'
  union all
  select 'view ' || table_name
    from information_schema.views
   where table_schema = 'public'
  union all
  select 'type ' || t.typname
    from pg_type t
   where t.typnamespace = 'public'::regnamespace and t.typtype in ('e', 'd')
  order by 1
`;

export async function schemaFingerprint(orm: MikroORM): Promise<string[]> {
  const rows = await orm.em.getConnection().execute<{ item: string }[]>(SCHEMA_FINGERPRINT_SQL);
  return rows.map((row) => row.item);
}

export class MigrationNotReversibleError extends Error {
  constructor(
    readonly migrationName: string,
    readonly leftOver: readonly string[],
    readonly missing: readonly string[],
  ) {
    super(
      [
        `down() of ${migrationName} does not restore the schema that existed before its up().`,
        leftOver.length > 0 ? `Still present after down():\n  ${leftOver.join('\n  ')}` : '',
        missing.length > 0 ? `Missing after down():\n  ${missing.join('\n  ')}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
    this.name = 'MigrationNotReversibleError';
  }
}

/**
 * Proves every migration is reversible, one step at a time, on a disposable database:
 *   1. revert everything, take the "empty" fingerprint;
 *   2. apply the migrations one by one, fingerprint after each up();
 *   3. revert one step at a time: after each down() the schema must equal the
 *      fingerprint taken before that migration's up();
 *   4. apply everything again: the schema must equal the fully migrated fingerprint
 *      (fails if down() left an object behind that up() tries to create again).
 * Leaves the database fully migrated.
 */
export async function assertMigrationsAreReversible(orm: MikroORM): Promise<void> {
  assertDisposableDatabase(orm);
  const migrator = orm.migrator;

  await migrator.down({ to: 0 });
  const names = (await migrator.getPending()).map((migration) => migration.name);

  const fingerprints: string[][] = [await schemaFingerprint(orm)];
  for (const name of names) {
    await migrator.up({ to: name });
    fingerprints.push(await schemaFingerprint(orm));
  }

  for (let index = names.length - 1; index >= 0; index--) {
    await migrator.down();
    const expected = fingerprints[index] ?? [];
    const actual = await schemaFingerprint(orm);
    const leftOver = actual.filter((item) => !expected.includes(item));
    const missing = expected.filter((item) => !actual.includes(item));
    if (leftOver.length > 0 || missing.length > 0) {
      throw new MigrationNotReversibleError(names[index] ?? '?', leftOver, missing);
    }
  }

  await migrator.up();
  const reapplied = await schemaFingerprint(orm);
  const fullyMigrated = fingerprints[names.length] ?? [];
  if (JSON.stringify(reapplied) !== JSON.stringify(fullyMigrated)) {
    throw new Error('Applying the migrations again after reverting them produced a different schema.');
  }
}

/** The helper drops everything; refuse to run it anywhere but a *_test database. */
function assertDisposableDatabase(orm: MikroORM): void {
  const dbName = orm.config.get('dbName') ?? '';
  if (!dbName.endsWith('_test')) {
    throw new Error(`Refusing to reset migrations on "${dbName}": only databases ending in _test are allowed.`);
  }
}
