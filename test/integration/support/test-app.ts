import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../../src/app.module.js';
import { METRICS } from '../../../src/application/ports/metrics.js';
import { STRUCTURED_LOGGER } from '../../../src/application/ports/structured-logger.js';
import type { AppConfig } from '../../../src/infrastructure/config/app-config.js';
import type { InMemoryMetrics } from '../../../src/infrastructure/observability/in-memory-metrics.js';
import { CapturingLogger } from './capturing-logger.js';

export interface RunningTestApp {
  readonly baseUrl: string;
  /** The app's own counters (the real InMemoryMetrics adapter). */
  readonly metrics: InMemoryMetrics;
  /** Every structured log line the app wrote, instead of printing them during the tests. */
  readonly logs: CapturingLogger;
  /** A provider of this app instance (e.g. a use case), to drive it directly from a test. */
  get<T>(token: string | symbol | (abstract new (...args: never[]) => T)): T;
  close(): Promise<void>;
}

/**
 * Boots the real Nest app (real PostgreSQL, real SQS emulator) on a random free port.
 * Only the log output is swapped, so the test can read it and the terminal stays quiet.
 */
export async function startTestApp(config: AppConfig): Promise<RunningTestApp> {
  const logs = new CapturingLogger();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(config)] })
    .overrideProvider(STRUCTURED_LOGGER)
    .useValue(logs)
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  const baseUrl = await app.getUrl();
  return {
    baseUrl,
    metrics: app.get<InMemoryMetrics>(METRICS, { strict: false }),
    logs,
    get: (token) => app.get(token, { strict: false }),
    close: () => app.close(),
  };
}
