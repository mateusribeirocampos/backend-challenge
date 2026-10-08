import {
  type BeforeApplicationShutdown,
  type DynamicModule,
  Inject,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { PublishOutbox } from './application/outbox/publish-outbox.js';
import { CLOCK, type Clock } from './application/ports/clock.js';
import { EVENT_PUBLISHER, type EventPublisher } from './application/ports/event-publisher.js';
import { ID_GENERATOR, type IdGenerator } from './application/ports/id-generator.js';
import { METRICS, type Metrics } from './application/ports/metrics.js';
import { STRUCTURED_LOGGER, type StructuredLogger } from './application/ports/structured-logger.js';
import type { TransactionRunner } from './application/ports/transaction-runner.js';
import { ResolvePendingReferences } from './application/wagering/resolve-pending-references.js';
import { DEFAULT_RETRY_POLICY } from './domain/outbox/outbox-message.js';
import type { AppConfig, OutboxPublisherConfig, PendingReferenceWorkerConfig } from './infrastructure/config/app-config.js';
import { SQS_CLIENT } from './infrastructure/messaging/sqs-client.provider.js';
import { SqsEventPublisher } from './infrastructure/messaging/sqs-event-publisher.js';
import { buildMikroOrmConfig } from './infrastructure/persistence/mikro-orm.config.js';
import { MikroOrmTransactionRunner } from './infrastructure/persistence/mikro-orm-transaction-runner.js';
import { PollingLoop } from './interfaces/scheduling/polling-loop.js';
import { WageringModule } from './wagering.module.js';

const WORKERS_CONFIG = Symbol('WORKERS_CONFIG');
const OUTBOX_PUBLISHER_LOOP = Symbol('OUTBOX_PUBLISHER_LOOP');
const PENDING_REFERENCE_LOOP = Symbol('PENDING_REFERENCE_LOOP');
const BACKGROUND_ORM = Symbol('BACKGROUND_ORM');
const BACKGROUND_TRANSACTION_RUNNER = Symbol('BACKGROUND_TRANSACTION_RUNNER');

/** Longest pause of a loop after failures in a row (database or SQS down). */
const MAX_ERROR_DELAY_MS = 30_000;

/**
 * Composition root of the background loops that run inside every app instance, and
 * their lifecycle (same pattern as WagerConsumerModule):
 *   - onApplicationBootstrap: start the loops that are enabled in the config;
 *   - beforeApplicationShutdown: stop them. The batch in progress finishes the event it
 *     is sending and releases the rest, before the ORMs and the SQS client close;
 *   - onApplicationShutdown: close the loops' own connection pool (they are stopped by then).
 *
 * The loops use their OWN small pool (DATABASE_BACKGROUND_POOL_SIZE), not the one of the
 * HTTP requests and the SQS consumer. In the load test, on a hot wallet, every main pool
 * connection waited on the wallet row lock and the publisher waited behind them for a
 * connection: publishing fell to 4.3 events/s. With its own pool, a request burst can
 * delay the events but no longer stop them.
 */
@Module({})
export class BackgroundWorkersModule implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  constructor(
    @Inject(OUTBOX_PUBLISHER_LOOP) private readonly outboxPublisher: PollingLoop,
    @Inject(PENDING_REFERENCE_LOOP) private readonly pendingReferences: PollingLoop,
    @Inject(BACKGROUND_ORM) private readonly backgroundOrm: MikroORM,
    @Inject(WORKERS_CONFIG) private readonly config: AppConfig,
  ) {}

  static register(config: AppConfig): DynamicModule {
    return {
      module: BackgroundWorkersModule,
      imports: [WageringModule],
      providers: [
        { provide: WORKERS_CONFIG, useValue: config },
        {
          provide: BACKGROUND_ORM,
          useFactory: () => MikroORM.init(buildMikroOrmConfig(config.database, config.database.backgroundPoolSize)),
        },
        {
          provide: BACKGROUND_TRANSACTION_RUNNER,
          useFactory: (orm: MikroORM, metrics: Metrics): TransactionRunner => new MikroOrmTransactionRunner(orm, metrics),
          inject: [BACKGROUND_ORM, METRICS],
        },
        {
          provide: EVENT_PUBLISHER,
          useFactory: (sqs: SQSClient): EventPublisher =>
            new SqsEventPublisher(sqs, config.sqs.eventsQueueName, config.outboxPublisher.sendTimeoutMs),
          inject: [SQS_CLIENT],
        },
        {
          provide: PublishOutbox,
          useFactory: (
            runner: TransactionRunner,
            publisher: EventPublisher,
            clock: Clock,
            ids: IdGenerator,
            metrics: Metrics,
            logger: StructuredLogger,
          ) => new PublishOutbox(runner, publisher, clock, ids, metrics, logger, publisherSettings(config.outboxPublisher)),
          inject: [BACKGROUND_TRANSACTION_RUNNER, EVENT_PUBLISHER, CLOCK, ID_GENERATOR, METRICS, STRUCTURED_LOGGER],
        },
        {
          provide: OUTBOX_PUBLISHER_LOOP,
          useFactory: (publishOutbox: PublishOutbox, logger: StructuredLogger) =>
            new PollingLoop(
              'outbox-publisher',
              // A full batch means there may be more right now: run again without pausing.
              async (shouldStop) => (await publishOutbox.publishBatch(shouldStop)).claimed === config.outboxPublisher.batchSize,
              {
                idleDelayMs: config.outboxPublisher.pollIntervalMs,
                maxErrorDelayMs: MAX_ERROR_DELAY_MS,
                // The batch stops after the send in progress, which ends within sendTimeoutMs.
                shutdownTimeoutMs: config.outboxPublisher.sendTimeoutMs + 2_000,
              },
              logger,
            ),
          inject: [PublishOutbox, STRUCTURED_LOGGER],
        },
        {
          provide: ResolvePendingReferences,
          useFactory: (runner: TransactionRunner, clock: Clock, ids: IdGenerator, metrics: Metrics, logger: StructuredLogger) =>
            new ResolvePendingReferences(runner, clock, ids, metrics, logger, workerSettings(config.pendingReferenceWorker)),
          inject: [BACKGROUND_TRANSACTION_RUNNER, CLOCK, ID_GENERATOR, METRICS, STRUCTURED_LOGGER],
        },
        {
          provide: PENDING_REFERENCE_LOOP,
          useFactory: (resolvePendingReferences: ResolvePendingReferences, logger: StructuredLogger) =>
            new PollingLoop(
              'pending-reference-worker',
              async (shouldStop) =>
                (await resolvePendingReferences.resolveBatch(shouldStop)).checked === config.pendingReferenceWorker.batchSize,
              {
                idleDelayMs: config.pendingReferenceWorker.pollIntervalMs,
                maxErrorDelayMs: MAX_ERROR_DELAY_MS,
                // One check is one short SQL transaction, bounded by the 2 s lock_timeout.
                shutdownTimeoutMs: 5_000,
              },
              logger,
            ),
          inject: [ResolvePendingReferences, STRUCTURED_LOGGER],
        },
      ],
      exports: [PublishOutbox, ResolvePendingReferences],
    };
  }

  onApplicationBootstrap(): void {
    if (this.config.outboxPublisher.enabled) {
      this.outboxPublisher.start();
    }
    if (this.config.pendingReferenceWorker.enabled) {
      this.pendingReferences.start();
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all([this.outboxPublisher.stop(), this.pendingReferences.stop()]);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.backgroundOrm.close();
  }
}

function publisherSettings(config: OutboxPublisherConfig) {
  return {
    batchSize: config.batchSize,
    leaseMs: config.leaseSeconds * 1000,
    sendTimeoutMs: config.sendTimeoutMs,
    retry: DEFAULT_RETRY_POLICY,
  };
}

function workerSettings(config: PendingReferenceWorkerConfig) {
  return {
    batchSize: config.batchSize,
    wait: {
      maxAttempts: config.maxAttempts,
      baseDelayMs: config.baseDelayMs,
      maxDelayMs: config.maxDelayMs,
      random: Math.random,
    },
  };
}
