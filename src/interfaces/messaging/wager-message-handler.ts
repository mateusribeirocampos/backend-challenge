import { type Metrics, MetricName } from '../../application/ports/metrics.js';
import type { LogFields, StructuredLogger } from '../../application/ports/structured-logger.js';
import { type ContentionRetryPolicy, DEFAULT_CONTENTION_RETRY, retryOnContention } from '../../application/retry-on-contention.js';
import type { DeliveryResult, ProcessWagerTransaction } from '../../application/wagering/process-wager-transaction.js';
import type { ValidationDetail } from '../http/request-validation.js';
import { classifyProcessingFailure, type ProcessingFailure } from './processing-failure.js';
import type { DeadLetter, ReceivedMessage } from './sqs-message-actions.js';
import { commandOf, messageDataHash, parseWagerMessage } from './wager-transaction-message.js';

/**
 * The inbox consumer name. The SAME on every instance: all instances share one inbox,
 * so a message processed by instance A is a duplicate for instance B. A name per
 * instance would let every instance process the same message once.
 */
export const WAGER_CONSUMER_NAME = 'wager-transactions';

/** What the consumer must do with the message, decided after the transaction ended. */
export type MessageDisposition =
  | { readonly action: 'ack' }
  | { readonly action: 'retry'; readonly errorCode: string }
  | { readonly action: 'dead-letter'; readonly letter: DeadLetter };

export interface MessageHandler {
  handle(message: ReceivedMessage): Promise<MessageDisposition>;
}

/**
 * The SQS counterpart of the HTTP controller: parse, call the SAME use case, and turn
 * the result or the error into ack, retry or DLQ (spec 10). It never throws.
 */
export class WagerMessageHandler implements MessageHandler {
  constructor(
    private readonly useCase: Pick<ProcessWagerTransaction, 'executeDelivery'>,
    private readonly logger: StructuredLogger,
    private readonly metrics: Metrics,
    private readonly contentionRetry: ContentionRetryPolicy = DEFAULT_CONTENTION_RETRY,
  ) {}

  async handle(message: ReceivedMessage): Promise<MessageDisposition> {
    let fields: LogFields = transportFields(message);
    try {
      const parsed = parseWagerMessage(message.body);
      if (!parsed.ok) {
        const { reason, errorCode, details } = parsed.failure;
        return this.deadLetter(fields, { reason, errorCode, detail: describe(details) });
      }
      const envelope = parsed.message;
      fields = {
        ...fields,
        messageId: envelope.messageId,
        correlationId: envelope.correlationId ?? envelope.messageId,
        walletId: envelope.data.walletId,
        providerId: envelope.data.providerId,
      };
      const command = commandOf(envelope);
      const delivery = {
        consumerName: WAGER_CONSUMER_NAME,
        messageId: envelope.messageId,
        payloadHash: messageDataHash(envelope),
      };
      // A lock timeout on a busy wallet is retried here, in milliseconds, instead of sending
      // the message back to the queue (which would also send back the rest of the wallet's
      // batch and raise their receive counts). Each attempt is a whole transaction, rolled
      // back entirely when it fails, so running it again is safe.
      const result = await retryOnContention(
        () => this.useCase.executeDelivery(command, delivery),
        this.contentionRetry,
        (attempt, delayMs) => {
          this.metrics.increment(MetricName.LockConflicts, { source: 'sqs' });
          this.logger.warn('wager_message.contention_retry', { ...fields, attempt, delayMs });
        },
      );
      // The transaction committed (or nothing had to be written): only now can SQS forget it.
      return this.acknowledge(fields, result);
    } catch (error) {
      return this.onFailure(fields, classifyProcessingFailure(error));
    }
  }

  private acknowledge(fields: LogFields, delivery: DeliveryResult): MessageDisposition {
    const { result } = delivery;
    const outcome = { ...fields, transactionId: result.transactionId, status: result.status, failureCode: result.failureCode };
    if (delivery.duplicateMessage) {
      // Layer 1: the same message again (redelivery, or a crash between commit and ack).
      this.metrics.increment(MetricName.DuplicatesDetected, { layer: 'inbox' });
      this.logger.info('wager_message.duplicate', { ...outcome, layer: 'inbox' });
    } else if (result.idempotentReplay) {
      // Layer 2: a new message for an operation that already exists (HTTP first, or a
      // producer that sent the operation twice with two messageIds).
      this.metrics.increment(MetricName.DuplicatesDetected, { layer: 'idempotency_key' });
      this.logger.info('wager_message.duplicate', { ...outcome, layer: 'idempotency_key' });
    } else {
      this.metrics.increment(MetricName.MessagesProcessed, { status: result.status });
      this.logger.info('wager_message.processed', outcome);
    }
    return { action: 'ack' };
  }

  private onFailure(fields: LogFields, failure: ProcessingFailure): MessageDisposition {
    switch (failure.kind) {
      case 'transient':
        this.logger.warn('wager_message.transient_failure', { ...fields, errorCode: failure.errorCode });
        return { action: 'retry', errorCode: failure.errorCode };
      case 'permanent':
        return this.deadLetter(fields, failure);
    }
  }

  private deadLetter(fields: LogFields, letter: DeadLetter): MessageDisposition {
    this.logger.error('wager_message.permanent_failure', {
      ...fields,
      reason: letter.reason,
      errorCode: letter.errorCode,
      detail: letter.detail,
    });
    return { action: 'dead-letter', letter: { reason: letter.reason, errorCode: letter.errorCode, detail: letter.detail } };
  }
}

function transportFields(message: ReceivedMessage): LogFields {
  return { sqsMessageId: message.sqsMessageId, receiveCount: message.receiveCount, groupId: message.groupId };
}

/** "data.roundId: INVALID_FORMAT; messageId: MISSING_FIELD", short enough for a DLQ attribute. */
function describe(details: readonly ValidationDetail[]): string {
  const text = details.map((detail) => `${detail.field ?? '(message)'}: ${detail.code}`).join('; ');
  return (text === '' ? 'body is not JSON' : text).slice(0, 256);
}
