/**
 * Migration CLI, run with Bun:
 *   bun scripts/migrate.ts create [name]   blank migration with up() and down()
 *   bun scripts/migrate.ts up              apply every pending migration
 *   bun scripts/migrate.ts down            revert exactly the last applied migration
 *   bun scripts/migrate.ts pending         list migrations not applied yet
 *   bun scripts/migrate.ts list            list applied migrations
 *
 * The database comes from the same env vars as the app, so the test database is
 * reached with an override: DATABASE_NAME=wagering_test bun run migration:up
 *
 * A script instead of the mikro-orm CLI: one less tool that has to understand Bun,
 * the same config builder as the app, and no "schema:update" command at hand.
 */
import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../src/infrastructure/config/app-config.js';
import { buildMikroOrmConfig } from '../src/infrastructure/persistence/mikro-orm.config.js';

const COMMANDS = ['create', 'up', 'down', 'pending', 'list'] as const;
type Command = (typeof COMMANDS)[number];

function parseCommand(value: string | undefined): Command {
  const command = COMMANDS.find((candidate) => candidate === value);
  if (command === undefined) {
    throw new Error(`Usage: bun scripts/migrate.ts <${COMMANDS.join('|')}> [name]`);
  }
  return command;
}

async function run(command: Command, name: string | undefined): Promise<void> {
  const config = loadConfig(process.env);
  const orm = await MikroORM.init(buildMikroOrmConfig(config.database));
  const migrator = orm.migrator;
  console.log(`database: ${config.database.dbName}@${config.database.host}:${config.database.port}`);

  try {
    switch (command) {
      case 'create': {
        // blank = true: never generate from a schema diff (see mikro-orm.config.ts).
        const result = await migrator.create(undefined, true, false, name);
        console.log(`created ${result.fileName}`);
        break;
      }
      case 'up': {
        const applied = await migrator.up();
        printNames('applied', applied.map((migration) => migration.name));
        break;
      }
      case 'down': {
        // Without options the migrator reverts one step, the last applied migration.
        const reverted = await migrator.down();
        printNames('reverted', reverted.map((migration) => migration.name));
        break;
      }
      case 'pending': {
        const pending = await migrator.getPending();
        printNames('pending', pending.map((migration) => migration.name));
        break;
      }
      case 'list': {
        const executed = await migrator.getExecuted();
        printNames('applied', executed.map((row) => `${row.name} (${row.executed_at.toISOString()})`));
        break;
      }
    }
  } finally {
    await orm.close(true);
  }
}

function printNames(label: string, names: readonly string[]): void {
  if (names.length === 0) {
    console.log(`${label}: none`);
    return;
  }
  console.log(`${label}:`);
  for (const name of names) console.log(`  ${name}`);
}

try {
  await run(parseCommand(process.argv[2]), process.argv[3]);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
