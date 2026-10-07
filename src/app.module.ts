import { type DynamicModule, type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { DEPENDENCY_CHECKS, type DependencyCheck } from './application/health/check-readiness.js';
import type { AppConfig } from './infrastructure/config/app-config.js';
import { BackgroundWorkersModule } from './background-workers.module.js';
import { AppConfigModule } from './infrastructure/config/app-config.module.js';
import { MessagingModule } from './infrastructure/messaging/messaging.module.js';
import { SqsQueueCheck } from './infrastructure/messaging/sqs-queue-check.js';
import { ObservabilityModule } from './infrastructure/observability/observability.module.js';
import { DatabaseCheck } from './infrastructure/persistence/database-check.js';
import { PersistenceModule } from './infrastructure/persistence/persistence.module.js';
import { ApiExceptionFilter } from './interfaces/http/api-exception.filter.js';
import { CorrelationIdMiddleware } from './interfaces/http/correlation-id.middleware.js';
import { HealthController } from './interfaces/http/health.controller.js';
import { WagerConsumerModule } from './wager-consumer.module.js';
import { WageringModule } from './wagering.module.js';

/**
 * The config is loaded and validated before Nest starts (main.ts) and passed in here.
 * Tests build the module with their own config (test database, wrong queue, ...).
 */
@Module({})
export class AppModule implements NestModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        AppConfigModule.register(config),
        ObservabilityModule,
        PersistenceModule.register(config.database),
        MessagingModule.register(config.sqs),
        WageringModule,
        WagerConsumerModule.register(config.sqs),
        BackgroundWorkersModule.register(config),
      ],
      controllers: [HealthController],
      providers: [
        // One error envelope for every endpoint (ADR-007).
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
        {
          provide: DEPENDENCY_CHECKS,
          useFactory: (database: DatabaseCheck, sqs: SqsQueueCheck): DependencyCheck[] => [database, sqs],
          inject: [DatabaseCheck, SqsQueueCheck],
        },
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
