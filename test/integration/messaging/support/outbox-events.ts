import { randomUUID } from 'node:crypto';
import { CreateQueueCommand, DeleteMessageCommand, DeleteQueueCommand, ReceiveMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { AppConfig, OutboxPublisherConfig } from '../../../../src/infrastructure/config/app-config.js';
import { query } from '../../schema/support/schema-sql.js';
import { integrationConfig } from '../../support/integration-config.js';

/**
 * Helpers for the outbox publisher tests: a FIFO events queue per test, what the
 * outbox holds for some wallets, and what reached the queue.
 */

export interface EventsQueue {
  readonly name: string;
  readonly url: string;
}

/** A name for an events queue that does not exist yet (createEventsQueue creates it). */
export function newEventsQueueName(): string {
  return `wagering-events-test-${randomUUID().slice(0, 8)}.fifo`;
}

export async function createEventsQueue(sqs: SQSClient, name = newEventsQueueName()): Promise<EventsQueue> {
  const created = await sqs.send(
    new CreateQueueCommand({ QueueName: name, Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' } }),
  );
  if (created.QueueUrl === undefined) throw new Error(`SQS did not return the URL of ${name}`);
  return { name, url: created.QueueUrl };
}

export async function deleteEventsQueue(sqs: SQSClient, queue: EventsQueue): Promise<void> {
  await sqs.send(new DeleteQueueCommand({ QueueUrl: queue.url }));
}

/** The test config with the outbox publisher ON, sending to the given queue, polling fast. */
export function publisherConfig(eventsQueueName: string, publisher: Partial<OutboxPublisherConfig> = {}): AppConfig {
  const base = integrationConfig();
  return {
    ...base,
    sqs: { ...base.sqs, eventsQueueName },
    outboxPublisher: { ...base.outboxPublisher, enabled: true, pollIntervalMs: 20, ...publisher },
  };
}

/** Env for a child process running the app with the publisher ON. */
export function publisherEnv(eventsQueueName: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    DATABASE_NAME: integrationConfig().database.dbName,
    SQS_CONSUMER_ENABLED: 'false',
    SQS_EVENTS_QUEUE_NAME: eventsQueueName,
    OUTBOX_PUBLISHER_ENABLED: 'true',
    OUTBOX_PUBLISHER_POLL_INTERVAL_MS: '20',
    ...extra,
  };
}

/**
 * The test database keeps the events of every earlier test, unpublished (nothing
 * published them before Slice 4). A publisher started by a test would send all of them;
 * marking them published first leaves only the test's own events to publish.
 */
export async function markEveryPendingEventPublished(orm: MikroORM): Promise<void> {
  await query(
    orm,
    `update outbox_messages set published_at = now(), locked_until = null, lease_token = null where published_at is null`,
  );
}

export interface OutboxRow {
  readonly id: string;
  readonly aggregate_id: string;
  readonly event_type: string;
  readonly attempts: number;
  readonly published: boolean;
  readonly leased: boolean;
  /** Epoch milliseconds (database clock), or null. */
  readonly locked_until_ms: number | null;
  readonly published_at_ms: number | null;
}

/** The outbox rows of these wallets, in the order they were written. */
export async function outboxRowsOf(orm: MikroORM, walletIds: readonly string[]): Promise<OutboxRow[]> {
  const ids = walletIds.map((id) => `'${id}'`).join(', ');
  return query<OutboxRow>(
    orm,
    `select id, aggregate_id, event_type, attempts, published_at is not null as published,
            locked_until is not null and locked_until > now() as leased,
            (extract(epoch from locked_until) * 1000)::float8 as locked_until_ms,
            (extract(epoch from published_at) * 1000)::float8 as published_at_ms
       from outbox_messages
      where aggregate_id in (${ids})
      order by sequence_number`,
  );
}

/** The id of a row a test expects to exist (a missing row fails the comparison instead of the type check). */
export function idOf(row: { readonly id: string } | undefined): string {
  return row?.id ?? '(missing row)';
}

export async function allPublished(orm: MikroORM, walletIds: readonly string[]): Promise<boolean> {
  return (await outboxRowsOf(orm, walletIds)).every((row) => row.published);
}

export interface ReceivedEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly groupId: string | undefined;
  readonly deduplicationId: string | undefined;
}

/**
 * Receives (and deletes) from the events queue until `expected` distinct events
 * arrived, then keeps polling for one more second so a duplicate copy would show up too.
 */
export async function receiveEvents(sqs: SQSClient, queue: EventsQueue, expected: number, timeoutMs = 15_000): Promise<ReceivedEvent[]> {
  const received: ReceivedEvent[] = [];
  const deadline = Date.now() + timeoutMs;
  let extraPollDone = false;
  while (Date.now() < deadline) {
    const distinct = new Set(received.map((event) => event.eventId)).size;
    if (distinct >= expected) {
      if (extraPollDone) return received;
      extraPollDone = true;
    }
    const { Messages } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queue.url,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        VisibilityTimeout: 30,
        MessageSystemAttributeNames: ['MessageGroupId', 'MessageDeduplicationId'],
      }),
    );
    for (const message of Messages ?? []) {
      const body = JSON.parse(message.Body ?? '{}') as { eventId: string; eventType: string; aggregateId: string };
      received.push({
        eventId: body.eventId,
        eventType: body.eventType,
        aggregateId: body.aggregateId,
        groupId: message.Attributes?.MessageGroupId,
        deduplicationId: message.Attributes?.MessageDeduplicationId,
      });
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queue.url, ReceiptHandle: message.ReceiptHandle }));
    }
  }
  throw new Error(`only ${new Set(received.map((event) => event.eventId)).size} of ${expected} events arrived in ${timeoutMs} ms`);
}
