import { SQSClient } from '@aws-sdk/client-sqs';
import type { SqsConfig } from '../config/app-config.js';

export const SQS_CLIENT = Symbol('SQS_CLIENT');

export function createSqsClient(config: SqsConfig): SQSClient {
  return new SQSClient({
    region: config.region,
    ...(config.endpoint !== undefined && { endpoint: config.endpoint }),
    ...(config.credentials !== undefined && { credentials: config.credentials }),
    // Fail fast in readiness and in the consumer; retries are our decision, not the SDK's.
    maxAttempts: 1,
    // Without these an endpoint that accepts the connection and never answers keeps the
    // call (and the consumer loop awaiting it) pending forever. In @smithy/node-http-handler
    // requestTimeout only logs a warning unless throwOnRequestTimeout is set.
    // ReceiveMessage overrides requestTimeout per call: its long poll is longer than this.
    requestHandler: {
      connectionTimeout: config.connectionTimeoutMs,
      requestTimeout: config.requestTimeoutMs,
      throwOnRequestTimeout: true,
    },
  });
}
