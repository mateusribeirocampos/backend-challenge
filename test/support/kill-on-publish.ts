/**
 * Test entrypoint (spec 11 scenario, ADR-005): the real app with the real outbox
 * publisher, except that the event publisher kills this process with SIGKILL:
 *   KILL_MOMENT=before-send: after the claim committed, before SendMessage;
 *   KILL_MOMENT=after-send:  after SendMessage, before the event is marked published.
 * Either way the lease stays in the database with nobody to finish the work.
 *
 * Swapped through Nest's DI (overrideProvider), so production code has no test hook.
 * Run by test/integration/messaging/outbox-publisher-crash.test.ts with Bun.spawn.
 */
import 'reflect-metadata';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module.js';
import { EVENT_PUBLISHER, type EventPublisher } from '../../src/application/ports/event-publisher.js';
import type { OutboxMessage } from '../../src/domain/outbox/outbox-message.js';
import { loadConfig } from '../../src/infrastructure/config/app-config.js';
import { SQS_CLIENT } from '../../src/infrastructure/messaging/sqs-client.provider.js';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher.js';

const moment = process.env.KILL_MOMENT === 'after-send' ? 'after-send' : 'before-send';
const config = loadConfig(process.env);

class KillingPublisher implements EventPublisher {
  constructor(private readonly real: EventPublisher) {}

  async publish(message: OutboxMessage): Promise<void> {
    if (moment === 'after-send') {
      await this.real.publish(message);
    }
    process.stdout.write(`${JSON.stringify({ event: 'test.killing_publisher', eventId: message.id, moment })}\n`);
    process.kill(process.pid, 'SIGKILL');
  }
}

const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(config)] })
  .overrideProvider(EVENT_PUBLISHER)
  .useFactory({
    factory: (sqs: SQSClient) =>
      new KillingPublisher(new SqsEventPublisher(sqs, config.sqs.eventsQueueName, config.outboxPublisher.sendTimeoutMs)),
    inject: [SQS_CLIENT],
  })
  .compile();
const app = moduleRef.createNestApplication({ logger: false });
app.enableShutdownHooks();
await app.listen(0, '127.0.0.1');
