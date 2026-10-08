import { DeleteMessageBatchCommand, ReceiveMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';

/**
 * Plays the downstream consumer of wagering-events.fifo. Two reasons:
 * 1. In production someone reads the events. Without a reader the queue only grows, and
 *    MiniStack's SendMessage slows down with the queue depth (measured: about 1 ms per
 *    send on an empty queue, 13 ms with 80 000 messages in it), which would make the
 *    outbox look slower than it is.
 * 2. It lets the run check, end to end, that every published event reached the queue.
 *    A second copy (same eventId) is allowed: delivery is at-least-once.
 */
export class EventsDrainer {
  private readonly eventIds = new Set<string>();
  private copies = 0;
  private running = false;
  private loops: Promise<void>[] = [];

  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
    private readonly pollers = 4,
  ) {}

  start(): void {
    this.running = true;
    this.loops = Array.from({ length: this.pollers }, () => this.poll());
  }

  async stop(): Promise<void> {
    this.running = false;
    await Promise.all(this.loops);
  }

  has(eventId: string): boolean {
    return this.eventIds.has(eventId);
  }

  /** Distinct events received so far. */
  received(): number {
    return this.eventIds.size;
  }

  /** Messages received whose eventId had already arrived. */
  duplicateCopies(): number {
    return this.copies;
  }

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        await this.receiveOnce();
      } catch {
        await Bun.sleep(100); // the emulator hiccuped; the messages come back after the visibility timeout
      }
    }
  }

  private async receiveOnce(): Promise<void> {
    const { Messages = [] } = await this.sqs.send(
      new ReceiveMessageCommand({ QueueUrl: this.queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, VisibilityTimeout: 30 }),
    );
    if (Messages.length === 0) return;
    for (const message of Messages) {
      const { eventId } = JSON.parse(message.Body ?? '{}') as { eventId?: string };
      if (eventId === undefined) continue;
      if (this.eventIds.has(eventId)) this.copies += 1;
      this.eventIds.add(eventId);
    }
    await this.sqs.send(
      new DeleteMessageBatchCommand({
        QueueUrl: this.queueUrl,
        Entries: Messages.map((message, index) => ({ Id: String(index), ReceiptHandle: message.ReceiptHandle })),
      }),
    );
  }
}
