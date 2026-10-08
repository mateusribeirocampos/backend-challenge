import { Global, Module } from '@nestjs/common';
import { METRICS } from '../../application/ports/metrics.js';
import { STRUCTURED_LOGGER } from '../../application/ports/structured-logger.js';
import { InMemoryMetrics } from './in-memory-metrics.js';
import { JsonLineLogger } from './json-line-logger.js';
import { MetricsController } from './metrics.controller.js';

/** Logger and metrics for every module, plus GET /metrics. Global: they are cross-cutting, like the config. */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    { provide: STRUCTURED_LOGGER, useFactory: () => new JsonLineLogger() },
    { provide: METRICS, useFactory: () => new InMemoryMetrics() },
  ],
  exports: [STRUCTURED_LOGGER, METRICS],
})
export class ObservabilityModule {}
