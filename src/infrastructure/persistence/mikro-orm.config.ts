import { fileURLToPath } from 'node:url';
import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, type Options } from '@mikro-orm/postgresql';
import type { DatabaseConfig } from '../config/app-config.js';
import { BlankMigrationGenerator } from './blank-migration-generator.js';

export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));

/**
 * Single source of the ORM configuration, used by the Nest app, the migration
 * script and the integration tests (each one passes its own DatabaseConfig).
 */
export function buildMikroOrmConfig(database: DatabaseConfig): Options {
  return defineConfig({
    host: database.host,
    port: database.port,
    user: database.user,
    password: database.password,
    dbName: database.dbName,

    // Entities are listed explicitly (defineEntity schemas, added from Slice 1 on).
    // No folder discovery and no metadata provider, so nothing depends on how
    // Bun emits decorator metadata.
    entities: [],
    discovery: { warnWhenNoEntities: false },

    // Every unit of work must fork the EntityManager (request context or em.fork()).
    // A shared global identity map would leak entities between concurrent requests.
    allowGlobalContext: false,

    extensions: [Migrator],
    migrations: {
      tableName: 'mikro_orm_migrations',
      path: MIGRATIONS_DIR,
      pathTs: MIGRATIONS_DIR,
      glob: '!(*.d).ts',
      // Defaults kept on purpose: each migration runs in its own transaction,
      // and a batch of migrations runs inside one master transaction.
      transactional: true,
      allOrNothing: true,
      // Migrations are written by hand and are the source of truth for the schema
      // (CHECKs, partial unique indexes, triggers). No snapshot file and no
      // schema diff, so the generator never proposes dropping hand written objects.
      snapshot: false,
      snapshotOnMigrate: false,
      generator: BlankMigrationGenerator,
      emit: 'ts',
    },
  });
}
