import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { Server } from 'bun';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { MetricName } from '../../../src/application/ports/metrics.js';
import type { SqsConfig } from '../../../src/infrastructure/config/app-config.js';
import { createSqsClient } from '../../../src/infrastructure/messaging/sqs-client.provider.js';
import { SqsEventPublisher } from '../../../src/infrastructure/messaging/sqs-event-publisher.js';
import { InMemoryMetrics } from '../../../src/infrastructure/observability/in-memory-metrics.js';
import { OutboxMessage } from '../../../src/domain/outbox/outbox-message.js';
import { DeadLetterReason } from '../../../src/interfaces/messaging/processing-failure.js';
import { SqsMessageActions, WagerQueues } from '../../../src/interfaces/messaging/sqs-message-actions.js';
import { SqsWagerConsumer } from '../../../src/interfaces/messaging/sqs-wager-consumer.js';
import { CapturingLogger } from '../support/capturing-logger.js';
import { integrationConfig } from '../support/integration-config.js';
import { waitUntil } from '../support/wait-until.js';

setDefaultTimeout(15_000);

const REQUEST_TIMEOUT_MS = 300;
const WAIT_TIME_SECONDS = 1;

/**
 * An SQS endpoint that accepts the connection and the request and then never answers
 * (a hung load balancer, a frozen emulator). Only GetQueueUrl is answered, so the hang
 * lands exactly on the call under test. Not MiniStack: MiniStack always answers.
 */
function silentSqsEndpoint(): { server: Server<undefined>; hungCalls: string[] } {
  const hungCalls: string[] = [];
  const server: Server<undefined> = Bun.serve({
    port: 0,
    idleTimeout: 0, // Bun would otherwise close the idle connection itself after 10 s
    fetch(request): Response | Promise<Response> {
      const target = request.headers.get('x-amz-target') ?? '';
      if (target.endsWith('.GetQueueUrl')) {
        const queueUrl = `http://127.0.0.1:${server.port}/000000000000/silent.fifo`;
        return Response.json({ QueueUrl: queueUrl }, { headers: { 'content-type': 'application/x-amz-json-1.0' } });
      }
      hungCalls.push(target.replace('AmazonSQS.', ''));
      return new Promise<Response>(() => {}); // never answers
    },
  });
  return { server, hungCalls };
}

describe('SQS client against an endpoint that never answers', () => {
  let endpoint: ReturnType<typeof silentSqsEndpoint>;
  let sqs: SQSClient;

  beforeEach(() => {
    endpoint = silentSqsEndpoint();
    const config: SqsConfig = {
      ...integrationConfig().sqs,
      endpoint: endpoint.server.url.origin,
      connectionTimeoutMs: 200,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    };
    sqs = createSqsClient(config);
  });

  afterEach(async () => {
    sqs.destroy();
    await endpoint.server.stop(true);
  });

  test('the consumer receive fails after long poll + request timeout, backs off, keeps polling and still stops', async () => {
    const logger = new CapturingLogger();
    const metrics = new InMemoryMetrics();
    const queues = new WagerQueues(sqs, { source: 'silent.fifo', deadLetter: 'silent.fifo' });
    const consumer = new SqsWagerConsumer(
      sqs,
      queues,
      { handle: () => Promise.reject(new Error('no message can arrive from a silent endpoint')) },
      new SqsMessageActions(sqs, queues),
      {
        maxMessages: 10,
        visibilityTimeoutSeconds: 30,
        waitTimeSeconds: WAIT_TIME_SECONDS,
        receiveRequestTimeoutMs: WAIT_TIME_SECONDS * 1000 + REQUEST_TIMEOUT_MS,
        shutdownTimeoutMs: 5_000,
        retry: { baseDelaySeconds: 1, maxDelaySeconds: 1, random: () => 0 },
        receiveBackoff: { baseDelaySeconds: 1, maxDelaySeconds: 1, random: () => 0 },
      },
      logger,
      metrics,
    );

    const started = Date.now();
    consumer.start();
    await waitUntil('the first receive gives up', () => logger.events('wager_consumer.receive_failed').length >= 1, 5_000);
    const firstFailureMs = Date.now() - started;
    // Not the short timeout of the other calls: a long poll may legitimately take the whole wait time.
    expect(firstFailureMs).toBeGreaterThanOrEqual(WAIT_TIME_SECONDS * 1000);
    expect(firstFailureMs).toBeLessThan(3_000);

    await waitUntil('a second receive after the backoff also gives up', () =>
      metrics.value(MetricName.ConsumerSqsErrors, { operation: 'receive' }) >= 2,
    );
    expect(endpoint.hungCalls.filter((call) => call === 'ReceiveMessage').length).toBeGreaterThanOrEqual(2);

    await consumer.stop();
    expect(logger.events('wager_consumer.stopped')[0]?.fields).toEqual({ drained: true });
  });

  test('delete, visibility and DLQ calls fail within the request timeout instead of hanging', async () => {
    const queues = new WagerQueues(sqs, { source: 'silent.fifo', deadLetter: 'silent.fifo' });
    const actions = new SqsMessageActions(sqs, queues);
    const message = { sqsMessageId: 'm-1', receiptHandle: 'r-1', body: '{}', groupId: 'g-1', receiveCount: 1 };
    const letter = { reason: DeadLetterReason.SchemaInvalid, errorCode: 'X', detail: '-' };

    for (const call of [
      () => actions.ack(message),
      () => actions.release(message),
      () => actions.deadLetter(message, letter),
    ]) {
      const started = Date.now();
      await expect(call()).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(REQUEST_TIMEOUT_MS + 700);
    }
    expect(endpoint.hungCalls).toEqual(['DeleteMessage', 'ChangeMessageVisibility', 'SendMessage']);
  });

  test('the outbox publisher send fails within its timeout', async () => {
    const publisher = new SqsEventPublisher(sqs, 'silent.fifo', 2_000);
    const event = OutboxMessage.rehydrate({
      id: '0d9b8c1e-6f4a-4b8e-9c3a-2f1e5d7c9a01',
      aggregateId: '7c1f0a2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b',
      eventType: 'wager.bet_debited',
      payload: { any: 'thing' },
      occurredAt: new Date(),
      attempts: 0,
      nextAttemptAt: new Date(),
      publishedAt: undefined,
    });

    const started = Date.now();
    await expect(publisher.publish(event)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000 + 500);
    expect(endpoint.hungCalls).toEqual(['SendMessage']);
  });
});
