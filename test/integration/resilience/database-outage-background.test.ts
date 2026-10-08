import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createSqsClient } from '../../../src/infrastructure/messaging/sqs-client.provider.js';
import {
  createEventsQueue,
  deleteEventsQueue,
  type EventsQueue,
  markEveryPendingEventPublished,
  outboxRowsOf,
  receiveEvents,
} from '../messaging/support/outbox-events.js';
import { consumerConfig, createTestQueues, deleteTestQueues, isEmpty, type TestQueues } from '../messaging/support/sqs-test-queues.js';
import { inboxRows, sendWagerMessage, transactionByExternalId, wagerMessage } from '../messaging/support/wager-messages.js';
import { openMigratedDatabase } from '../schema/support/schema-sql.js';
import { integrationConfig } from '../support/integration-config.js';
import { TcpProxy } from '../support/tcp-proxy.js';
import { type RunningTestApp, startTestApp } from '../support/test-app.js';
import { waitUntil } from '../support/wait-until.js';
import { betAndReversal, parkOtherPendingReferences, workerConfig } from '../wagering/support/pending-references.js';
import { expectBalanceMatchesLedger, openWallet, submit } from '../wagering/support/wagering-api.js';

setDefaultTimeout(60_000);

/**
 * PostgreSQL goes away while the background work of the process is running: the SQS
 * consumer, the outbox publisher and the PENDING_REFERENCE worker all lose the database
 * at once, on both pools. When it comes back the same process finishes everything:
 * nothing goes to the DLQ (a database outage is transient), every message has one
 * effect, the waiting REFUND is resolved and every event is published once.
 */
describe('PostgreSQL goes down under the consumer, the publisher and the worker (extra: infrastructure failures)', () => {
  let orm: MikroORM;
  let sqs: SQSClient;
  let queues: TestQueues;
  let events: EventsQueue;
  let proxy: TcpProxy;
  let app: RunningTestApp;

  beforeAll(async () => {
    orm = await openMigratedDatabase();
    sqs = createSqsClient(integrationConfig().sqs);
    queues = await createTestQueues(sqs);
    events = await createEventsQueue(sqs);
    // Background loops work over the whole test database: leave them only this test's rows.
    await markEveryPendingEventPublished(orm);
    await parkOtherPendingReferences(orm);

    const base = workerConfig(
      { maxAttempts: 100, maxDelayMs: 500 },
      consumerConfig(queues, { retryBaseDelaySeconds: 1, retryMaxDelaySeconds: 1 }),
    );
    proxy = TcpProxy.start(base.database.host, base.database.port);
    app = await startTestApp({
      ...base,
      database: { ...base.database, host: '127.0.0.1', port: proxy.port },
      sqs: { ...base.sqs, eventsQueueName: events.name },
      outboxPublisher: { ...base.outboxPublisher, enabled: true, pollIntervalMs: 20 },
    });
  });

  afterAll(async () => {
    await app.close();
    proxy.stop();
    await deleteTestQueues(sqs, queues);
    await deleteEventsQueue(sqs, events);
    sqs.destroy();
    await orm.close(true);
  });

  test('messages, the waiting REFUND and the outbox all finish once the database is back, with no DLQ and no restart', async () => {
    const wallet = await openWallet(app.baseUrl, '100.00');
    // A REFUND that arrives before its BET waits in PENDING_REFERENCE for the worker.
    const { bet, reversal } = betAndReversal(wallet, 'REFUND');
    expect((await submit(app.baseUrl, reversal)).status).toBe(202);

    proxy.down();
    // While the database is gone, the BET of that REFUND and another BET reach the queue.
    const betMessage = wagerMessage(wallet, bet);
    const otherBet = wagerMessage(wallet, { money: { amount: '10.00', currency: 'BRL' } });
    await sendWagerMessage(sqs, queues.url, betMessage);
    await sendWagerMessage(sqs, queues.url, otherBet);
    await Bun.sleep(2_000);
    // The consumer received them, failed as transient and left them in the queue.
    expect((await fetch(`${app.baseUrl}/health/ready`)).status).toBe(503);
    expect(await isEmpty(sqs, queues.deadLetterUrl)).toBe(true);

    proxy.restore();

    await waitUntil(
      'both messages processed, the REFUND resolved and every event published',
      async () =>
        (await inboxRows(orm, betMessage.messageId)).some((row) => row.processed) &&
        (await inboxRows(orm, otherBet.messageId)).some((row) => row.processed) &&
        (await transactionByExternalId(orm, reversal.externalTransactionId))?.status === 'PROCESSED' &&
        (await outboxRowsOf(orm, [wallet.id])).every((row) => row.published),
      30_000,
    );
    expect(await isEmpty(sqs, queues.url)).toBe(true);
    expect(await isEmpty(sqs, queues.deadLetterUrl)).toBe(true);
    const outbox = await outboxRowsOf(orm, [wallet.id]);
    const received = await receiveEvents(sqs, events, outbox.length);
    expect(new Set(received.map((event) => event.eventId))).toEqual(new Set(outbox.map((row) => row.id)));
    expect(received).toHaveLength(outbox.length);
    // 100.00 - 25.00 (BET) + 25.00 (its REFUND) - 10.00 (other BET): one effect each.
    await expectBalanceMatchesLedger(orm, app.baseUrl, wallet.id, '90.00');
  });
});
