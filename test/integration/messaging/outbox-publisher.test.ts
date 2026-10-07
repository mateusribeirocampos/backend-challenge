import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { PublishOutbox } from '../../../src/application/outbox/publish-outbox.js';
import { MetricName } from '../../../src/application/ports/metrics.js';
import { createSqsClient } from '../../../src/infrastructure/messaging/sqs-client.provider.js';
import { openMigratedDatabase, query } from '../schema/support/schema-sql.js';
import { integrationConfig } from '../support/integration-config.js';
import { type RunningTestApp, startTestApp } from '../support/test-app.js';
import { waitUntil } from '../support/wait-until.js';
import { expectBalanceMatchesLedger, type OpenedWallet, openWallet, submit, wager } from '../wagering/support/wagering-api.js';
import {
  allPublished,
  idOf,
  createEventsQueue,
  deleteEventsQueue,
  type EventsQueue,
  markEveryPendingEventPublished,
  newEventsQueueName,
  outboxRowsOf,
  publisherConfig,
  receiveEvents,
} from './support/outbox-events.js';

setDefaultTimeout(30_000);

/**
 * Spec 11 and spec 13 ("publishers concorrentes", item 6): the outbox publisher against
 * the real PostgreSQL and the real SQS emulator, with a FIFO events queue per test.
 */
