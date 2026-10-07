import { type AppConfig, loadConfig } from '../../../src/infrastructure/config/app-config.js';

/**
 * Same env as the app (.env), but always pointed at the test database, so the
 * integration suite can reset schema and data without touching development data.
 * The SQS consumer and the outbox publisher are off: a test that needs one turns it
 * on, with its own queues.
 */
export function integrationConfig(): AppConfig {
  const base = loadConfig(process.env);
  return {
    ...base,
    database: { ...base.database, dbName: process.env.TEST_DATABASE_NAME ?? 'wagering_test' },
    // The suite also exercises USD wallets (currency conflicts); production defaults to BRL only.
    wallets: { supportedCurrencies: ['BRL', 'USD'] },
    sqs: { ...base.sqs, consumer: { ...base.sqs.consumer, enabled: false } },
    outboxPublisher: { ...base.outboxPublisher, enabled: false },
  };
}
