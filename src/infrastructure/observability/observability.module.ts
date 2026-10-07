import { Global, Module } from '@nestjs/common';
import { METRICS } from '../../application/ports/metrics.js';
import { STRUCTURED_LOGGER } from '../../application/ports/structured-logger.js';
import { InMemoryMetrics } from './in-memory-metrics.js';
import { JsonLineLogger } from './json-line-logger.js';

/** Logger and metrics for every module. Global: they are cross-cutting, like the config. */
@Global()
@Module({
  providers: [
    { provide: STRUCTURED_LOGGER, useFactory: () => new JsonLineLogger() },
    { provide: METRICS, useFactory: () => new InMemoryMetrics() },
  ],
  exports: [STRUCTURED_LOGGER, METRICS],
})
export class ObservabilityModule {}
