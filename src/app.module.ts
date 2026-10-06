import { type DynamicModule, Module } from '@nestjs/common';
import { DEPENDENCY_CHECKS, type DependencyCheck } from './application/health/check-readiness.js';
import { APP_CONFIG, type AppConfig } from './infrastructure/config/app-config.js';
import { MessagingModule } from './infrastructure/messaging/messaging.module.js';
import { SqsQueueCheck } from './infrastructure/messaging/sqs-queue-check.js';
import { DatabaseCheck } from './infrastructure/persistence/database-check.js';
import { PersistenceModule } from './infrastructure/persistence/persistence.module.js';
import { HealthController } from './interfaces/http/health.controller.js';

/**
 * The config is loaded and validated before Nest starts (main.ts) and passed in here.
 * Tests build the module with their own config (test database, wrong queue, ...).
 */
@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [PersistenceModule.register(config.database), MessagingModule.register(config.sqs)],
      controllers: [HealthController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        {
          provide: DEPENDENCY_CHECKS,
          useFactory: (database: DatabaseCheck, sqs: SqsQueueCheck): DependencyCheck[] => [database, sqs],
          inject: [DatabaseCheck, SqsQueueCheck],
        },
      ],
    };
  }
}
