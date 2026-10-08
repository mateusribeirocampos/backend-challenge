import { setTimeout as sleep } from 'node:timers/promises';
import { type Message, ReceiveMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { summarizeError } from '../../application/error-summary.js';
import { type Metrics, MetricName } from '../../application/ports/metrics.js';
import type { StructuredLogger } from '../../application/ports/structured-logger.js';
import { type RetryBackoffPolicy, retryDelaySeconds } from './retry-backoff.js';
import type { MessageActions, ReceivedMessage, WagerQueues } from './sqs-message-actions.js';
import type { MessageDisposition, MessageHandler } from './wager-message-handler.js';

export interface WagerConsumerSettings {
  /** Messages per ReceiveMessage. SQS allows at most 10. */
  readonly maxMessages: number;
  readonly visibilityTimeoutSeconds: number;
  readonly waitTimeSeconds: number;
  /**
   * Deadline of one ReceiveMessage: the long poll (waitTimeSeconds) plus a margin. Only
   * reached when SQS does not answer at all; then the receive fails and the loop backs off.
   */
  readonly receiveRequestTimeoutMs: number;
  /** On stop, how long to wait for the messages already being processed. */
  readonly shutdownTimeoutMs: number;
  /** Delay before a message that failed with a transient error is delivered again. */
  readonly retry: RetryBackoffPolicy;
  /** Pause of the loop after ReceiveMessage itself failed (SQS down or throttling). */
  readonly receiveBackoff: RetryBackoffPolicy;
}

/**
 * Long polling consumer of wager-transactions.fifo (spec 10, ADR-005).
 *
 * One batch at a time: receive up to 10 messages, split them by MessageGroupId, run
 * the groups in parallel and the messages of one group one after the other, then
 * receive again. A group is a wallet, so two messages of the same wallet never run
 * at the same time on this instance, and different wallets do not wait for each other.
 * Correctness does not depend on this order: the wallet lock and the unique keys in
 * PostgreSQL hold even if SQS delivered out of order or twice.
 */
export class SqsWagerConsumer {
  private loop: Promise<void> | undefined;
  private stopping = false;
  /** Cuts short a pause between failed receives. Never a long poll, never a message being processed. */
  private readonly stopSignal = new AbortController();
  /** Received in the current batch and not handed to the handler yet: what stop() may still give back. */
  private readonly notStarted = new Set<ReceivedMessage>();

  constructor(
    private readonly sqs: SQSClient,
    private readonly queues: WagerQueues,
    private readonly handler: MessageHandler,
    private readonly actions: MessageActions,
    private readonly settings: WagerConsumerSettings,
    private readonly logger: StructuredLogger,
    private readonly metrics: Metrics,
  ) {}

  start(): void {
    if (this.loop !== undefined) {
      return;
    }
    this.logger.info('wager_consumer.started', {
      visibilityTimeoutSeconds: this.settings.visibilityTimeoutSeconds,
      waitTimeSeconds: this.settings.waitTimeSeconds,
    });
    this.loop = this.pollUntilStopped();
  }

  /**
   * Graceful stop (SIGTERM): no new receive, the messages already being processed finish
   * (and are acked), the ones not started are given back with visibility 0.
   *
   * A long poll in progress is NOT aborted: closing the connection does not cancel the
   * poll on the SQS side, which can still take messages and hide them for a whole
   * visibility timeout with nobody to process them (reproduced with MiniStack; on AWS the
   * server does not know the client gave up either). So stop waits for the poll to return
   * (at most waitTimeSeconds) and gives back whatever it brought.
   *
   * Waits at most shutdownTimeoutMs. After that the messages not started yet are given
   * back at once, so another instance gets them now instead of after the visibility timeout.
   * The message still running is left alone: if it commits it is acked (late, but it was
   * processed exactly once); if the ack fails or the process dies, SQS delivers it again
   * and the inbox answers "already processed", so there is never a second debit.
   */
  async stop(): Promise<void> {
    if (this.loop === undefined || this.stopping) {
      return;
    }
    this.stopping = true;
    this.logger.info('wager_consumer.stopping');
    this.stopSignal.abort();
    const drained = await settlesWithin(this.loop, this.settings.shutdownTimeoutMs);
    if (drained) {
      this.logger.info('wager_consumer.stopped', { drained });
    } else {
      await this.releaseAll(this.takeNotStarted([...this.notStarted]), 'shutdown_deadline');
      this.logger.warn('wager_consumer.stopped', { drained });
    }
  }

  private async pollUntilStopped(): Promise<void> {
    let failedReceives = 0;
    while (!this.stopping) {
      const messages = await this.receiveBatch();
      if (messages === undefined) {
        failedReceives += 1;
        await this.pause(retryDelaySeconds(failedReceives, this.settings.receiveBackoff));
        continue;
      }
      failedReceives = 0;
      // If stop() came during the poll, every group gives its messages back untouched.
      await this.processBatch(messages);
    }
  }

  /** undefined when SQS could not be reached: the loop pauses and tries again, it never crashes. */
  private async receiveBatch(): Promise<ReceivedMessage[] | undefined> {
    try {
      const { source } = await this.queues.urls();
      const response = await this.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: source,
          MaxNumberOfMessages: this.settings.maxMessages,
          WaitTimeSeconds: this.settings.waitTimeSeconds,
          VisibilityTimeout: this.settings.visibilityTimeoutSeconds,
          MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
        }),
        { requestTimeout: this.settings.receiveRequestTimeoutMs },
      );
      const messages = (response.Messages ?? []).flatMap(toReceivedMessage);
      this.metrics.increment(MetricName.ConsumerReceives, { result: messages.length === 0 ? 'empty' : 'messages' });
      return messages;
    } catch (error) {
      this.metrics.increment(MetricName.ConsumerSqsErrors, { operation: 'receive' });
      this.logger.warn('wager_consumer.receive_failed', summarizeError(error));
      return undefined;
    }
  }

  private async processBatch(messages: readonly ReceivedMessage[]): Promise<void> {
    for (const message of messages) {
      this.notStarted.add(message);
    }
    await Promise.all([...groupByMessageGroup(messages).values()].map((group) => this.processGroup(group)));
  }

  /** Messages of one wallet, in the order SQS gave them, one at a time. */
  private async processGroup(group: readonly ReceivedMessage[]): Promise<void> {
    for (const [index, message] of group.entries()) {
      if (this.stopping) {
        // takeNotStarted: after the drain deadline stop() may have released some already.
        await this.releaseAll(this.takeNotStarted(group.slice(index)), 'shutdown');
        return;
      }
      this.notStarted.delete(message);
      const disposition = await this.handler.handle(message);
      await this.apply(message, disposition);
      if (disposition.action === 'retry') {
        // Keep the wallet's order: the rest of the group goes back with this message
        // still invisible, and SQS FIFO holds the whole group until it comes back.
        await this.releaseAll(this.takeNotStarted(group.slice(index + 1)), 'group_order');
        return;
      }
    }
  }

  private async apply(message: ReceivedMessage, disposition: MessageDisposition): Promise<void> {
    switch (disposition.action) {
      case 'ack':
        // If the delete fails, SQS delivers the message again after the visibility
        // timeout, and the inbox row answers "already processed".
        await this.callSqs('delete', message, () => this.actions.ack(message));
        return;
      case 'retry': {
        const delaySeconds = retryDelaySeconds(message.receiveCount, this.settings.retry);
        this.metrics.increment(MetricName.MessageRetries, { error_code: disposition.errorCode });
        // Not deleted. If even this call fails, the message comes back after the
        // visibility timeout instead. After maxReceiveCount the redrive policy moves it to the DLQ.
        await this.callSqs('change_visibility', message, () => this.actions.retryLater(message, delaySeconds));
        this.logger.warn('wager_consumer.retry_scheduled', {
          sqsMessageId: message.sqsMessageId,
          receiveCount: message.receiveCount,
          delaySeconds,
          errorCode: disposition.errorCode,
        });
        return;
      }
      case 'dead-letter': {
        // If this fails the message stays in the source queue, comes back, fails the same
        // way and is dead-lettered again; the DLQ drops the copy by deduplication id.
        const sent = await this.callSqs('dead_letter', message, () => this.actions.deadLetter(message, disposition.letter));
        if (sent) {
          this.metrics.increment(MetricName.MessagesDeadLettered, { reason: disposition.letter.reason });
          this.logger.warn('wager_consumer.dead_lettered', {
            sqsMessageId: message.sqsMessageId,
            reason: disposition.letter.reason,
            errorCode: disposition.letter.errorCode,
          });
        }
        return;
      }
    }
  }

  /**
   * Removes the messages from notStarted and returns the ones that were still there, so a
   * message is released by stop() or by its group, never by both. No await inside: nothing
   * else runs between the check and the removal.
   */
  private takeNotStarted(messages: readonly ReceivedMessage[]): ReceivedMessage[] {
    return messages.filter((message) => this.notStarted.delete(message));
  }

  /** Received but not started: visible again now, for this or another instance. */
  private async releaseAll(
    messages: readonly ReceivedMessage[],
    cause: 'shutdown' | 'shutdown_deadline' | 'group_order',
  ): Promise<void> {
    if (messages.length === 0) {
      return;
    }
    await Promise.all(messages.map((message) => this.callSqs('release', message, () => this.actions.release(message))));
    this.logger.info('wager_consumer.released', {
      cause,
      count: messages.length,
      sqsMessageIds: messages.map((message) => message.sqsMessageId).join(','),
    });
  }

  /** Every SQS failure here is safe to leave alone (see each caller); it is counted and logged. */
  private async callSqs(operation: string, message: ReceivedMessage, call: () => Promise<void>): Promise<boolean> {
    try {
      await call();
      return true;
    } catch (error) {
      this.metrics.increment(MetricName.ConsumerSqsErrors, { operation });
      this.logger.warn('wager_consumer.sqs_call_failed', {
        operation,
        sqsMessageId: message.sqsMessageId,
        ...summarizeError(error),
      });
      return false;
    }
  }

  private async pause(seconds: number): Promise<void> {
    try {
      await sleep(seconds * 1000, undefined, { signal: this.stopSignal.signal });
    } catch {
      // stop() aborted the pause.
    }
  }
}

