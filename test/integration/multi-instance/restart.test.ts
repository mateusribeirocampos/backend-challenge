import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createSqsClient } from '../../../src/infrastructure/messaging/sqs-client.provider.js';
import {
  allPublished,
  createEventsQueue,
  deleteEventsQueue,
  markEveryPendingEventPublished,
} from '../messaging/support/outbox-events.js';
import { createTestQueues, deleteTestQueues, isEmpty, queueDepth } from '../messaging/support/sqs-test-queues.js';
import { inboxRows, sendWagerMessage, transactionByExternalId, wagerMessage, type WagerEnvelope } from '../messaging/support/wager-messages.js';
import { DedicatedConnection, type Settled, settle } from '../schema/support/dedicated-connection.js';
import { openMigratedDatabase, query } from '../schema/support/schema-sql.js';
import { integrationConfig } from '../support/integration-config.js';
import { type RunningTestApp, startTestApp } from '../support/test-app.js';
import { waitUntil } from '../support/wait-until.js';
import { parkOtherPendingReferences, referenceWaitOf } from '../wagering/support/pending-references.js';
import { type HttpResult, type OpenedWallet, openWallet, submit, wager, type WagerBody } from '../wagering/support/wagering-api.js';
import {
  type ClusterQueues,
  expectWalletConsistent,
  type Instance,
  killAllInstances,
  outcomesOf,
  processedPerInstance,
  startInstance,
  startInstances,
  submitUntilAnswered,
  waitUntilSettled,
} from './support/cluster.js';

setDefaultTimeout(60_000);

const BRL = (amount: string) => ({ amount, currency: 'BRL' });

/** How many backends wait right now for a lock held by `holder`. */
async function waitersOf(orm: MikroORM, holder: DedicatedConnection): Promise<number> {
  const [row] = await query<{ count: number }>(
    orm,
    `select count(*)::int as count from pg_stat_activity where ${holder.pid} = any(pg_blocking_pids(pid))`,
  );
  return row?.count ?? 0;
}

/**
 * Spec 13 item 8 and "recuperação após reinicialização": one of three instances is
 * killed with SIGKILL while it holds an SQS message and an HTTP request, a new process
 * replaces it, and later every instance is stopped and fresh ones finish what was left.
 */
