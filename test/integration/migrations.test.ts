import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Migration } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { buildMikroOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config.js';
import { integrationConfig } from './support/integration-config.js';
import {
  assertMigrationsAreReversible,
  MigrationNotReversibleError,
  schemaFingerprint,
} from './support/migration-reversibility.js';

describe('project migrations', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init(buildMikroOrmConfig(integrationConfig().database));
  });

  afterAll(async () => {
    await orm.close(true);
  });

  test('every migration in src/infrastructure/persistence/migrations is reversible', async () => {
    await assertMigrationsAreReversible(orm);

    expect(await orm.migrator.getPending()).toEqual([]);
  });
});

// The fixtures below exist only to prove the helper itself catches a broken down().
// They are passed in memory (migrationsList) with their own history table and are
// never written to the migrations folder.

const SELFTEST_HISTORY_TABLE = 'mikro_orm_migrations_selftest';

class SelftestCreateItems extends Migration {
  override name = 'SelftestCreateItems';

  override up(): void {
    this.addSql(`create table selftest_items (
      id uuid primary key,
      amount numeric(20, 2) not null,
      status text not null,
      constraint selftest_items_amount_non_negative check (amount >= 0))`);
    this.addSql(`create unique index selftest_items_one_open on selftest_items (status) where status = 'OPEN'`);
  }

  override down(): void {
    this.addSql('drop index selftest_items_one_open');
    this.addSql('drop table selftest_items');
  }
}

class SelftestAppendOnlyTrigger extends Migration {
  override name = 'SelftestAppendOnlyTrigger';

  override up(): void {
    this.addSql(`create function selftest_reject_change() returns trigger language plpgsql as $$
      begin raise exception 'selftest_items is append only'; end $$`);
    this.addSql(`create trigger selftest_items_append_only before update or delete on selftest_items
      for each row execute function selftest_reject_change()`);
  }

  override down(): void {
    this.addSql('drop trigger selftest_items_append_only on selftest_items');
    this.addSql('drop function selftest_reject_change()');
  }
}

/** Same as above, but down() forgets the function: a typical incomplete revert. */
class SelftestTriggerWithIncompleteDown extends SelftestAppendOnlyTrigger {
  override name = 'SelftestTriggerWithIncompleteDown';

  override down(): void {
    this.addSql('drop trigger selftest_items_append_only on selftest_items');
  }
}

type MigrationClass = new (...args: ConstructorParameters<typeof Migration>) => Migration;

async function initSelftestOrm(migrations: MigrationClass[]): Promise<MikroORM> {
  const base = buildMikroOrmConfig(integrationConfig().database);
  return MikroORM.init({
    ...base,
    migrations: { ...base.migrations, tableName: SELFTEST_HISTORY_TABLE, migrationsList: migrations, silent: true },
  });
}

describe('assertMigrationsAreReversible (self test with in-memory fixtures)', () => {
  afterAll(async () => {
    const orm = await initSelftestOrm([]);
    await orm.em.getConnection().execute(`
      drop table if exists selftest_items cascade;
      drop function if exists selftest_reject_change();
      drop table if exists ${SELFTEST_HISTORY_TABLE};`);
    await orm.close(true);
  });

  test('passes when each down() undoes its up(), including CHECK, partial index, trigger and function', async () => {
    const orm = await initSelftestOrm([SelftestCreateItems, SelftestAppendOnlyTrigger]);
    try {
      const before = await schemaFingerprint(orm);

      await assertMigrationsAreReversible(orm);

      const migrated = await schemaFingerprint(orm);
      expect(migrated.filter((item) => !before.includes(item))).toEqual(
        expect.arrayContaining([
          expect.stringContaining('selftest_items_amount_non_negative CHECK ((amount >= (0)::numeric))'),
          expect.stringContaining('WHERE (status = \'OPEN\'::text)'),
          expect.stringContaining('trigger CREATE TRIGGER selftest_items_append_only'),
          expect.stringContaining('function selftest_reject_change()'),
        ]),
      );
      await orm.migrator.down({ to: 0 });
    } finally {
      await orm.close(true);
    }
  });

  test('fails naming the migration and the object its down() left behind', async () => {
    const orm = await initSelftestOrm([SelftestCreateItems, SelftestTriggerWithIncompleteDown]);
    try {
      const error = await assertMigrationsAreReversible(orm).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(MigrationNotReversibleError);
      const notReversible = error as MigrationNotReversibleError;
      expect(notReversible.migrationName).toBe('SelftestTriggerWithIncompleteDown');
      expect(notReversible.leftOver).toEqual([expect.stringMatching(/^function selftest_reject_change\(\) md5=/)]);
      expect(notReversible.missing).toEqual([]);
    } finally {
      await orm.close(true);
    }
  });

  test('refuses to run on a database whose name does not end in _test', async () => {
    const base = buildMikroOrmConfig({ ...integrationConfig().database, dbName: 'wagering' });
    const orm = await MikroORM.init(base);
    try {
      await expect(assertMigrationsAreReversible(orm)).rejects.toThrow(/Refusing to reset migrations on "wagering"/);
    } finally {
      await orm.close(true);
    }
  });
});
