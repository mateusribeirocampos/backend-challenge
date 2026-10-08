import { randomUUID } from 'node:crypto';
import { CreateQueueCommand, DeleteQueueCommand, SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';

/**
 * Measures, on this machine, how fast the SQS emulator takes SendMessage on a FIFO queue,
 * first on an empty queue and again after some thousand messages. MiniStack rebuilds the
 * queue's deduplication cache (every message of the last 5 minutes) on each send, so the
 * second number is lower. The report shows both, so the outbox numbers can be read
 * against what the emulator itself can do.
 */

export interface SendProbe {
  readonly senders: number;
  readonly firstMessages: number;
  readonly firstPerSecond: number;
  /** Messages already sent to the queue when the second measure started. */
  readonly laterAfterMessages: number;
  readonly laterPerSecond: number;
}

const SENDERS = 8;
const MEASURED = 1000;
const FILLER = 5000;

export async function probeSendRate(sqs: SQSClient): Promise<SendProbe> {
  const created = await sqs.send(
    new CreateQueueCommand({ QueueName: `load-probe-${randomUUID().slice(0, 8)}.fifo`, Attributes: { FifoQueue: 'true' } }),
  );
  const queueUrl = created.QueueUrl;
  if (queueUrl === undefined) throw new Error('the probe queue has no URL');
  try {
    const firstPerSecond = await sendRate(sqs, queueUrl, MEASURED);
    await sendRate(sqs, queueUrl, FILLER);
    const laterPerSecond = await sendRate(sqs, queueUrl, MEASURED);
    return {
      senders: SENDERS,
      firstMessages: MEASURED,
      firstPerSecond,
      laterAfterMessages: MEASURED + FILLER,
      laterPerSecond,
    };
  } finally {
    await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
  }
}

/** `total` messages of about the size of an event, split among the senders; messages per second. */
async function sendRate(sqs: SQSClient, queueUrl: string, total: number): Promise<number> {
  const body = JSON.stringify({ padding: 'x'.repeat(600) });
  const sender = async (count: number) => {
    for (let index = 0; index < count; index += 1) {
      const id = randomUUID();
      await sqs.send(
        new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body, MessageGroupId: id.slice(0, 2), MessageDeduplicationId: id }),
      );
    }
  };
  const started = performance.now();
  await Promise.all(Array.from({ length: SENDERS }, () => sender(total / SENDERS)));
  return total / ((performance.now() - started) / 1000);
}
