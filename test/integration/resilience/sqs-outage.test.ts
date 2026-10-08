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
import { inboxRows, sendWagerMessage, wagerMessage } from '../messaging/support/wager-messages.js';
import { openMigratedDatabase } from '../schema/support/schema-sql.js';
import { integrationConfig } from '../support/integration-config.js';
import { TcpProxy } from '../support/tcp-proxy.js';
import { type RunningTestApp, startTestApp } from '../support/test-app.js';
import { waitUntil } from '../support/wait-until.js';
import { expectBalanceMatchesLedger, openWallet, submit, wager } from '../wagering/support/wagering-api.js';

setDefaultTimeout(60_000);

/**
 * Spec 3, the SQS side: the queue service goes away while the application is consuming
 * and publishing, and comes back. Money keeps moving over HTTP during the outage (the
 * outbox decouples the commit from the publication), and once SQS is back the same
 * process publishes what piled up and consumes what was waiting, each exactly once.
 */
describe('SQS goes down in the middle of the processing (extra: infrastructure failures)', () => {
  let orm: MikroORM;
  let sqs: SQSClient;
  let queues: TestQueues;
  let events: EventsQueue;
  let proxy: TcpProxy;
  let app: RunningTestApp;

  beforeAll(async () => {
    orm = await openMigratedDatabase();
    // Direct client: sets up and checks the queues without going through the proxy.
    sqs = createSqsClient(integrationConfig().sqs);
    queues = await createTestQueues(sqs);
    events = await createEventsQueue(sqs);
    // The publisher works over the whole test database: leave it only this test's events.
    await markEveryPendingEventPublished(orm);

    const base = consumerConfig(queues, { retryBaseDelaySeconds: 1, retryMaxDelaySeconds: 1 });
    const endpoint = new URL(base.sqs.endpoint ?? 'http://localhost:4566');
    proxy = TcpProxy.start(endpoint.hostname, Number(endpoint.port));
    app = await startTestApp({
      ...base,
      sqs: { ...base.sqs, endpoint: `http://127.0.0.1:${proxy.port}`, eventsQueueName: events.name },
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

  test('HTTP keeps answering during the outage; afterwards the backlog is published and consumed once, by the same process', async () => {
    const wallet = await openWallet(app.baseUrl, '100.00');
    proxy.down();

    // The financial path does not need SQS: the event waits in the outbox, committed.
    const bet = await submit(app.baseUrl, wager(wallet, { money: { amount: '25.00', currency: 'BRL' } }));
    expect(bet.status).toBe(201);
    // A message already in the queue, sent by the provider before the outage.
    const message = wagerMessage(wallet, { money: { amount: '10.00', currency: 'BRL' } });
    await sendWagerMessage(sqs, queues.url, message);

    await Bun.sleep(1_500);
    expect((await fetch(`${app.baseUrl}/health/ready`)).status).toBe(503);
    expect((await fetch(`${app.baseUrl}/health/live`)).status).toBe(200);
    expect((await outboxRowsOf(orm, [wallet.id])).some((row) => !row.published)).toBe(true);
    expect(await inboxRows(orm, message.messageId)).toEqual([]);

    proxy.restore();

    await waitUntil(
      'the message was consumed and every event of the wallet published',
      async () =>
        (await inboxRows(orm, message.messageId)).some((row) => row.processed) &&
        (await outboxRowsOf(orm, [wallet.id])).every((row) => row.published),
      30_000,
    );
    // Every event reached the events queue, each once; the wager queue is empty.
    const outbox = await outboxRowsOf(orm, [wallet.id]);
    const received = await receiveEvents(sqs, events, outbox.length);
    expect(new Set(received.map((event) => event.eventId))).toEqual(new Set(outbox.map((row) => row.id)));
    expect(received).toHaveLength(outbox.length);
    expect(await isEmpty(sqs, queues.url)).toBe(true);
    expect(await isEmpty(sqs, queues.deadLetterUrl)).toBe(true);
    // 100.00 - 25.00 (HTTP, during the outage) - 10.00 (SQS, after it): one effect each.
    await expectBalanceMatchesLedger(orm, app.baseUrl, wallet.id, '65.00');
    expect((await fetch(`${app.baseUrl}/health/ready`)).status).toBe(200);
  });
});
