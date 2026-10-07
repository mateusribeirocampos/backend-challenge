import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  type MessageAttributeValue,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { DeadLetterReason } from './processing-failure.js';

/** A message as the consumer received it, with what it needs to answer SQS later. */
export interface ReceivedMessage {
  /** SQS's own id. Stable across redeliveries of the same message. */
  readonly sqsMessageId: string;
  /** Changes on every delivery; delete and visibility calls need the latest one. */
  readonly receiptHandle: string;
  readonly body: string;
  /** MessageGroupId. Producers use the walletId, so one wallet is one ordered group. */
  readonly groupId: string;
  /** ApproximateReceiveCount: 1 on the first delivery. */
  readonly receiveCount: number;
}

export interface DeadLetter {
  readonly reason: DeadLetterReason;
  readonly errorCode: string;
  readonly detail: string;
}

/**
 * What the consumer does with a message once it knows the outcome. An interface so the
 * crash test can swap ack for "kill the process" without any hook in this code.
 */
export interface MessageActions {
  /** DeleteMessage. Called only after the SQL transaction committed. */
  ack(message: ReceivedMessage): Promise<void>;
  /** ChangeMessageVisibility(delay): deliver it again later. SQS counts the next receive. */
  retryLater(message: ReceivedMessage, delaySeconds: number): Promise<void>;
  /** ChangeMessageVisibility(0): give it back untouched, to be received right away. */
  release(message: ReceivedMessage): Promise<void>;
  /** SendMessage to the DLQ with the reason, then DeleteMessage from the source queue. */
  deadLetter(message: ReceivedMessage, letter: DeadLetter): Promise<void>;
}

export const MESSAGE_ACTIONS = Symbol('MESSAGE_ACTIONS');

export interface WagerQueueNames {
  readonly source: string;
  readonly deadLetter: string;
}

export interface WagerQueueUrls {
  readonly source: string;
  readonly deadLetter: string;
}

/**
 * Queue names come from the config; SQS calls need URLs. Resolved on first use and
 * kept, so the app can start while SQS is down and the consumer retries later.
 */
export class WagerQueues {
  private resolved: WagerQueueUrls | undefined;

  constructor(
    private readonly sqs: SQSClient,
    private readonly names: WagerQueueNames,
  ) {}

  async urls(): Promise<WagerQueueUrls> {
    if (this.resolved === undefined) {
      const [source, deadLetter] = await Promise.all([this.urlOf(this.names.source), this.urlOf(this.names.deadLetter)]);
      this.resolved = { source, deadLetter };
    }
    return this.resolved;
  }

  private async urlOf(queueName: string): Promise<string> {
    const { QueueUrl } = await this.sqs.send(new GetQueueUrlCommand({ QueueName: queueName }));
    if (QueueUrl === undefined) {
      throw new Error(`SQS returned no URL for queue ${queueName}`);
    }
    return QueueUrl;
  }
}

export class SqsMessageActions implements MessageActions {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queues: WagerQueues,
  ) {}

  async ack(message: ReceivedMessage): Promise<void> {
    const { source } = await this.queues.urls();
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: source, ReceiptHandle: message.receiptHandle }));
  }

  async retryLater(message: ReceivedMessage, delaySeconds: number): Promise<void> {
    await this.changeVisibility(message, delaySeconds);
  }

  async release(message: ReceivedMessage): Promise<void> {
    await this.changeVisibility(message, 0);
  }

  async deadLetter(message: ReceivedMessage, letter: DeadLetter): Promise<void> {
    const { source, deadLetter } = await this.queues.urls();
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: deadLetter,
        MessageBody: message.body === '' ? '(empty body)' : message.body,
        MessageGroupId: message.groupId,
        // If the delete below fails, the message comes back and is dead-lettered again;
        // the same deduplication id makes SQS drop that second copy (5 minute window).
        MessageDeduplicationId: message.sqsMessageId,
        MessageAttributes: {
          reason: text(letter.reason),
          errorCode: text(letter.errorCode),
          detail: text(letter.detail),
          sourceMessageId: text(message.sqsMessageId),
          receiveCount: text(String(message.receiveCount)),
        },
      }),
    );
    // Deleted only once the copy is in the DLQ: a failure above leaves it in the source queue.
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: source, ReceiptHandle: message.receiptHandle }));
  }

  private async changeVisibility(message: ReceivedMessage, visibilityTimeout: number): Promise<void> {
    const { source } = await this.queues.urls();
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: source,
        ReceiptHandle: message.receiptHandle,
        VisibilityTimeout: visibilityTimeout,
      }),
    );
  }
}

/** SQS refuses an empty attribute value. */
function text(value: string): MessageAttributeValue {
  return { DataType: 'String', StringValue: value === '' ? '-' : value };
}
