import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createSqsClient } from '../../../src/infrastructure/messaging/sqs-client.provider.js';
import {
  createEventsQueue,
  deleteEventsQueue,
  markEveryPendingEventPublished,
  outboxRowsOf,
  receiveEvents,
} from '../messaging/support/outbox-events.js';
import { createTestQueues, deleteTestQueues, isEmpty } from '../messaging/support/sqs-test-queues.js';
import { inboxRows, sendWagerMessage, transactionByExternalId, wagerMessage, type WagerEnvelope } from '../messaging/support/wager-messages.js';
import { openMigratedDatabase } from '../schema/support/schema-sql.js';
import { integrationConfig } from '../support/integration-config.js';
import { betAndReversal, parkOtherPendingReferences } from '../wagering/support/pending-references.js';
import { countRows, type OpenedWallet, openWallet, wager } from '../wagering/support/wagering-api.js';
import {
  type ClusterQueues,
  expectWalletConsistent,
  type Instance,
  killAllInstances,
  outcomesOf,
  processedPerInstance,
  startInstances,
  submitUntilAnswered,
  waitUntilSettled,
} from './support/cluster.js';

setDefaultTimeout(60_000);

const BRL = (amount: string) => ({ amount, currency: 'BRL' });

/**
 * Spec 13 item 4: three real processes of src/main.ts, at the same time, on the same
 * database and the same queues. HTTP requests go round-robin to the three; SQS messages
 * are taken by whichever consumer receives them. Nothing coordinates the instances
 * except PostgreSQL (row locks, unique constraints) and SQS (visibility, message groups).
 */