describe('outbox publisher', () => {
  let orm: MikroORM;
  let sqs: SQSClient;
  let http: RunningTestApp;

  beforeAll(async () => {
    orm = await openMigratedDatabase();
    sqs = createSqsClient(integrationConfig().sqs);
    http = await startTestApp(integrationConfig()); // publisher OFF: it only writes events
  });

  afterAll(async () => {
    await http.close();
    sqs.destroy();
    await orm.close(true);
  });

  beforeEach(async () => {
    await markEveryPendingEventPublished(orm);
  });

  describe('two publishers on the same outbox (spec 13 item 6)', () => {
    let queue: EventsQueue;
    let apps: RunningTestApp[] = [];

    beforeEach(async () => {
      queue = await createEventsQueue(sqs);
    });

    afterEach(async () => {
      await Promise.all(apps.map((app) => app.close()));
      apps = [];
      await deleteEventsQueue(sqs, queue);
    });

    test('every event is published once, none is lost, and each wallet keeps its order', async () => {
      // 6 wallets x (OPENING + 3 BETs) x 2 events = 48 events, written before any publisher runs.
      const wallets = await Promise.all(Array.from({ length: 6 }, () => openWallet(http.baseUrl, '100.00')));
      await Promise.all(wallets.map((wallet) => betThreeTimes(http.baseUrl, wallet)));
      const walletIds = wallets.map((wallet) => wallet.id);
      const written = await outboxRowsOf(orm, walletIds);
      expect(written).toHaveLength(48);

      // Two app instances, each with its own connection pool, publishing at the same
      // time in batches of 4: they compete for the same rows from the first claim on.
      const config = publisherConfig(queue.name, { enabled: false, batchSize: 4 });
      apps = await Promise.all([startTestApp(config), startTestApp(config)]);
      const [publishedByA = 0, publishedByB = 0] = await Promise.all(
        apps.map((app) => publishUntilEverythingIsOut(app.get(PublishOutbox), () => allPublished(orm, walletIds))),
      );

      // Both took part, and no event was sent twice: a claimed wallet is skipped by the
      // other publisher (SKIP LOCKED, then the lease). A second send only happens when a
      // lease runs out (30 s here), which the crash test covers.
      expect(publishedByA).toBeGreaterThan(0);
      expect(publishedByB).toBeGreaterThan(0);
      expect(publishedByA + publishedByB).toBe(48);
      expect(apps.map((app) => app.metrics.value(MetricName.OutboxDuplicatePublishes))).toEqual([0, 0]);

      const received = await receiveEvents(sqs, queue, 48);
      // None lost, none extra: exactly the events written, each with its id as deduplication id.
      expect(new Set(received.map((event) => event.eventId))).toEqual(new Set(written.map((row) => row.id)));
      // A duplicate send (if any) is dropped by SQS: same MessageDeduplicationId.
      expect(received).toHaveLength(48);
      for (const event of received) {
        expect(event.groupId).toBe(event.aggregateId);
        expect(event.deduplicationId).toBe(event.eventId);
      }
      // Per wallet, the queue holds the events in the order they were written.
      for (const walletId of walletIds) {
        expect(received.filter((event) => event.aggregateId === walletId).map((event) => event.eventId)).toEqual(
          written.filter((row) => row.aggregate_id === walletId).map((row) => row.id),
        );
      }
      expect((await outboxRowsOf(orm, walletIds)).filter((row) => row.leased)).toEqual([]);
      for (const wallet of wallets) {
        await expectBalanceMatchesLedger(orm, http.baseUrl, wallet.id, '70.00');
      }
    });
  });

  describe('SQS refuses the send', () => {
    let app: RunningTestApp | undefined;
    let queue: EventsQueue | undefined;

    afterEach(async () => {
      await app?.close();
      if (queue !== undefined) await deleteEventsQueue(sqs, queue);
      app = undefined;
      queue = undefined;
    });

    test('a failed event is not claimed again before its backoff ends: attempts stays 1 and its wallet waits', async () => {
      // Publisher driven by the test; the events queue never exists, so every send fails.
      app = await startTestApp(publisherConfig(newEventsQueueName(), { enabled: false }));
      const wallet = await openWallet(http.baseUrl, '100.00'); // 2 events
      const publisher = app.get(PublishOutbox);

      expect(await publisher.publishBatch()).toEqual({ claimed: 2, published: 0, failed: 1, released: 1 });
      const afterFailure = await retryStateOf(orm, wallet.id);
      // Retry 1 waits 0.5 to 1 s: the head is scheduled in the future.
      expect(afterFailure).toEqual([
        { attempts: 1, waiting_backoff: true },
        { attempts: 0, waiting_backoff: false },
      ]);

      // Claimed again right away: the head is not due, so the whole wallet is left alone.
      expect((await publisher.publishBatch()).claimed).toBe(0);
      expect(await retryStateOf(orm, wallet.id)).toEqual(afterFailure);
      await expectBalanceMatchesLedger(orm, http.baseUrl, wallet.id, '100.00');
    });

    test('the event gets a retry with backoff, the wallet waits for it, and it is published once SQS accepts', async () => {
      // The events queue does not exist yet: every SendMessage fails (QueueDoesNotExist).
      const queueName = newEventsQueueName();
      app = await startTestApp(publisherConfig(queueName));
      const wallet = await openWallet(http.baseUrl, '100.00');

      await waitUntil('the first event failed and has a retry scheduled', async () => {
        const [first] = await outboxRowsOf(orm, [wallet.id]);
        return first !== undefined && first.attempts >= 1;
      });
      const [first, second] = await outboxRowsOf(orm, [wallet.id]);
      expect(first?.published).toBe(false);
      // The later event of the same wallet is not tried while the earlier one waits.
      expect(second).toEqual(expect.objectContaining({ attempts: 0, published: false }));
      expect(app.metrics.value(MetricName.OutboxPublishFailures)).toBeGreaterThanOrEqual(1);
      expect(app.logs.events('outbox.publish_failed')[0]?.fields).toEqual(
        expect.objectContaining({ eventId: first?.id, walletId: wallet.id, correlationId: expect.any(String) }),
      );

      queue = await createEventsQueue(sqs, queueName);

      await waitUntil('both events are published', () => allPublished(orm, [wallet.id]), 15_000);
      const received = await receiveEvents(sqs, queue, 2);
      expect(received.map((event) => event.eventId)).toEqual([idOf(first), idOf(second)]);
      expect(app.metrics.value(MetricName.OutboxPublishRetries)).toBeGreaterThanOrEqual(1);
      expect(app.metrics.value(MetricName.OutboxPublished, { event_type: 'WalletBalanceChanged' })).toBe(1);
      await expectBalanceMatchesLedger(orm, http.baseUrl, wallet.id, '100.00');
    });
  });
});

async function betThreeTimes(baseUrl: string, wallet: OpenedWallet): Promise<void> {
  for (let bet = 0; bet < 3; bet++) {
    const response = await submit(baseUrl, wager(wallet, { money: { amount: '10.00', currency: 'BRL' } }));
    expect(response.status).toBe(201);
  }
}

/**
 * Calls publishBatch until every event of the test is published. A batch that claims
 * nothing means the other publisher holds the remaining wallets: yield a moment and ask again.
 */
async function publishUntilEverythingIsOut(publisher: PublishOutbox, done: () => Promise<boolean>): Promise<number> {
  let published = 0;
  while (!(await done())) {
    const result = await publisher.publishBatch();
    published += result.published;
    if (result.claimed === 0) {
      await Bun.sleep(5);
    }
  }
  return published;
}

/** attempts and "next_attempt_at is still in the future" for each event of the wallet, in write order. */
async function retryStateOf(orm: MikroORM, walletId: string): Promise<{ attempts: number; waiting_backoff: boolean }[]> {
  return query(
    orm,
    `select attempts, next_attempt_at > now() as waiting_backoff
       from outbox_messages where aggregate_id = '${walletId}' order by sequence_number`,
  );
}
