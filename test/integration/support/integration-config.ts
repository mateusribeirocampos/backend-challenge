import { type AppConfig, loadConfig } from '../../../src/infrastructure/config/app-config.js';

/**
 * Same env as the app (.env), but always pointed at the test database, so the
 * integration suite can reset schema and data without touching development data.
 */
export function integrationConfig(): AppConfig {
  const base = loadConfig(process.env);
  return {
    ...base,
    database: { ...base.database, dbName: process.env.TEST_DATABASE_NAME ?? 'wagering_test' },
  };
}