describe('restart: an instance killed in the middle of the load, then a full restart (spec 13 item 8)', () => {
  let orm: MikroORM;
  let sqs: SQSClient;
  let queues: ClusterQueues;
  let writer: RunningTestApp | undefined;

  beforeAll(async () => {
    orm = await openMigratedDatabase();
    sqs = createSqsClient(integrationConfig().sqs);
  });

  afterAll(async () => {
    sqs.destroy();
    await orm.close(true);
  });

  beforeEach(async () => {
    await markEveryPendingEventPublished(orm);
    await parkOtherPendingReferences(orm);
    queues = { wager: await createTestQueues(sqs), events: await createEventsQueue(sqs) };
  });

  afterEach(async () => {
    await killAllInstances();
    await writer?.close();
    writer = undefined;
    await deleteTestQueues(sqs, queues.wager);
    await deleteEventsQueue(sqs, queues.events);
  });

  test('SIGKILL with work in hand, a replacement process, then SIGTERM of all and fresh processes: nothing lost, nothing doubled', async () => {
    let instances = await startInstances(['instance-1', 'instance-2', 'instance-3'], queues);
    const live = () => instances;

    const crash = await openWallet(instances[0]?.baseUrl ?? '', '100.00');
    const load: OpenedWallet[] = [];
    for (let index = 0; index < 3; index += 1) {
      load.push(await openWallet(instances[index]?.baseUrl ?? '', '100.00'));
    }
    const messages: WagerEnvelope[] = [];
    const send = async (message: WagerEnvelope) => {
      messages.push(message);
      await sendWagerMessage(sqs, queues.wager.url, message);
    };

    // 1. Hold the crash wallet's row, so whoever takes its message is stuck with it in hand.
    const holder = await DedicatedConnection.open();
    let refund: WagerBody;
    let refundOnVictim: Promise<Settled<HttpResult>>;
    let victim: Instance;
    let wave: Promise<HttpResult[]>;
    const betInHand = wagerMessage(crash, { money: BRL('30.00') });
    try {
      await holder.run('begin');
      await holder.run(`select id from wallets where id = '${crash.id}' for no key update`);
      await send(betInHand);
      for (const wallet of load) {
        await send(wagerMessage(wallet, { money: BRL('10.00') }));
      }

      // 2. The instance that logs a lock retry for that message is the one holding it: the victim.
      victim = await Promise.any(
        instances.map(async (instance) => {
          await instance.process.waitForEvent('wager_message.contention_retry', 10_000, (line) => line.messageId === betInHand.messageId);
          return instance;
        }),
      );
      // The REFUND of that BET goes to the victim by HTTP and gets stuck on the same row.
      refund = wager(crash, {
        kind: 'REFUND',
        roundId: betInHand.data.roundId,
        money: BRL('30.00'),
        referenceExternalTransactionId: betInHand.data.externalTransactionId,
      });
      refundOnVictim = settle(submit(victim.baseUrl, refund));
      await waitUntil('the message and the HTTP request of the victim both wait for the row', async () => (await waitersOf(orm, holder)) >= 2);

      // 3. A wave of HTTP BETs over the 3 instances, and the victim dies in the middle of it.
      const waveBets = load.flatMap((wallet) => Array.from({ length: 4 }, () => wager(wallet, { money: BRL('5.00') })));
      wave = Promise.all(waveBets.map((body, index) => submitUntilAnswered(live, index, body)));
      victim.process.signal('SIGKILL');
      expect((await victim.process.exited).signalCode).toBe('SIGKILL');
      await holder.run('commit');
    } finally {
      await holder.close();
    }

    // The HTTP request in hand got no answer: the provider resends it, same key, to a survivor.
    expect((await refundOnVictim).ok).toBe(false);
    instances = instances.filter((instance) => instance !== victim);
    const refundRetry = await submitUntilAnswered(live, 0, refund);
    // Its BET is still invisible in the queue (held by the dead process until the visibility timeout).
    expect(refundRetry.status).toBe(202);

    // 4. A new process takes the dead one's place.
    const replacement = await startInstance('instance-4 (replacement)', queues);
    instances = [...instances, replacement];
    const afterRestart = wager(load[0] as OpenedWallet, { money: BRL('5.00') });
    expect((await submit(replacement.baseUrl, afterRestart)).status).toBe(201);

    const waveAnswers = await wave;
    expect(waveAnswers.every((answer) => answer.status === 201)).toBe(true); // 3 wallets x 4 x 5.00, all fit
    await waitUntilSettled(orm, sqs, queues, [crash.id, ...load.map((wallet) => wallet.id)]);
    console.info('[multi-instance] SQS messages processed per instance:', processedPerInstance([victim, ...instances]));

    // The BET the victim held was redelivered and applied once, by someone else.
    expect(victim.process.eventsNamed('wager_message.processed').map((line) => line.messageId)).not.toContain(betInHand.messageId);
    const redelivered = instances
      .flatMap((instance) => instance.process.eventsNamed('wager_message.processed'))
      .filter((line) => line.messageId === betInHand.messageId);
    expect(redelivered).toEqual([expect.objectContaining({ status: 'PROCESSED' })]);
    expect(Number(redelivered[0]?.receiveCount)).toBeGreaterThanOrEqual(2);
    // The REFUND accepted with 202 was finished by a worker once its BET existed.
    expect((await referenceWaitOf(orm, refund.externalTransactionId))?.status).toBe('PROCESSED');
    expect(await outcomesOf(orm, crash.id)).toEqual({ 'BET PROCESSED': 1, 'REFUND PROCESSED': 1 });
    await expectWalletConsistent(orm, replacement.baseUrl, crash.id, '100.00');
    // Load wallets: 100.00 - 10.00 (SQS) - 4 x 5.00 (wave); the first one also got 5.00 after the restart.
    for (const [index, wallet] of load.entries()) {
      expect(await outcomesOf(orm, wallet.id)).toEqual({ 'BET PROCESSED': index === 0 ? 6 : 5 });
      await expectWalletConsistent(orm, replacement.baseUrl, wallet.id, index === 0 ? '65.00' : '70.00');
    }
    for (const message of messages) {
      expect(await inboxRows(orm, message.messageId)).toEqual([expect.objectContaining({ processed: true })]);
    }
    expect(await isEmpty(sqs, queues.wager.deadLetterUrl)).toBe(true);

    // 5. Full restart: SIGTERM to every instance. Work is left behind while nothing runs.
    for (const instance of instances) {
      instance.process.signal('SIGTERM');
    }
    for (const instance of instances) {
      const exit = await instance.process.exited;
      expect(exit.signalCode ?? exit.exitCode).toBe('SIGTERM');
    }
    // An app with the consumer, the publisher and the worker OFF writes what the next processes must finish.
    writer = await startTestApp(integrationConfig());
    const late = await openWallet(writer.baseUrl, '100.00');
    const lateBet = wager(late, { money: BRL('20.00') });
    const lateRefund = wager(late, {
      kind: 'REFUND',
      roundId: lateBet.roundId,
      money: BRL('20.00'),
      referenceExternalTransactionId: lateBet.externalTransactionId,
    });
    expect((await submit(writer.baseUrl, lateRefund)).status).toBe(202);
    const lateBetMessage = wagerMessage(late, lateBet);
    await send(lateBetMessage);
    expect(await queueDepth(sqs, queues.wager.url)).toEqual({ visible: 1, inFlight: 0 });
    expect(await allPublished(orm, [late.id])).toBe(false);

    const fresh = await startInstances(['instance-5', 'instance-6', 'instance-7'], queues);
    await waitUntilSettled(orm, sqs, queues, [late.id]);

    expect((await transactionByExternalId(orm, lateBet.externalTransactionId))?.status).toBe('PROCESSED');
    expect((await referenceWaitOf(orm, lateRefund.externalTransactionId))?.status).toBe('PROCESSED');
    expect(await inboxRows(orm, lateBetMessage.messageId)).toEqual([expect.objectContaining({ processed: true })]);
    await expectWalletConsistent(orm, fresh[0]?.baseUrl ?? '', late.id, '100.00');
    // The wallets of the first part did not move during the restart.
    await expectWalletConsistent(orm, fresh[1]?.baseUrl ?? '', crash.id, '100.00');
  });
});
