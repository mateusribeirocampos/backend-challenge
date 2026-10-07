import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { MetricName } from '../../../src/application/ports/metrics.js';
import { createSqsClient } from '../../../src/infrastructure/messaging/sqs-client.provider.js';
import { openMigratedDatabase } from '../schema/support/schema-sql.js';
import { integrationConfig } from '../support/integration-config.js';
import { type RunningTestApp, startTestApp } from '../support/test-app.js';
import { waitUntil } from '../support/wait-until.js';
import {
  betAndReversal,
  eventTypesOf,
  parkOtherPendingReferences,
  referenceWaitOf,
  workerConfig,
} from '../wagering/support/pending-references.js';
import { expectBalanceMatchesLedger, ledgerEntries, openWallet, submit } from '../wagering/support/wagering-api.js';
import { consumerConfig, createTestQueues, deleteTestQueues, isEmpty, type TestQueues } from './support/sqs-test-queues.js';
import { inboxRows, sendWagerMessage, wagerMessage } from './support/wager-messages.js';

setDefaultTimeout(20_000);

/**
 * Spec 13 item 7 over SQS: the ROLLBACK message is delivered (and acked) before the
 * message of its BET. The consumer stores it as PENDING_REFERENCE; the worker in the
 * same app instance decides it once the BET is processed.
 */
describe('SQS consumer: ROLLBACK delivered before its BET', () => {
  let orm: MikroORM;
  let sqs: SQSClient;
  let queues: TestQueues;
  let app: RunningTestApp;

  beforeAll(async () => {
    orm = await openMigratedDatabase();
    sqs = createSqsClient(integrationConfig().sqs);
  });

  afterAll(async () => {
    sqs.destroy();
    await orm.close(true);
  });

  beforeEach(async () => {
    await parkOtherPendingReferences(orm);
    queues = await createTestQueues(sqs);
    app = await startTestApp(workerConfig({}, consumerConfig(queues)));
  });

  afterEach(async () => {
    await app.close();
    await deleteTestQueues(sqs, queues);
  });

  test('both messages are acked, the worker processes the ROLLBACK, the final balance is right, and a replay returns it', async () => {
    const wallet = await openWallet(app.baseUrl, '100.00');
    const { bet, reversal: rollback } = betAndReversal(wallet, 'ROLLBACK');
    const rollbackMessage = wagerMessage(wallet, rollback);
    const betMessage = wagerMessage(wallet, bet);

    // Same group (the wallet), in this order: the ROLLBACK is processed first.
    await sendWagerMessage(sqs, queues.url, rollbackMessage);
    await sendWagerMessage(sqs, queues.url, betMessage);

    await waitUntil('both messages are acked and the worker processed the ROLLBACK', async () =>
      (await isEmpty(sqs, queues.url)) &&
      (await referenceWaitOf(orm, rollback.externalTransactionId))?.status === 'PROCESSED',
    );
    expect(app.metrics.value(MetricName.MessagesProcessed, { status: 'PENDING_REFERENCE' })).toBe(1);
    expect(app.metrics.value(MetricName.MessagesProcessed, { status: 'PROCESSED' })).toBe(1);
    expect(await inboxRows(orm, rollbackMessage.messageId)).toHaveLength(1);
    expect((await ledgerEntries(orm, wallet.id)).map((entry) => [entry.direction, entry.amount])).toEqual([
      ['CREDIT', '100.00'],
      ['DEBIT', '25.00'],
      ['CREDIT', '25.00'], // ROLLBACK of a BET: the inverse of the debit
    ]);
    const rollbackId = String((await referenceWaitOf(orm, rollback.externalTransactionId))?.id);
    expect(await eventTypesOf(orm, rollbackId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);

    // The same operation sent again over HTTP (same key, same data) is a replay of the resolved result.
    const replay = await submit(app.baseUrl, rollback);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({
      transactionId: rollbackId,
      status: 'PROCESSED',
      balance: { amount: '100.00', currency: 'BRL' },
      idempotentReplay: true,
    });
    await expectBalanceMatchesLedger(orm, app.baseUrl, wallet.id, '100.00');
  });
});
