import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { MetricName } from '../../../src/application/ports/metrics.js';
import { createSqsClient } from '../../../src/infrastructure/messaging/sqs-client.provider.js';
import { DedicatedConnection } from '../schema/support/dedicated-connection.js';
import { openMigratedDatabase } from '../schema/support/schema-sql.js';
import { integrationConfig } from '../support/integration-config.js';
import { type RunningTestApp, startTestApp } from '../support/test-app.js';
import { waitUntil } from '../support/wait-until.js';
import { expectBalanceMatchesLedger, ledgerEntries, openWallet } from '../wagering/support/wagering-api.js';
import {
  consumerConfig,
  createTestQueues,
  deleteTestQueues,
  isEmpty,
  receiveDeadLetters,
  type TestQueues,
} from './support/sqs-test-queues.js';
import { someoneWaitsFor } from './support/lock-observer.js';
import { sendWagerMessage, transactionByExternalId, wagerMessage } from './support/wager-messages.js';

setDefaultTimeout(30_000);

describe('SQS consumer: message groups (FIFO per wallet)', () => {
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

  test('i) wallet B is processed while wallet A waits for its lock, and wallet A keeps its order', async () => {
    const walletA = await openWallet(http.baseUrl, '100.00');
    const walletB = await openWallet(http.baseUrl, '100.00');
    const messagesA = ['10.00', '20.00', '30.00'].map((amount) =>
      wagerMessage(walletA, { money: { amount, currency: 'BRL' } }),
    );
    const messageB = wagerMessage(walletB, { money: { amount: '5.00', currency: 'BRL' } });
    for (const message of [...messagesA, messageB]) {
      await sendWagerMessage(sqs, queues.url, message); // group = walletId
    }

    // Wallet A is held by another session; the consumer starts with everything already queued.
    const holder = await DedicatedConnection.open();
    let consumer: RunningTestApp | undefined;
    try {
      await holder.run('begin');
      await holder.run(`select id from wallets where id = '${walletA.id}' for no key update`);
      consumer = await startTestApp(consumerConfig(queues));

      await waitUntil('the consumer waits for wallet A', () => someoneWaitsFor(orm, holder));
      await waitUntil(
        'wallet B is processed',
        async () => (await transactionByExternalId(orm, messageB.data.externalTransactionId))?.status === 'PROCESSED',
      );
      // B committed while A was STILL waiting: the groups ran in parallel. Run one after
      // the other, B could only finish after A gave up (lock_timeout), with nobody waiting.
      // Margin: A's wait lasts the 2 s lock_timeout; B commits a few milliseconds after A
      // starts waiting. Only if this machine stalled for ~2 s could A be between two
      // in-process attempts (a 50 to 300 ms pause) at this exact check.
      expect(await someoneWaitsFor(orm, holder)).toBe(true);
      expect(await transactionByExternalId(orm, messagesA[0]?.data.externalTransactionId ?? '')).toBeUndefined();

      await holder.run('commit');
      await waitUntil('everything is processed and deleted', async () =>
        (await isEmpty(sqs, queues.url)) &&
        consumer?.metrics.value(MetricName.MessagesProcessed, { status: 'PROCESSED' }) === 4,
      );
    } finally {
      await holder.close();
      await consumer?.close();
    }

    // A's ledger in the order the messages were sent: 10, 20, 30.
    expect((await ledgerEntries(orm, walletA.id)).map((entry) => entry.amount)).toEqual([
      '100.00',
      '10.00',
      '20.00',
      '30.00',
    ]);
    await expectBalanceMatchesLedger(orm, http.baseUrl, walletA.id, '40.00');
    await expectBalanceMatchesLedger(orm, http.baseUrl, walletB.id, '95.00');
  });

  test('a hot wallet: a lock timeout is retried in process, so the wallet\'s other messages are NOT sent back (no receive count inflation)', async () => {
    const wallet = await openWallet(http.baseUrl, '100.00');
    const messages = Array.from({ length: 8 }, () => wagerMessage(wallet, { money: { amount: '1.00', currency: 'BRL' } }));
    for (const message of messages) {
      await sendWagerMessage(sqs, queues.url, message); // one group, one batch
    }

    const holder = await DedicatedConnection.open();
    let consumer: RunningTestApp | undefined;
    try {
      await holder.run('begin');
      await holder.run(`select id from wallets where id = '${wallet.id}' for no key update`);
      consumer = await startTestApp(consumerConfig(queues));
      // The first message waits for the wallet until its 2 s lock_timeout fires (a real 55P03).
      // Either reaction counts: retried in process (now) or sent back to the queue (before the fix).
      await waitUntil('the first message failed once on the lock', () =>
        (consumer?.logs.events('wager_message.contention_retry').length ?? 0) +
          (consumer?.logs.events('wager_consumer.retry_scheduled').length ?? 0) >=
        1,
      );
      await holder.run('commit');
      await waitUntil('all 8 processed and deleted', async () =>
        (await isEmpty(sqs, queues.url)) &&
        consumer?.metrics.value(MetricName.MessagesProcessed, { status: 'PROCESSED' }) === 8,
      );
    } finally {
      await holder.close();
      await consumer?.close();
    }

    // Every message was received exactly once: nothing went back to the queue, so no
    // receive count grew and nothing can drift towards the DLQ without being tried.
    expect(consumer?.logs.events('wager_message.processed').map((line) => line.fields.receiveCount)).toEqual(
      Array(8).fill(1),
    );
    expect(consumer?.metrics.value(MetricName.LockConflicts, { source: 'sqs' })).toBeGreaterThanOrEqual(1);
    expect(consumer?.metrics.value(MetricName.MessageRetries, { error_code: 'LOCK_CONTENTION' })).toBe(0);
    expect(await receiveDeadLetters(sqs, queues)).toEqual([]);
    expect((await ledgerEntries(orm, wallet.id)).map((entry) => entry.transaction_id)).toEqual([
      expect.any(String),
      ...(await Promise.all(
        messages.map(async (message) => (await transactionByExternalId(orm, message.data.externalTransactionId))?.id),
      )),
    ]);
    await expectBalanceMatchesLedger(orm, http.baseUrl, wallet.id, '92.00');
  });

  test('i) the same wallet stays ordered: BET 80 then BET 30 with balance 100 is "80 processed, 30 rejected"', async () => {
    const wallet = await openWallet(http.baseUrl, '100.00');
    const first = wagerMessage(wallet, { money: { amount: '80.00', currency: 'BRL' } });
    const second = wagerMessage(wallet, { money: { amount: '30.00', currency: 'BRL' } });
    await sendWagerMessage(sqs, queues.url, first);
    await sendWagerMessage(sqs, queues.url, second);

    const consumer = await startTestApp(consumerConfig(queues));
    try {
      await waitUntil('both messages are acked', () => isEmpty(sqs, queues.url));
    } finally {
      await consumer.close();
    }

    // In the other order it would be "30 processed, 80 rejected" (balance 70).
    expect((await transactionByExternalId(orm, first.data.externalTransactionId))?.status).toBe('PROCESSED');
    expect(await transactionByExternalId(orm, second.data.externalTransactionId)).toEqual(
      expect.objectContaining({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' }),
    );
    await expectBalanceMatchesLedger(orm, http.baseUrl, wallet.id, '20.00');
  });
});
