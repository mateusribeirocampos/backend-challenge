/**
 * Test entrypoint (spec 13, item 5): the real app with the real consumer, except that
 * "ack" kills this process with SIGKILL instead of calling DeleteMessage. The message
 * is processed and committed, and the process dies before SQS hears about it.
 *
 * Swapped through Nest's DI (overrideProvider), so production code has no test hook.
 * Run by test/integration/messaging/consumer-crash-before-ack.test.ts with Bun.spawn.
 */
import 'reflect-metadata';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module.js';
import { loadConfig } from '../../src/infrastructure/config/app-config.js';
import { SQS_CLIENT } from '../../src/infrastructure/messaging/sqs-client.provider.js';
import {
  MESSAGE_ACTIONS,
  type ReceivedMessage,
  SqsMessageActions,
  WagerQueues,
} from '../../src/interfaces/messaging/sqs-message-actions.js';

class KillBeforeAck extends SqsMessageActions {
  override async ack(message: ReceivedMessage): Promise<void> {
    process.stdout.write(`${JSON.stringify({ event: 'test.killing_before_ack', sqsMessageId: message.sqsMessageId })}\n`);
    process.kill(process.pid, 'SIGKILL');
  }
}

const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(loadConfig(process.env))] })
  .overrideProvider(MESSAGE_ACTIONS)
  .useFactory({
    factory: (sqs: SQSClient, queues: WagerQueues) => new KillBeforeAck(sqs, queues),
    inject: [SQS_CLIENT, WagerQueues],
  })
  .compile();
const app = moduleRef.createNestApplication({ logger: false });
app.enableShutdownHooks();
await app.listen(0, '127.0.0.1');
