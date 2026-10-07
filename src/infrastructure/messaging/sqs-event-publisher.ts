import { GetQueueUrlCommand, SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher } from '../../application/ports/event-publisher.js';
import type { OutboxMessage } from '../../domain/outbox/outbox-message.js';

/**
 * Sends outbox events to the events FIFO queue (wagering-events.fifo):
 *   - MessageGroupId = aggregateId (the wallet): SQS keeps one wallet's events in order;
 *   - MessageDeduplicationId = event id: a second send of the same event within SQS's
 *     5 minute window is dropped by SQS itself;
 *   - body = the envelope stored in the outbox, as is.
 * Each send (queue URL lookup included) is aborted after sendTimeoutMs, so it always
 * ends before the publisher's lease does.
 */
export class SqsEventPublisher implements EventPublisher {
  private queueUrl: string | undefined;

  constructor(
    private readonly sqs: SQSClient,
    private readonly queueName: string,
    private readonly sendTimeoutMs: number,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    const abortSignal = AbortSignal.timeout(this.sendTimeoutMs);
    const queueUrl = await this.resolveQueueUrl(abortSignal);
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
        MessageAttributes: { eventType: { DataType: 'String', StringValue: message.eventType } },
      }),
      { abortSignal },
    );
  }

  /** Looked up on first use and kept; a failed lookup (queue missing, SQS down) is tried again on the next send. */
  private async resolveQueueUrl(abortSignal: AbortSignal): Promise<string> {
    if (this.queueUrl === undefined) {
      const { QueueUrl } = await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.queueName }), { abortSignal });
      if (QueueUrl === undefined) {
        throw new Error(`SQS returned no URL for queue ${this.queueName}`);
      }
      this.queueUrl = QueueUrl;
    }
    return this.queueUrl;
  }
}
