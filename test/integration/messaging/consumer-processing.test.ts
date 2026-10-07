import { randomUUID } from 'node:crypto';
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
import {
  countRows,
  expectBalanceMatchesLedger,
  ledgerEntries,
  openWallet,
  submit,
  wager,
} from '../wagering/support/wagering-api.js';
import {
  attribute,
  consumerConfig,
  createTestQueues,
  deleteTestQueues,
  isEmpty,
  receiveDeadLetters,
  sendRaw,
  type TestQueues,
} from './support/sqs-test-queues.js';
import { chainOfTwoWaitsFor } from './support/lock-observer.js';
import { inboxRows, sendWagerMessage, transactionByExternalId, wagerMessage } from './support/wager-messages.js';

// Each test creates queues and an app and waits on real deliveries; 5 s (the default) is tight.
setDefaultTimeout(20_000);

/**
 * Spec 10 end to end: a real message in a real FIFO queue (MiniStack), the real
 * consumer inside the real app, the real PostgreSQL. Each test has its own queues.
 */
describe('SQS consumer: processing, deduplication and DLQ (spec 10, ADR-005)', () => {
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
    queues = await createTestQueues(sqs);
    app = await startTestApp(consumerConfig(queues));
  });

  afterEach(async () => {
    await app.close();
    await deleteTestQueues(sqs, queues);
  });

  test('a) a message is processed exactly once: balance, one ledger entry, the inbox row, and the queue is empty', async () => {
    const wallet = await openWallet(app.baseUrl, '100.00');
    const message = wagerMessage(wallet, { money: { amount: '25.00', currency: 'BRL' } });

    await sendWagerMessage(sqs, queues.url, message);

    await waitUntil('the message is deleted from the queue', () => isEmpty(sqs, queues.url));
    const stored = await transactionByExternalId(orm, message.data.externalTransactionId);
    expect(stored?.status).toBe('PROCESSED');
    expect((await ledgerEntries(orm, wallet.id)).map((entry) => [entry.direction, entry.amount])).toEqual([
      ['CREDIT', '100.00'],
      ['DEBIT', '25.00'],
    ]);
    expect(await inboxRows(orm, message.messageId)).toEqual([
      { consumer_name: 'wager-transactions', payload_hash: expect.stringMatching(/^[0-9a-f]{64}$/), processed: true },
    ]);
    expect(app.metrics.value(MetricName.MessagesProcessed, { status: 'PROCESSED' })).toBe(1);
    expect(app.logs.events('wager_message.processed')[0]?.fields).toEqual(
      expect.objectContaining({
        messageId: message.messageId,
        transactionId: stored?.id,
        walletId: wallet.id,
        providerId: 'provider-a',
        correlationId: message.messageId,
      }),
    );
    await expectBalanceMatchesLedger(orm, app.baseUrl, wallet.id, '75.00');
  });

  test('b) the same messageId sent twice (different SQS deduplication ids) has one effect; the copy is acked via the inbox', async () => {
    const wallet = await openWallet(app.baseUrl, '100.00');
    const message = wagerMessage(wallet);

    // Two different deduplication ids: SQS FIFO lets both through, only the inbox can stop the second.
    await sendWagerMessage(sqs, queues.url, message, { deduplicationId: randomUUID() });
    await sendWagerMessage(sqs, queues.url, message, { deduplicationId: randomUUID() });

    await waitUntil('both copies are deleted', async () =>
      (await isEmpty(sqs, queues.url)) && app.metrics.value(MetricName.DuplicatesDetected, { layer: 'inbox' }) === 1,
    );
    expect(await countRows(orm, 'wallet_ledger_entries', `wallet_id = '${wallet.id}'`)).toBe(2); // OPENING + one DEBIT
    expect(await inboxRows(orm, message.messageId)).toHaveLength(1);
    expect(app.metrics.value(MetricName.MessagesProcessed, { status: 'PROCESSED' })).toBe(1);
    await expectBalanceMatchesLedger(orm, app.baseUrl, wallet.id, '75.00');
  });

  test('b) the two copies really overlapping (two groups, so in parallel): the second waits on the inbox key, one effect', async () => {
    const wallet = await openWallet(app.baseUrl, '100.00');
    const message = wagerMessage(wallet);

    // The test holds the wallet row, so the first copy stops after its inbox INSERT, with
    // the row not committed. The second copy's inbox INSERT must then wait for the first.
    const holder = await DedicatedConnection.open();
    try {
      await holder.run('begin');
      await holder.run(`select id from wallets where id = '${wallet.id}' for no key update`);
      await sendWagerMessage(sqs, queues.url, message, { groupId: 'copy-1' });
      await sendWagerMessage(sqs, queues.url, message, { groupId: 'copy-2' });

      // Overlap proven by PostgreSQL: copy A waits for the test, copy B waits for copy A.
      // (Both waits are bounded by the 2 s lock_timeout; this check and the commit take a
      // few milliseconds, and a timeout would only be retried in process.)
      await waitUntil('one copy waits for the wallet and the other waits for that copy', () =>
        chainOfTwoWaitsFor(orm, holder),
      );
      await holder.run('commit');
    } finally {
      await holder.close();
    }

    await waitUntil('both copies are deleted', async () =>
      (await isEmpty(sqs, queues.url)) && app.metrics.value(MetricName.DuplicatesDetected, { layer: 'inbox' }) === 1,
    );
    expect(await countRows(orm, 'wallet_ledger_entries', `wallet_id = '${wallet.id}'`)).toBe(2);
    await expectBalanceMatchesLedger(orm, app.baseUrl, wallet.id, '75.00');
  });

  test('c) the same operation by HTTP and then by SQS (another messageId, same idempotencyKey) has one effect', async () => {
    const wallet = await openWallet(app.baseUrl, '100.00');
    const body = wager(wallet);
    expect((await submit(app.baseUrl, body)).status).toBe(201);

    const message = wagerMessage(wallet, body);
    await sendWagerMessage(sqs, queues.url, message);

    await waitUntil('the message is acked', () => isEmpty(sqs, queues.url));
    expect(app.metrics.value(MetricName.DuplicatesDetected, { layer: 'idempotency_key' })).toBe(1);
    expect(app.metrics.value(MetricName.MessagesProcessed, { status: 'PROCESSED' })).toBe(0);
    // The message is recorded as handled, even though the operation came from HTTP.
    expect(await inboxRows(orm, message.messageId)).toHaveLength(1);
    expect(await countRows(orm, 'wallet_ledger_entries', `wallet_id = '${wallet.id}'`)).toBe(2);
    await expectBalanceMatchesLedger(orm, app.baseUrl, wallet.id, '75.00');
  });

  test('c) and the other way round: SQS first, then HTTP gets a replay (200) with the original result', async () => {
    const wallet = await openWallet(app.baseUrl, '100.00');
    const message = wagerMessage(wallet);
    await sendWagerMessage(sqs, queues.url, message);
    await waitUntil('the message is acked', () => isEmpty(sqs, queues.url));

    const { idempotencyKey, ...body } = message.data;
    const replay = await submit(app.baseUrl, body, idempotencyKey);

    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(expect.objectContaining({ status: 'PROCESSED', idempotentReplay: true }));
    await expectBalanceMatchesLedger(orm, app.baseUrl, wallet.id, '75.00');
  });

  test('d) a business rejection (INSUFFICIENT_FUNDS) is acked and stored as REJECTED, without moving the balance', async () => {
    const wallet = await openWallet(app.baseUrl, '10.00');
    const message = wagerMessage(wallet, { money: { amount: '50.00', currency: 'BRL' } });

    await sendWagerMessage(sqs, queues.url, message);

    await waitUntil('the message is acked', () => isEmpty(sqs, queues.url));
    expect(await transactionByExternalId(orm, message.data.externalTransactionId)).toEqual(
      expect.objectContaining({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' }),
    );
    expect(app.metrics.value(MetricName.MessagesProcessed, { status: 'REJECTED' })).toBe(1);
    expect(await receiveDeadLetters(sqs, queues)).toEqual([]);
    await expectBalanceMatchesLedger(orm, app.baseUrl, wallet.id, '10.00');
  });

  describe('conflicts go to the DLQ with their reason (no 409 channel on SQS, so the data is kept); one effect', () => {
    type Envelope = ReturnType<typeof wagerMessage>;
    const cases: { name: string; reason: string; conflictWith: (first: Envelope) => Envelope }[] = [
      {
        name: 'same idempotency key, other amount',
        reason: 'IDEMPOTENCY_KEY_CONFLICT',
        conflictWith: (first) =>
          wagerMessage(
            { id: first.data.walletId, playerId: first.data.playerId },
            { externalTransactionId: first.data.externalTransactionId, money: { amount: '30.00', currency: 'BRL' } },
          ),
      },
      {
        name: 'same externalTransactionId under another idempotency key',
        reason: 'EXTERNAL_TRANSACTION_ID_CONFLICT',
        conflictWith: (first) => ({
          ...first,
          messageId: `msg-${randomUUID()}`,
          data: { ...first.data, idempotencyKey: 'provider-a:another-key' },
        }),
      },
      {
        name: 'same messageId with different data (another operation entirely)',
        reason: 'MESSAGE_ID_CONFLICT',
        conflictWith: (first) => ({
          ...wagerMessage({ id: first.data.walletId, playerId: first.data.playerId }),
          messageId: first.messageId,
        }),
      },
    ];

    for (const { name, reason, conflictWith } of cases) {
      test(name, async () => {
        const wallet = await openWallet(app.baseUrl, '100.00');
        const first = wagerMessage(wallet, { money: { amount: '25.00', currency: 'BRL' } });
        const conflicting = conflictWith(first);

        // Different SQS deduplication ids (random by default), so only our checks can stop the second.
        await sendWagerMessage(sqs, queues.url, first);
        const conflictingSqsId = await sendWagerMessage(sqs, queues.url, conflicting);

        await waitUntil('both messages left the source queue', () => isEmpty(sqs, queues.url));
        const deadLetters = await receiveDeadLetters(sqs, queues);
        expect(deadLetters.map((letter) => [attribute(letter, 'reason'), attribute(letter, 'sourceMessageId')])).toEqual([
          [reason, conflictingSqsId],
        ]);
        expect(deadLetters[0]?.Body).toBe(JSON.stringify(conflicting));
        expect(app.metrics.value(MetricName.MessagesDeadLettered, { reason })).toBe(1);
        // The conflicting message left nothing behind: only the first message's inbox row exists.
        expect(await inboxRows(orm, first.messageId)).toHaveLength(1);
        if (conflicting.messageId !== first.messageId) {
          expect(await inboxRows(orm, conflicting.messageId)).toEqual([]);
        }
        expect(await countRows(orm, 'wager_transactions', `wallet_id = '${wallet.id}'`)).toBe(2); // OPENING + first
        await expectBalanceMatchesLedger(orm, app.baseUrl, wallet.id, '75.00');
      });
    }
  });

  describe('e) permanent failures go to the DLQ on the first delivery, with the reason; nothing is stored', () => {
    type Wallet = { id: string; playerId: string };
    const cases: {
      name: string;
      /** The raw body, and the envelope messageId when there is one. */
      build: (wallet: Wallet) => { body: string; messageId?: string };
      reason: string;
      errorCode: string;
    }[] = [
      {
        name: 'malformed JSON',
        build: () => ({ body: '{"messageId": "msg-1", "data": ' }),
        reason: 'MALFORMED_JSON',
        errorCode: 'MALFORMED_JSON',
      },
      {
        name: 'schema invalid (no messageId)',
        build: (wallet) => {
          const { messageId: _dropped, ...withoutId } = wagerMessage(wallet);
          return { body: JSON.stringify(withoutId) };
        },
        reason: 'SCHEMA_INVALID',
        errorCode: 'MISSING_FIELD',
      },
      {
        name: 'a NUL control character in data.roundId (was 08P01 before)',
        build: (wallet) => {
          const message = wagerMessage(wallet, { roundId: 'round\u0000x' });
          return { body: JSON.stringify(message), messageId: message.messageId };
        },
        reason: 'SCHEMA_INVALID',
        errorCode: 'INVALID_FORMAT',
      },
      {
        name: 'a contract violation of the domain (REFUND without reference)',
        build: (wallet) => {
          const message = wagerMessage(wallet, { kind: 'REFUND' });
          return { body: JSON.stringify(message), messageId: message.messageId };
        },
        reason: 'CONTRACT_VIOLATION',
        errorCode: 'REFERENCE_REQUIRED',
      },
    ];

    for (const { name, build, reason, errorCode } of cases) {
      test(name, async () => {
        const wallet = await openWallet(app.baseUrl, '100.00');
        const { body, messageId } = build(wallet);
        const sqsMessageId = await sendRaw(sqs, queues.url, body, { groupId: wallet.id });

        await waitUntil('the source queue is empty', () => isEmpty(sqs, queues.url));
        const deadLetters = await receiveDeadLetters(sqs, queues);
        expect(deadLetters).toHaveLength(1);
        const [deadLetter] = deadLetters;
        if (deadLetter === undefined) throw new Error('no dead letter');
        expect({
          body: deadLetter.Body,
          reason: attribute(deadLetter, 'reason'),
          errorCode: attribute(deadLetter, 'errorCode'),
          sourceMessageId: attribute(deadLetter, 'sourceMessageId'),
          // Dead-lettered by the consumer on the FIRST delivery, not by the redrive after 5.
          receiveCount: attribute(deadLetter, 'receiveCount'),
          groupId: deadLetter.Attributes?.MessageGroupId,
        }).toEqual({ body, reason, errorCode, sourceMessageId: sqsMessageId, receiveCount: '1', groupId: wallet.id });
        expect(app.metrics.value(MetricName.MessagesDeadLettered, { reason })).toBe(1);
        // Only the OPENING of the wallet exists, and the message left no inbox row.
        expect(await countRows(orm, 'wager_transactions', `wallet_id = '${wallet.id}'`)).toBe(1);
        if (messageId !== undefined) {
          expect(await inboxRows(orm, messageId)).toEqual([]);
        }
        await expectBalanceMatchesLedger(orm, app.baseUrl, wallet.id, '100.00');
      });
    }
  });
});
