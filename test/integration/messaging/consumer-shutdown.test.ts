import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { MetricName } from '../../../src/application/ports/metrics.js';
import { createSqsClient } from '../../../src/infrastructure/messaging/sqs-client.provider.js';
import { DedicatedConnection } from '../schema/support/dedicated-connection.js';
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
import { someoneWaitsFor } from './support/lock-observer.js';
import { inboxRows, sendWagerMessage, transactionByExternalId, wagerMessage } from './support/wager-messages.js';

setDefaultTimeout(30_000);

/** A port nobody uses right now, for the child's HTTP server. */
function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const { port } = server;
  void server.stop(true);
  if (port === undefined) throw new Error('no free port');
  return port;
}

/**
 * Spec 10: "em SIGTERM, concluir mensagens em andamento ou devolver a visibilidade".
 * The child is src/main.ts itself (app.enableShutdownHooks()), sent a real SIGTERM.
 */
describe('SQS consumer: SIGTERM', () => {
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

  test('h) the message in flight completes and is acked, the ones not started go back, and in the end each is processed once', async () => {
    const wallet = await openWallet(http.baseUrl, '100.00');
    const messages = ['10.00', '20.00', '30.00'].map((amount) =>
      wagerMessage(wallet, { money: { amount, currency: 'BRL' } }),
    );
    for (const message of messages) {
      await sendWagerMessage(sqs, queues.url, message); // one group (the wallet), in this order
    }
    const [inFlight, notStarted1, notStarted2] = messages;
    if (inFlight === undefined || notStarted1 === undefined || notStarted2 === undefined) throw new Error('3 messages');

    // Hold the wallet row so the first message is provably IN FLIGHT when SIGTERM arrives.
    const holder = await DedicatedConnection.open();
    const worker = AppProcess.spawn(
      'src/main.ts',
      // 60 s visibility: a message that was not given back would stay hidden past this test's timeout.
      consumerEnv(queues, { PORT: String(freePort()), SQS_CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '60' }),
    );
    try {
      await holder.run('begin');
      await holder.run(`select id from wallets where id = '${wallet.id}' for no key update`);
      await waitUntil('the worker is waiting for the wallet lock', () => someoneWaitsFor(orm, holder));

      // Margin: the worker's wait lasts the 2 s lock_timeout. Signal, "stopping" and commit
      // take a few tens of milliseconds. If they ever took longer, the 55P03 would be
      // retried in process (the message is still in flight), so the outcome is the same.
      worker.signal('SIGTERM');
      await worker.waitForEvent('wager_consumer.stopping', 2_000);
      await holder.run('commit');
    } finally {
      await holder.close();
    }
    const exit = await worker.exited;

    expect(exit.signalCode ?? exit.exitCode).toBe('SIGTERM'); // Nest re-raises the signal after the hooks
    expect(worker.eventsNamed('wager_message.processed').map((line) => line.messageId)).toEqual([inFlight.messageId]);
    expect(worker.eventsNamed('wager_consumer.released')).toEqual([
      expect.objectContaining({ cause: 'shutdown', count: 2 }),
    ]);
    expect(worker.eventsNamed('wager_consumer.stopped')).toEqual([expect.objectContaining({ drained: true })]);
    // The in-flight one committed AND was acked; the other two are back in the queue, visible now.
    expect((await transactionByExternalId(orm, inFlight.data.externalTransactionId))?.status).toBe('PROCESSED');
    expect(await transactionByExternalId(orm, notStarted1.data.externalTransactionId)).toBeUndefined();
    expect(await queueDepth(sqs, queues.url)).toEqual({ visible: 2, inFlight: 0 });

    const next = await startTestApp(consumerConfig(queues));
    try {
      await waitUntil('the two returned messages are processed', async () =>
        (await isEmpty(sqs, queues.url)) &&
        next.metrics.value(MetricName.MessagesProcessed, { status: 'PROCESSED' }) === 2,
      );
      // Received once by the stopped worker, so this is their second delivery.
      expect(next.logs.events('wager_message.processed').map((line) => line.fields.receiveCount)).toEqual([2, 2]);
    } finally {
      await next.close();
    }
    for (const message of messages) {
      expect(await inboxRows(orm, message.messageId)).toHaveLength(1);
    }
    // FIFO order kept across the shutdown: 10, then 20, then 30.
    expect((await ledgerEntries(orm, wallet.id)).map((entry) => [entry.direction, entry.amount])).toEqual([
      ['CREDIT', '100.00'],
      ['DEBIT', '10.00'],
      ['DEBIT', '20.00'],
      ['DEBIT', '30.00'],
    ]);
    await expectBalanceMatchesLedger(orm, http.baseUrl, wallet.id, '40.00');
  });

  test('stopped in the middle of an empty long poll: waits for it (bounded), drains, and leaves the queue untouched', async () => {
    const app = await startTestApp(consumerConfig(queues, { visibilityTimeoutSeconds: 60, waitTimeSeconds: 3 }));
    // The first empty poll returned, so the next one is open right now: close in the middle of it.
    await waitUntil('a first empty poll', () => app.metrics.value(MetricName.ConsumerReceives, { result: 'empty' }) >= 1);
    const closing = Date.now();
    await app.close();

    expect(Date.now() - closing).toBeLessThan(5_000); // at most one poll (3 s) plus the app shutdown
    expect(app.logs.events('wager_consumer.stopped')[0]?.fields).toEqual({ drained: true });
    const wallet = await openWallet(http.baseUrl, '100.00');
    await sendWagerMessage(sqs, queues.url, wagerMessage(wallet));
    // Nobody is polling any more: the message stays visible for the next consumer.
    // (Test f is the one that catches an aborted poll hiding a message.)
    expect(await queueDepth(sqs, queues.url)).toEqual({ visible: 1, inFlight: 0 });
    await expectBalanceMatchesLedger(orm, http.baseUrl, wallet.id, '100.00');
  });
});
