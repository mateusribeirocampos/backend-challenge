import { GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { DependencyCheck } from '../../application/health/check-readiness.js';

/** SQS is "up" for us when the endpoint answers and the queue we consume from exists. */
export class SqsQueueCheck implements DependencyCheck {
  readonly name = 'sqs';

  constructor(
    private readonly sqs: SQSClient,
    private readonly queueName: string,
  ) {}

  async check(signal: AbortSignal): Promise<void> {
    await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.queueName }), { abortSignal: signal });
  }
}
