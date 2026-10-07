import {
  type BeforeApplicationShutdown,
  type DynamicModule,
  Inject,
  Module,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { METRICS, type Metrics } from './application/ports/metrics.js';
import { STRUCTURED_LOGGER, type StructuredLogger } from './application/ports/structured-logger.js';
import { ProcessWagerTransaction } from './application/wagering/process-wager-transaction.js';
import type { SqsConfig, WagerConsumerConfig } from './infrastructure/config/app-config.js';
import { SQS_CLIENT } from './infrastructure/messaging/sqs-client.provider.js';
import {
  MESSAGE_ACTIONS,
  type MessageActions,
  SqsMessageActions,
  WagerQueues,
} from './interfaces/messaging/sqs-message-actions.js';
import { SqsWagerConsumer, type WagerConsumerSettings } from './interfaces/messaging/sqs-wager-consumer.js';
import { WagerMessageHandler } from './interfaces/messaging/wager-message-handler.js';
import { WageringModule } from './wagering.module.js';

const CONSUMER_CONFIG = Symbol('CONSUMER_CONFIG');

/**
 * Composition root of the SQS consumer, and its lifecycle inside the app process:
 *   - onApplicationBootstrap: start polling (only if SQS_CONSUMER_ENABLED);
 *   - beforeApplicationShutdown: stop polling and drain. Nest runs this hook BEFORE
 *     onApplicationShutdown, where the ORM and the SQS client close, so the messages
 *     being processed can still commit and be acked. Works with app.enableShutdownHooks()
 *     (SIGTERM) and with app.close().
 */
@Module({})
export class WagerConsumerModule implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(
    @Inject(SqsWagerConsumer) private readonly consumer: SqsWagerConsumer,
    @Inject(CONSUMER_CONFIG) private readonly config: WagerConsumerConfig,
  ) {}

  static register(config: SqsConfig): DynamicModule {
    return {
      module: WagerConsumerModule,
      imports: [WageringModule],
      providers: [
        { provide: CONSUMER_CONFIG, useValue: config.consumer },
        {
          provide: WagerQueues,
          useFactory: (sqs: SQSClient) =>
            new WagerQueues(sqs, { source: config.wagerQueueName, deadLetter: config.wagerDeadLetterQueueName }),
          inject: [SQS_CLIENT],
        },
        {
          provide: MESSAGE_ACTIONS,
          useFactory: (sqs: SQSClient, queues: WagerQueues): MessageActions => new SqsMessageActions(sqs, queues),
          inject: [SQS_CLIENT, WagerQueues],
        },
        {
          provide: WagerMessageHandler,
          useFactory: (useCase: ProcessWagerTransaction, logger: StructuredLogger, metrics: Metrics) =>
            new WagerMessageHandler(useCase, logger, metrics),
          inject: [ProcessWagerTransaction, STRUCTURED_LOGGER, METRICS],
        },
        {
          provide: SqsWagerConsumer,
          useFactory: (
            sqs: SQSClient,
            queues: WagerQueues,
            handler: WagerMessageHandler,
            actions: MessageActions,
            logger: StructuredLogger,
            metrics: Metrics,
          ) => new SqsWagerConsumer(sqs, queues, handler, actions, settingsOf(config), logger, metrics),
          inject: [SQS_CLIENT, WagerQueues, WagerMessageHandler, MESSAGE_ACTIONS, STRUCTURED_LOGGER, METRICS],
        },
      ],
    };
  }

  onApplicationBootstrap(): void {
    if (this.config.enabled) {
      this.consumer.start();
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.consumer.stop();
  }
}

function settingsOf(sqsConfig: SqsConfig): WagerConsumerSettings {
  const config = sqsConfig.consumer;
  return {
    maxMessages: 10,
    visibilityTimeoutSeconds: config.visibilityTimeoutSeconds,
    waitTimeSeconds: config.waitTimeSeconds,
    // A long poll may legitimately take the whole wait time; the usual request deadline is the margin.
    receiveRequestTimeoutMs: config.waitTimeSeconds * 1000 + sqsConfig.requestTimeoutMs,
    shutdownTimeoutMs: config.shutdownTimeoutSeconds * 1000,
    retry: {
      baseDelaySeconds: config.retryBaseDelaySeconds,
      maxDelaySeconds: config.retryMaxDelaySeconds,
      random: Math.random,
    },
    // SQS unreachable: try again after 1 s, 2 s, 4 s... up to 30 s, without crashing.
    receiveBackoff: { baseDelaySeconds: 1, maxDelaySeconds: 30, random: Math.random },
  };
}
