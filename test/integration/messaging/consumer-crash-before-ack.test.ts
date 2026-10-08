import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { MetricName } from '../../../src/application/ports/metrics.js';
import { createSqsClient } from '../../../src/infrastructure/messaging/sqs-client.provider.js';
import { openMigratedDatabase } from '../schema/support/schema-sql.js';
import { AppProcess } from '../support/app-process.js';
import { integrationConfig } from '../support/integration-config.js';
import { type RunningTestApp, startTestApp } from '../support/test-app.js';
import { waitUntil } from '../support/wait-until.js';
import { expectBalanceMatchesLedger, ledgerEntries, openWallet } from '../wagering/support/wagering-api.js';
import {
  consumerConfig,
  consumerEnv,
  createTestQueues,
  deleteTestQueues,
  isEmpty,
  queueDepth,
  type TestQueues,
} from './support/sqs-test-queues.js';
import { inboxRows, sendWagerMessage, transactionByExternalId, wagerMessage } from './support/wager-messages.js';

setDefaultTimeout(30_000);

/**
 * Spec 13 item 5: the worker dies AFTER the commit and BEFORE the ack. A real process,
 * really killed with SIGKILL (no shutdown hook runs), then a second consumer gets the
 * redelivery.
 */
describe('SQS consumer: crash between commit and ack', () => {
  let orm: MikroORM;
  let sqs: SQSClient;
  let queues: TestQueues;
  let http: RunningTestApp;

  beforeAll(async () => {
    orm = await openMigratedDatabase();
    sqs = createSqsClient(integrationConfig().sqs);
    http = await startTestApp(integrationConfig());
  });

  afterAll(async () => {
    await http.close();
    sqs.destroy();
    await orm.close(true);
  });

  beforeEach(async () => {
    queues = await createTestQueues(sqs);
  });

  afterEach(async () => {
    await deleteTestQueues(sqs, queues);
  });

  test('g) the redelivery hits the inbox: one effect, acked, queue empty', async () => {
    const wallet = await openWallet(http.baseUrl, '100.00');
    const message = wagerMessage(wallet, { money: { amount: '25.00', currency: 'BRL' } });
    await sendWagerMessage(sqs, queues.url, message);

    // Short visibility so the redelivery comes 2 s after the crash, not 30 s.
    const worker = AppProcess.spawn(
      'test/support/kill-before-ack-consumer.ts',
      consumerEnv(queues, { SQS_CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '2' }),
    );
    const exit = await worker.exited;

    expect(exit.signalCode).toBe('SIGKILL');
    expect(worker.eventsNamed('test.killing_before_ack')).toHaveLength(1);
    // The commit happened: the effect and the inbox row are there...
    expect((await transactionByExternalId(orm, message.data.externalTransactionId))?.status).toBe('PROCESSED');
    expect(await inboxRows(orm, message.messageId)).toHaveLength(1);
    // ...and SQS never got the DeleteMessage.
    const depth = await queueDepth(sqs, queues.url);
    expect(depth.visible + depth.inFlight).toBe(1);

    const survivor = await startTestApp(consumerConfig(queues));
    try {
      await waitUntil('the redelivery is acked by the second consumer', async () =>
        (await isEmpty(sqs, queues.url)) &&
        survivor.metrics.value(MetricName.DuplicatesDetected, { layer: 'inbox', source: 'sqs' }) === 1,
      );
      expect(survivor.metrics.value(MetricName.MessagesProcessed, { status: 'PROCESSED' })).toBe(0);
      expect(Number(survivor.logs.events('wager_message.duplicate')[0]?.fields.receiveCount)).toBe(2);
      expect((await ledgerEntries(orm, wallet.id)).map((entry) => [entry.direction, entry.amount])).toEqual([
        ['CREDIT', '100.00'],
        ['DEBIT', '25.00'],
      ]);
      expect(await inboxRows(orm, message.messageId)).toHaveLength(1);
      await expectBalanceMatchesLedger(orm, http.baseUrl, wallet.id, '75.00');
    } finally {
      await survivor.close();
    }
  });
});
