import { readFileSync } from 'node:fs';
import os from 'node:os';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { AppConfig } from '../src/infrastructure/config/app-config.js';
import { LOCK_TIMEOUT } from '../src/infrastructure/persistence/mikro-orm-transaction-runner.js';
import { query } from './database.js';
import type { SendProbe } from './emulator-probe.js';
import type { Environment } from './results.js';

/** pg-pool's default size: the project does not set `pool` in the MikroORM config. */
const PG_POOL_DEFAULT_MAX = 10;
/** MaxNumberOfMessages of the consumer (src/wager-consumer.module.ts). */
const CONSUMER_MAX_MESSAGES = 10;

/** Where the numbers came from: a result without its machine and configuration is not comparable. */
export async function collectEnvironment(
  orm: MikroORM,
  app: AppConfig,
  instances: number,
  sqsSendProbe: SendProbe,
): Promise<Environment> {
  const cpus = os.cpus();
  return {
    cpuModel: cpus[0]?.model ?? 'desconhecido',
    logicalCores: cpus.length,
    memoryGiB: os.totalmem() / 1024 ** 3,
    os: osName(),
    kernel: `${os.type()} ${os.release()}`,
    bun: Bun.version,
    postgres: await postgresVersion(orm),
    postgresSettings: await postgresSettings(orm),
    sqsEmulator: await sqsEmulatorVersion(app.sqs.endpoint),
    sqsSendProbe,
    appInstances: instances,
    poolSizePerInstance: PG_POOL_DEFAULT_MAX,
    lockTimeout: LOCK_TIMEOUT,
    consumer: {
      visibilityTimeoutSeconds: app.sqs.consumer.visibilityTimeoutSeconds,
      waitTimeSeconds: app.sqs.consumer.waitTimeSeconds,
      maxMessages: CONSUMER_MAX_MESSAGES,
    },
    publisher: {
      leaseSeconds: app.outboxPublisher.leaseSeconds,
      batchSize: app.outboxPublisher.batchSize,
      pollIntervalMs: app.outboxPublisher.pollIntervalMs,
    },
  };
}

/** PRETTY_NAME, plus NAME and VERSION_ID when the vendor renamed the distribution. */
function osName(): string {
  try {
    const release = readFileSync('/etc/os-release', 'utf8');
    const field = (name: string) => new RegExp(`^${name}="?([^"\\n]*)"?$`, 'm').exec(release)?.[1];
    const pretty = field('PRETTY_NAME') ?? os.type();
    const base = [field('NAME'), field('VERSION_ID')].filter((part) => part !== undefined).join(' ');
    return base === '' || pretty.includes(base) ? pretty : `${pretty} (${base})`;
  } catch {
    return os.type();
  }
}

async function postgresVersion(orm: MikroORM): Promise<string> {
  const [row] = await query<{ server_version: string }>(orm, 'show server_version');
  return `PostgreSQL ${row?.server_version ?? 'desconhecido'}`;
}

/** The settings that change how a write-heavy load behaves. */
async function postgresSettings(orm: MikroORM): Promise<Record<string, string>> {
  const names = ['max_connections', 'shared_buffers', 'synchronous_commit', 'fsync', 'wal_level'];
  const rows = await query<{ name: string; value: string }>(
    orm,
    `select name, current_setting(name) as value from pg_settings where name in (${names.map((name) => `'${name}'`).join(', ')}) order by name`,
  );
  return Object.fromEntries(rows.map((row) => [row.name, row.value]));
}

/** MiniStack answers its version on /_ministack/health. */
async function sqsEmulatorVersion(endpoint: string | undefined): Promise<string> {
  if (endpoint === undefined) return 'AWS SQS';
  try {
    const health = (await (await fetch(`${endpoint}/_ministack/health`)).json()) as { version?: string; edition?: string };
    return `MiniStack ${health.version ?? 'desconhecido'}${health.edition === undefined ? '' : ` (${health.edition})`}`;
  } catch {
    return `emulador em ${endpoint} (versão desconhecida)`;
  }
}
