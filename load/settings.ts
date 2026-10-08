import { z } from 'zod';
import type { RunSettingsView } from './results.js';

/**
 * Knobs of the load test, from LOAD_* environment variables. The defaults keep the whole
 * run at about three minutes; raise them for a longer experiment, e.g.
 *   LOAD_STEP_SECONDS=30 LOAD_CLIENTS=1,16,64,128 bun run test:load
 */
export interface LoadSettings extends RunSettingsView {
  readonly instances: number;
  readonly databaseName: string;
  readonly drainTimeoutSeconds: number;
  readonly reportPath: string;
}

const positiveInt = (fallback: number) => z.coerce.number().int().min(1).default(fallback);

const clientSteps = z
  .string()
  .transform((value) => value.split(',').map((part) => Number.parseInt(part.trim(), 10)))
  .refine((steps) => steps.length > 0 && steps.every((step) => Number.isInteger(step) && step >= 1), {
    message: 'must be a comma separated list of positive integers, like 1,8,64',
  })
  .default([1, 8, 64]);

/** A SQL identifier ending in _load: the only kind of database a load run may drop. */
const DISPOSABLE_DATABASE = /^[a-z_][a-z0-9_]*_load$/;

/**
 * Checked again right before DROP DATABASE, so no caller can skip it: the name must end
 * in _load and must not be the database the application itself is configured to use.
 */
export function assertDisposableLoadDatabase(databaseName: string, applicationDatabase: string): void {
  if (!DISPOSABLE_DATABASE.test(databaseName) || databaseName === applicationDatabase) {
    throw new Error(`refusing to drop database "${databaseName}": a load run only drops its own *_load database`);
  }
}

const schema = z.object({
  LOAD_INSTANCES: positiveInt(3),
  LOAD_WARMUP_SECONDS: positiveInt(2),
  LOAD_STEP_SECONDS: positiveInt(6),
  LOAD_CLIENTS: clientSteps,
  LOAD_HOT_WALLETS: positiveInt(1),
  LOAD_MIXED_WALLETS: positiveInt(20),
  LOAD_MIXED_SECONDS: positiveInt(15),
  LOAD_MIXED_HTTP_ROUNDS: positiveInt(40),
  LOAD_MIXED_SQS_ROUNDS: positiveInt(10),
  LOAD_DRAIN_TIMEOUT_SECONDS: positiveInt(120),
  // A database of its own, dropped and recreated on every run: wagering_test belongs to bun test.
  // The _load suffix is the promise that it holds nothing else.
  LOAD_DATABASE_NAME: z
    .string()
    .regex(DISPOSABLE_DATABASE, 'must end in _load: the load run drops this database')
    .default('wagering_load'),
  LOAD_REPORT_PATH: z.string().min(1).default('docs/teste-de-carga.md'),
});

export function loadSettings(env: Readonly<Record<string, string | undefined>>): LoadSettings {
  const nonEmpty = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value !== ''));
  const parsed = schema.parse(nonEmpty);
  return {
    instances: parsed.LOAD_INSTANCES,
    warmupSeconds: parsed.LOAD_WARMUP_SECONDS,
    stepSeconds: parsed.LOAD_STEP_SECONDS,
    clientSteps: parsed.LOAD_CLIENTS,
    hotWallets: parsed.LOAD_HOT_WALLETS,
    mixedWallets: parsed.LOAD_MIXED_WALLETS,
    mixedSeconds: parsed.LOAD_MIXED_SECONDS,
    mixedHttpRoundsPerSecond: parsed.LOAD_MIXED_HTTP_ROUNDS,
    mixedSqsRoundsPerSecond: parsed.LOAD_MIXED_SQS_ROUNDS,
    drainTimeoutSeconds: parsed.LOAD_DRAIN_TIMEOUT_SECONDS,
    databaseName: parsed.LOAD_DATABASE_NAME,
    reportPath: parsed.LOAD_REPORT_PATH,
  };
}