function toReceivedMessage(message: Message): ReceivedMessage[] {
  if (message.MessageId === undefined || message.ReceiptHandle === undefined) {
    return []; // nothing can be done with it without a receipt handle
  }
  const receiveCount = Number.parseInt(message.Attributes?.ApproximateReceiveCount ?? '1', 10);
  return [
    {
      sqsMessageId: message.MessageId,
      receiptHandle: message.ReceiptHandle,
      body: message.Body ?? '',
      groupId: message.Attributes?.MessageGroupId ?? 'no-group',
      receiveCount: Number.isNaN(receiveCount) ? 1 : receiveCount,
    },
  ];
}

/** Map keeps insertion order, and each list keeps the order SQS returned. */
function groupByMessageGroup(messages: readonly ReceivedMessage[]): Map<string, ReceivedMessage[]> {
  const groups = new Map<string, ReceivedMessage[]>();
  for (const message of messages) {
    const group = groups.get(message.groupId) ?? [];
    group.push(message);
    groups.set(message.groupId, group);
  }
  return groups;
}

async function settlesWithin(work: Promise<void>, timeoutMs: number): Promise<boolean> {
  const timer = new AbortController();
  const timedOut = sleep(timeoutMs, false, { signal: timer.signal }).catch(() => false);
  const drained = await Promise.race([work.then(() => true), timedOut]);
  timer.abort();
  return drained;
}
