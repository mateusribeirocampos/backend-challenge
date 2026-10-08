import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { MetricName } from '../../../src/application/ports/metrics.js';
import { createSqsClient } from '../../../src/infrastructure/messaging/sqs-client.provider.js';
import { randomUUID } from 'node:crypto';
import { newId, openMigratedDatabase, openWalletWithBalance } from '../schema/support/schema-sql.js';
import { integrationConfig } from '../support/integration-config.js';
import { type RunningTestApp, startTestApp } from '../support/test-app.js';
import { waitUntil } from '../support/wait-until.js';
import { expectBalanceMatchesLedger, ledgerEntries, openWallet } from '../wagering/support/wagering-api.js';
import {
  attribute,
  consumerConfig,
  createTestQueues,
  deleteTestQueues,
  isEmpty,
  queueDepth,
  receiveDeadLetters,
  type TestQueues,
} from './support/sqs-test-queues.js';
import { inboxRows, sendWagerMessage, transactionByExternalId, wagerMessage } from './support/wager-messages.js';

setDefaultTimeout(30_000);

/** Port 1 on loopback: nothing listens there, every connection is refused at once. */
const NOWHERE_PORT = 1;

describe('SQS consumer: transient failures (spec 10)', () => {
  let orm: MikroORM;
  let sqs: SQSClient;
  let queues: TestQueues;
  let http: RunningTestApp;

  beforeAll(async () => {
    orm = await openMigratedDatabase();
    sqs = createSqsClient(integrationConfig().sqs);
    // HTTP only (consumer off): opens wallets and reads balances for the tests.
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

  /** The test config with a database nobody listens on, and 1 s between retries. */
  function brokenDatabaseConfig(testQueues: TestQueues) {
    const config = consumerConfig(testQueues, { retryBaseDelaySeconds: 1, retryMaxDelaySeconds: 1 });
    return { ...config, database: { ...config.database, port: NOWHERE_PORT } };
  }

  test('f) database unreachable: the message is NOT deleted, its visibility is shortened, and a healthy consumer then processes it once', async () => {
    const wallet = await openWallet(http.baseUrl, '100.00');
    const message = wagerMessage(wallet, { money: { amount: '25.00', currency: 'BRL' } });
    await sendWagerMessage(sqs, queues.url, message);

    // Receives with 60 s of visibility; a transient failure must bring that down to the backoff (1 s here).
    const brokenConfig = consumerConfig(queues, {
      visibilityTimeoutSeconds: 60,
      retryBaseDelaySeconds: 1,
      retryMaxDelaySeconds: 1,
    });
    const broken = await startTestApp({ ...brokenConfig, database: { ...brokenConfig.database, port: NOWHERE_PORT } });
    await waitUntil('the broken consumer scheduled a retry', () =>
      broken.metrics.value(MetricName.MessageRetries, { error_code: 'TRANSIENT_FAILURE' }) >= 1,
    );
    await broken.close();

    expect(broken.logs.events('wager_consumer.retry_scheduled')[0]?.fields).toEqual(
      expect.objectContaining({ receiveCount: 1, delaySeconds: 1, errorCode: 'TRANSIENT_FAILURE' }),
    );
    expect(broken.logs.events('wager_consumer.dead_lettered')).toEqual([]);
    const depth = await queueDepth(sqs, queues.url);
    expect(depth.visible + depth.inFlight).toBe(1); // still there: not deleted
    expect(await transactionByExternalId(orm, message.data.externalTransactionId)).toBeUndefined();

    // Without the ChangeMessageVisibility the message would stay hidden for 60 s, past this test's timeout.
    const healthy = await startTestApp(consumerConfig(queues));
    try {
      await waitUntil('the healthy consumer processed and deleted it', async () =>
        (await isEmpty(sqs, queues.url)) &&
        healthy.metrics.value(MetricName.MessagesProcessed, { status: 'PROCESSED' }) === 1,
      );
      const processed = healthy.logs.events('wager_message.processed')[0]?.fields;
      expect(Number(processed?.receiveCount)).toBeGreaterThanOrEqual(2);
      expect((await ledgerEntries(orm, wallet.id)).map((entry) => entry.direction)).toEqual(['CREDIT', 'DEBIT']);
      expect(await inboxRows(orm, message.messageId)).toHaveLength(1);
      expect(await receiveDeadLetters(sqs, queues)).toEqual([]);
      await expectBalanceMatchesLedger(orm, http.baseUrl, wallet.id, '75.00');
    } finally {
      await healthy.close();
    }
  });

  test('the attempt limit: after maxReceiveCount failed deliveries the REDRIVE (not the consumer) moves it to the DLQ', async () => {
    // Its own queues with maxReceiveCount 2, so the limit is reached in a few seconds.
    const limited = await createTestQueues(sqs, { maxReceiveCount: 2 });
    try {
      const wallet = await openWallet(http.baseUrl, '100.00');
      const message = wagerMessage(wallet);
      await sendWagerMessage(sqs, limited.url, message);

      const broken = await startTestApp(brokenDatabaseConfig(limited));
      try {
        await waitUntil('the message reached the DLQ', async () => (await queueDepth(sqs, limited.deadLetterUrl)).visible === 1);
      } finally {
        await broken.close();
      }

      const [deadLetter, ...others] = await receiveDeadLetters(sqs, limited);
      expect(others).toEqual([]);
      expect(deadLetter?.Body).toBe(JSON.stringify(message));
      // No attributes of ours: the consumer only scheduled retries; SQS moved it on the third receive.
      expect(attribute(deadLetter ?? {}, 'reason')).toBeUndefined();
      expect(Number(deadLetter?.Attributes?.ApproximateReceiveCount)).toBeGreaterThan(2);
      expect(broken.metrics.value(MetricName.MessageRetries, { error_code: 'TRANSIENT_FAILURE' })).toBe(2);
      expect(broken.logs.events('wager_consumer.dead_lettered')).toEqual([]);
      expect(await isEmpty(sqs, limited.url)).toBe(true);
      expect(await transactionByExternalId(orm, message.data.externalTransactionId)).toBeUndefined();
      await expectBalanceMatchesLedger(orm, http.baseUrl, wallet.id, '100.00');
    } finally {
      await deleteTestQueues(sqs, limited);
    }
  });

  test('a wallet created AFTER its first message: WALLET_NOT_FOUND is retried, and the message is processed once it exists', async () => {
    // The id is chosen here so the message can name a wallet that does not exist yet.
    const walletId = newId();
    const playerId = randomUUID();
    const message = wagerMessage({ id: walletId, playerId }, { money: { amount: '25.00', currency: 'BRL' } });
    await sendWagerMessage(sqs, queues.url, message);

    const consumer = await startTestApp(consumerConfig(queues, { retryBaseDelaySeconds: 1, retryMaxDelaySeconds: 1 }));
    try {
      await waitUntil('the first delivery was retried as WALLET_NOT_FOUND', () =>
        consumer.metrics.value(MetricName.MessageRetries, { error_code: 'WALLET_NOT_FOUND' }) >= 1,
      );
      // The failed attempt rolled back its inbox row with the rest: a row left behind would turn
      // the redelivery into a "duplicate" and the operation would never be processed.
      expect(await inboxRows(orm, message.messageId)).toEqual([]);
      // The wallet arrives (over HTTP in real life; written directly here to keep the chosen id).
      await openWalletWithBalance(orm, '100.00', { id: walletId, playerId });

      await waitUntil('processed and deleted', async () =>
        (await isEmpty(sqs, queues.url)) &&
        consumer.metrics.value(MetricName.MessagesProcessed, { status: 'PROCESSED' }) === 1,
      );
    } finally {
      await consumer.close();
    }
    expect(Number(consumer.logs.events('wager_message.processed')[0]?.fields.receiveCount)).toBeGreaterThanOrEqual(2);
    expect(await receiveDeadLetters(sqs, queues)).toEqual([]);
    expect((await transactionByExternalId(orm, message.data.externalTransactionId))?.status).toBe('PROCESSED');
    await expectBalanceMatchesLedger(orm, http.baseUrl, walletId, '75.00');
  });

  test('SQS unreachable: the loop keeps trying with backoff, the process stays up, and it stops cleanly', async () => {
    const config = consumerConfig(queues);
    const app = await startTestApp({ ...config, sqs: { ...config.sqs, endpoint: `http://127.0.0.1:${NOWHERE_PORT}` } });
    try {
      await waitUntil('two failed receives', () =>
        app.metrics.value(MetricName.ConsumerSqsErrors, { operation: 'receive' }) >= 2,
      );
      const live = await fetch(`${app.baseUrl}/health/live`);
      expect(live.status).toBe(200);
    } finally {
      await app.close();
    }
    expect(app.logs.events('wager_consumer.stopped')[0]?.fields).toEqual({ drained: true });
  });
});
