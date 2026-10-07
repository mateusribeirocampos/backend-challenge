import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { AppConfig, WagerConsumerConfig } from '../../../../src/infrastructure/config/app-config.js';
import { integrationConfig } from '../../support/integration-config.js';

/** Same limit as docker/ministack/init-queues.sh. */
export const MAX_RECEIVE_COUNT = 10;

export interface TestQueues {
  readonly name: string;
  readonly url: string;
  readonly deadLetterName: string;
  readonly deadLetterUrl: string;
}

/**
 * A FIFO queue and its own DLQ, created for one test and deleted after it, with the
 * same redrive policy as the real queue. Nothing a test leaves behind (an invisible
 * message, a dead letter) can reach another test, and no purge is needed.
 */
export async function createTestQueues(
  sqs: SQSClient,
  options: { maxReceiveCount?: number } = {},
): Promise<TestQueues> {
  const suffix = randomUUID().slice(0, 8);
  const deadLetterName = `wager-test-${suffix}-dlq.fifo`;
  const name = `wager-test-${suffix}.fifo`;

  const deadLetter = await sqs.send(
    new CreateQueueCommand({ QueueName: deadLetterName, Attributes: { FifoQueue: 'true' } }),
  );
  const deadLetterUrl = required(deadLetter.QueueUrl, deadLetterName);
  const attributes = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: deadLetterUrl, AttributeNames: ['QueueArn'] }));
  const deadLetterArn = required(attributes.Attributes?.QueueArn, `${deadLetterName} arn`);

  const source = await sqs.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: deadLetterArn,
          maxReceiveCount: options.maxReceiveCount ?? MAX_RECEIVE_COUNT,
        }),
      },
    }),
  );
  return { name, url: required(source.QueueUrl, name), deadLetterName, deadLetterUrl };
}

export async function deleteTestQueues(sqs: SQSClient, queues: TestQueues): Promise<void> {
  await sqs.send(new DeleteQueueCommand({ QueueUrl: queues.url }));
  await sqs.send(new DeleteQueueCommand({ QueueUrl: queues.deadLetterUrl }));
}

/**
 * The test config with the consumer ON and pointed at the test queues. The long poll
 * is 1 s: closing the app waits for the poll in progress, so a short one keeps tests fast.
 */
export function consumerConfig(queues: TestQueues, consumer: Partial<WagerConsumerConfig> = {}): AppConfig {
  const base = integrationConfig();
  return {
    ...base,
    sqs: {
      ...base.sqs,
      wagerQueueName: queues.name,
      wagerDeadLetterQueueName: queues.deadLetterName,
      consumer: { ...base.sqs.consumer, enabled: true, waitTimeSeconds: 1, ...consumer },
    },
  };
}

/** Environment for a child process running the app against the test queues. */
export function consumerEnv(queues: TestQueues, extra: Record<string, string> = {}): Record<string, string> {
  return {
    DATABASE_NAME: integrationConfig().database.dbName,
    SQS_WAGER_QUEUE_NAME: queues.name,
    SQS_WAGER_DLQ_NAME: queues.deadLetterName,
    SQS_CONSUMER_ENABLED: 'true',
    SQS_CONSUMER_WAIT_TIME_SECONDS: '1',
    ...extra,
  };
}

export interface SendOptions {
  /** MessageGroupId. Producers use the walletId. */
  readonly groupId: string;
  /** MessageDeduplicationId. Random by default, so SQS never hides a copy the test sends on purpose. */
  readonly deduplicationId?: string;
}

export async function sendRaw(sqs: SQSClient, queueUrl: string, body: string, options: SendOptions): Promise<string> {
  const sent = await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: options.groupId,
      MessageDeduplicationId: options.deduplicationId ?? randomUUID(),
    }),
  );
  return required(sent.MessageId, 'MessageId');
}

export interface QueueDepth {
  /** Ready to be received. */
  readonly visible: number;
  /** Received and not deleted yet (in flight, or waiting for a retry). */
  readonly inFlight: number;
}

export async function queueDepth(sqs: SQSClient, queueUrl: string): Promise<QueueDepth> {
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return {
    visible: Number.parseInt(Attributes?.ApproximateNumberOfMessages ?? '0', 10),
    inFlight: Number.parseInt(Attributes?.ApproximateNumberOfMessagesNotVisible ?? '0', 10),
  };
}

export async function isEmpty(sqs: SQSClient, queueUrl: string): Promise<boolean> {
  const depth = await queueDepth(sqs, queueUrl);
  return depth.visible === 0 && depth.inFlight === 0;
}

/** Receives (and so hides) what is in the DLQ, with the attributes the consumer wrote. */
export async function receiveDeadLetters(sqs: SQSClient, queues: TestQueues): Promise<Message[]> {
  const { Messages } = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queues.deadLetterUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
      VisibilityTimeout: 60,
      MessageAttributeNames: ['All'],
      MessageSystemAttributeNames: ['All'],
    }),
  );
  return Messages ?? [];
}

export function attribute(message: Message, name: string): string | undefined {
  return message.MessageAttributes?.[name]?.StringValue;
}

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`SQS did not return ${what}`);
  return value;
}
