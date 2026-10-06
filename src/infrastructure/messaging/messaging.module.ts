import { type DynamicModule, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { SqsConfig } from '../config/app-config.js';
import { createSqsClient, SQS_CLIENT } from './sqs-client.provider.js';
import { SqsQueueCheck } from './sqs-queue-check.js';

@Module({})
export class MessagingModule implements OnApplicationShutdown {
  private readonly logger = new Logger(MessagingModule.name);

  constructor(@Inject(SQS_CLIENT) private readonly sqs: SQSClient) {}

  static register(config: SqsConfig): DynamicModule {
    return {
      module: MessagingModule,
      providers: [
        { provide: SQS_CLIENT, useFactory: () => createSqsClient(config) },
        {
          provide: SqsQueueCheck,
          useFactory: (sqs: SQSClient) => new SqsQueueCheck(sqs, config.wagerQueueName),
          inject: [SQS_CLIENT],
        },
      ],
      exports: [SQS_CLIENT, SqsQueueCheck],
    };
  }

  onApplicationShutdown(): void {
    this.sqs.destroy();
    this.logger.log('SQS client closed');
  }
}
