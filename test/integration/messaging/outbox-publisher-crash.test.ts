import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createSqsClient } from '../../../src/infrastructure/messaging/sqs-client.provider.js';
import { openMigratedDatabase } from '../schema/support/schema-sql.js';
import { AppProcess } from '../support/app-process.js';
import { integrationConfig } from '../support/integration-config.js';
import { type RunningTestApp, startTestApp } from '../support/test-app.js';
import { waitUntil } from '../support/wait-until.js';
import { expectBalanceMatchesLedger, openWallet } from '../wagering/support/wagering-api.js';
import {
  allPublished,
  idOf,
  createEventsQueue,
  deleteEventsQueue,
  type EventsQueue,
  markEveryPendingEventPublished,
  outboxRowsOf,
  publisherConfig,
  publisherEnv,
  receiveEvents,
} from './support/outbox-events.js';

setDefaultTimeout(30_000);

/** Short lease, so the survivor takes over 2 s after the crash instead of 30 s. */
const LEASE_SECONDS = 2;

/**
 * The scenario of spec 11: PostgreSQL committed the events, the publisher process dies
 * (a real child process, SIGKILL, no shutdown hook runs), another instance takes over
 * once the lease expires and publishes; a duplicate send stays harmless.
 */
describe('outbox publisher: crash with the events claimed', () => {
  let orm: MikroORM;
  let sqs: SQSClient;
  let http: RunningTestApp;
  let queue: EventsQueue;
  let survivor: RunningTestApp | undefined;

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
    queue = await createEventsQueue(sqs);
  });

  afterEach(async () => {
    await survivor?.close();
    survivor = undefined;
    await deleteEventsQueue(sqs, queue);
  });

  async function crashWhilePublishing(moment: 'before-send' | 'after-send') {
    const wallet = await openWallet(http.baseUrl, '100.00'); // OPENING: 2 events of this wallet
    const [first, second] = await outboxRowsOf(orm, [wallet.id]);

    const publisher = AppProcess.spawn(
      'test/support/kill-on-publish.ts',
      publisherEnv(queue.name, {
        KILL_MOMENT: moment,
        OUTBOX_PUBLISHER_LEASE_SECONDS: String(LEASE_SECONDS),
        OUTBOX_PUBLISHER_SEND_TIMEOUT_MS: '1000',
      }),
    );
    const exit = await publisher.exited;

    expect(exit.signalCode).toBe('SIGKILL');
    expect(publisher.eventsNamed('test.killing_publisher')).toEqual([
      expect.objectContaining({ eventId: first?.id, moment }),
    ]);
    // The dead process still holds the lease on both events of the wallet; nothing is marked published.
    const afterCrash = await outboxRowsOf(orm, [wallet.id]);
    expect(afterCrash.map((row) => ({ published: row.published, leased: row.leased }))).toEqual([
      { published: false, leased: true },
      { published: false, leased: true },
    ]);
    return { wallet, first, second, leaseEndMs: afterCrash[0]?.locked_until_ms };
  }

  test('killed after the claim and before the send: another instance publishes both events once the lease expires', async () => {
    const { wallet, first, second, leaseEndMs } = await crashWhilePublishing('before-send');

    survivor = await startTestApp(publisherConfig(queue.name, { leaseSeconds: LEASE_SECONDS, sendTimeoutMs: 1_000 }));
    await waitUntil('the survivor published both events', () => allPublished(orm, [wallet.id]), 15_000);

    const rows = await outboxRowsOf(orm, [wallet.id]);
    // It waited for the lease of the dead process instead of taking the events away from it.
    expect(rows[0]?.published_at_ms).toBeGreaterThanOrEqual(leaseEndMs ?? Number.POSITIVE_INFINITY);
    const received = await receiveEvents(sqs, queue, 2);
    expect(received.map((event) => event.eventId)).toEqual([idOf(first), idOf(second)]);
    await expectBalanceMatchesLedger(orm, http.baseUrl, wallet.id, '100.00');
  });

  test('killed after the send and before marking it: the survivor sends it again, and the copy is dropped by its deduplication id', async () => {
    const { wallet, first, second } = await crashWhilePublishing('after-send');

    survivor = await startTestApp(publisherConfig(queue.name, { leaseSeconds: LEASE_SECONDS, sendTimeoutMs: 1_000 }));
    await waitUntil('the survivor published both events', () => allPublished(orm, [wallet.id]), 15_000);

    // The first event was sent twice (by the dead process and by the survivor) with the
    // same MessageDeduplicationId: the queue holds it once, still before the second.
    const received = await receiveEvents(sqs, queue, 2);
    expect(received.map((event) => event.eventId)).toEqual([idOf(first), idOf(second)]);
    expect(received.map((event) => event.deduplicationId)).toEqual([idOf(first), idOf(second)]);
    await expectBalanceMatchesLedger(orm, http.baseUrl, wallet.id, '100.00');
  });
});