describe('three instances at the same time (spec 13 item 4)', () => {
  let orm: MikroORM;
  let sqs: SQSClient;
  let queues: ClusterQueues;

  beforeAll(async () => {
    orm = await openMigratedDatabase();
    sqs = createSqsClient(integrationConfig().sqs);
  });

  afterAll(async () => {
    sqs.destroy();
    await orm.close(true);
  });

  beforeEach(async () => {
    // Every instance runs a publisher and a worker over the whole test database: leave
    // them only this test's events and pending references.
    await markEveryPendingEventPublished(orm);
    await parkOtherPendingReferences(orm);
    queues = { wager: await createTestQueues(sqs), events: await createEventsQueue(sqs) };
  });

  afterEach(async () => {
    await killAllInstances();
    await deleteTestQueues(sqs, queues.wager);
    await deleteEventsQueue(sqs, queues.events);
  });

  test('HTTP and SQS load spread over 3 processes: exact balances, one effect per operation, nothing left behind', async () => {
    const instances = await startInstances(['instance-1', 'instance-2', 'instance-3'], queues);
    const all = () => instances;
    const urlOf = (index: number) => (instances[index % instances.length] as Instance).baseUrl;

    const hot = await openWallet(urlOf(0), '100.00');
    const sameBet = await openWallet(urlOf(1), '100.00');
    const reversals = await openWallet(urlOf(2), '100.00');
    const outOfOrder = await openWallet(urlOf(0), '100.00');
    const twoBetsOf80 = await openWallet(urlOf(2), '100.00');
    const distinct: OpenedWallet[] = [];
    for (let index = 0; index < 6; index += 1) {
      distinct.push(await openWallet(urlOf(index), '100.00'));
    }

    // SQS side, sent before the HTTP burst so the consumers work during it.
    const messages: WagerEnvelope[] = [];
    const send = async (message: WagerEnvelope) => {
      messages.push(message);
      await sendWagerMessage(sqs, queues.wager.url, message);
    };
    // Hot wallet: 10 BETs of 10.00 by SQS race the 20 HTTP BETs below for the same 100.00.
    for (let index = 0; index < 10; index += 1) {
      await send(wagerMessage(hot, { money: BRL('10.00') }));
    }
    // The same BET by HTTP (6 times, 2 per instance) and by SQS (2 messageIds, same key).
    const theSameBet = wager(sameBet, { money: BRL('30.00') });
    for (let index = 0; index < 2; index += 1) {
      await send(wagerMessage(sameBet, theSameBet));
    }
    // Distinct wallets: 2 BETs of 10.00 each by SQS (plus 2 of 15.00 by HTTP below).
    for (const wallet of distinct) {
      await send(wagerMessage(wallet, { money: BRL('10.00') }));
      await send(wagerMessage(wallet, { money: BRL('10.00') }));
    }
    // A BET and its ROLLBACK by SQS, in the wallet's message group (FIFO keeps the order).
    const sqsBet = wagerMessage(reversals, { money: BRL('40.00') });
    await send(sqsBet);
    await send(
      wagerMessage(reversals, {
        kind: 'ROLLBACK',
        roundId: sqsBet.data.roundId,
        money: BRL('40.00'),
        referenceExternalTransactionId: sqsBet.data.externalTransactionId,
      }),
    );

    // HTTP side, all at once.
    const hotBets = Array.from({ length: 20 }, () => wager(hot, { money: BRL('10.00') }));
    const httpRefundPair = betAndReversal(reversals, 'REFUND');
    const outOfOrderPair = betAndReversal(outOfOrder, 'REFUND');
    let outOfOrderBetMessage: WagerEnvelope | undefined;

    const [hotAnswers, sameBetAnswers, , , refundBeforeBet, betsOf80] = await Promise.all([
      Promise.all(hotBets.map((body, index) => submitUntilAnswered(all, index, body))),
      Promise.all(Array.from({ length: 6 }, (_, index) => submitUntilAnswered(all, index, theSameBet))),
      Promise.all(
        distinct.flatMap((wallet, index) => [
          submitUntilAnswered(all, index, wager(wallet, { money: BRL('15.00') })),
          submitUntilAnswered(all, index + 1, wager(wallet, { money: BRL('15.00') })),
        ]),
      ),
      // A BET then its REFUND, each on a different instance.
      (async () => {
        expect((await submitUntilAnswered(all, 0, httpRefundPair.bet)).status).toBe(201);
        expect((await submitUntilAnswered(all, 1, httpRefundPair.reversal)).status).toBe(201);
      })(),
      // Out of order: the REFUND first (202, waits), then its BET by SQS; some worker finishes it.
      (async () => {
        const answer = await submitUntilAnswered(all, 2, outOfOrderPair.reversal);
        outOfOrderBetMessage = wagerMessage(outOfOrder, outOfOrderPair.bet);
        await send(outOfOrderBetMessage);
        return answer;
      })(),
      // Spec 8, literally: two BETs of 80.00 on a wallet of 100.00, one on instance 1 and one on instance 2.
      Promise.all([0, 1].map((index) => submitUntilAnswered(all, index, wager(twoBetsOf80, { money: BRL('80.00') })))),
    ]);

    const wallets = [hot, sameBet, reversals, outOfOrder, twoBetsOf80, ...distinct];
    await waitUntilSettled(orm, sqs, queues, wallets.map((wallet) => wallet.id));
    console.info('[multi-instance] SQS messages processed per instance:', processedPerInstance(instances));

    // Hot wallet: 30 BETs of 10.00 for 100.00, whatever the channel or the instance: exactly 10 debits.
    expect(await outcomesOf(orm, hot.id)).toEqual({ 'BET PROCESSED': 10, 'BET REJECTED': 20 });
    expect(hotAnswers.every((answer) => answer.status === 201 || answer.status === 422)).toBe(true);
    expect(await countRows(orm, 'wager_transactions', `wallet_id = '${hot.id}' and status = 'REJECTED' and failure_code <> 'INSUFFICIENT_FUNDS'`)).toBe(0);
    await expectWalletConsistent(orm, urlOf(1), hot.id, '0.00');

    // The same BET 8 times over 3 instances and 2 channels: one transaction, one debit.
    expect(sameBetAnswers.filter((answer) => answer.status === 201).length).toBeLessThanOrEqual(1);
    expect(new Set(sameBetAnswers.map((answer) => answer.body.transactionId)).size).toBe(1);
    expect(await outcomesOf(orm, sameBet.id)).toEqual({ 'BET PROCESSED': 1 });
    await expectWalletConsistent(orm, urlOf(2), sameBet.id, '70.00');

    // Spec 8 over two processes: one 201, one 422 INSUFFICIENT_FUNDS, one debit, 20.00 left.
    expect(betsOf80.map((answer) => answer.status).sort()).toEqual([201, 422]);
    expect(betsOf80.find((answer) => answer.status === 422)?.body.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(await outcomesOf(orm, twoBetsOf80.id)).toEqual({ 'BET PROCESSED': 1, 'BET REJECTED': 1 });
    await expectWalletConsistent(orm, urlOf(0), twoBetsOf80.id, '20.00');

    for (const wallet of distinct) {
      expect(await outcomesOf(orm, wallet.id)).toEqual({ 'BET PROCESSED': 4 });
      await expectWalletConsistent(orm, urlOf(0), wallet.id, '50.00');
    }

    expect(await outcomesOf(orm, reversals.id)).toEqual({ 'BET PROCESSED': 2, 'REFUND PROCESSED': 1, 'ROLLBACK PROCESSED': 1 });
    await expectWalletConsistent(orm, urlOf(0), reversals.id, '100.00');

    expect(refundBeforeBet.status).toBe(202);
    expect((await transactionByExternalId(orm, outOfOrderPair.reversal.externalTransactionId))?.status).toBe('PROCESSED');
    await expectWalletConsistent(orm, urlOf(1), outOfOrder.id, '100.00');

    // Every message was taken once into the inbox; nothing is left in the queue or the DLQ.
    for (const message of messages) {
      expect(await inboxRows(orm, message.messageId)).toEqual([expect.objectContaining({ processed: true })]);
    }
    expect(await isEmpty(sqs, queues.wager.url)).toBe(true);
    expect(await isEmpty(sqs, queues.wager.deadLetterUrl)).toBe(true);

    // Every event of these wallets is marked published AND is in the events queue, once.
    const outbox = await outboxRowsOf(orm, wallets.map((wallet) => wallet.id));
    expect(outbox.every((row) => row.published)).toBe(true);
    const received = await receiveEvents(sqs, queues.events, outbox.length);
    expect(new Set(received.map((event) => event.eventId))).toEqual(new Set(outbox.map((row) => row.id)));
    expect(received).toHaveLength(outbox.length);
  });
});
