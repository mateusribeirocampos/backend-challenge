import { Money } from '../../domain/money/money.js';
import { z } from 'zod';

/**
 * Typed configuration built from environment variables.
 * Validated once at startup: a missing or malformed variable stops the process
 * before anything connects, with a message naming every invalid variable.
 */
export interface AppConfig {
  readonly http: { readonly port: number };
  /** Currencies the platform operates; a wallet can only be opened in one of them. */
  readonly wallets: { readonly supportedCurrencies: readonly string[] };
  readonly database: DatabaseConfig;
  readonly sqs: SqsConfig;
  readonly outboxPublisher: OutboxPublisherConfig;
  readonly pendingReferenceWorker: PendingReferenceWorkerConfig;
}

export interface DatabaseConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly dbName: string;
}

export interface SqsConfig {
  readonly region: string;
  /** Emulator URL in local environments. Undefined means the real AWS endpoint. */
  readonly endpoint: string | undefined;
  /** Undefined means the AWS SDK default chain (IAM role, profile, ...). */
  readonly credentials: { readonly accessKeyId: string; readonly secretAccessKey: string } | undefined;
  readonly wagerQueueName: string;
  /** Where the consumer sends permanent failures; the redrive policy of the queue points here too. */
  readonly wagerDeadLetterQueueName: string;
  /** Where the outbox publisher sends the integration events. */
  readonly eventsQueueName: string;
  readonly consumer: WagerConsumerConfig;
}

/** The SQS consumer of wager-transactions.fifo (spec 10). */
export interface WagerConsumerConfig {
  /** false: the app serves HTTP only. The integration tests start their consumers explicitly. */
  readonly enabled: boolean;
  /** How long a received message stays hidden from other consumers while it is processed. */
  readonly visibilityTimeoutSeconds: number;
  /** Long polling: how long one ReceiveMessage waits for messages (SQS allows 0 to 20). */
  readonly waitTimeSeconds: number;
  /**
   * On SIGTERM, how long to wait for the long poll in progress and the messages already
   * being processed. Longer than waitTimeSeconds, and shorter than the time the container
   * gets before SIGKILL (stop_grace_period in docker-compose.yml).
   */
  readonly shutdownTimeoutSeconds: number;
  /** Backoff of a transient failure: delay = jitter(min(max, base * 2^(receiveCount - 1))). */
  readonly retryBaseDelaySeconds: number;
  readonly retryMaxDelaySeconds: number;
}

/** The outbox publisher (spec 11, ADR-005), a loop inside every app instance. */
export interface OutboxPublisherConfig {
  /** false: this instance does not publish. The integration tests start their publishers explicitly. */
  readonly enabled: boolean;
  /** Events claimed per batch. */
  readonly batchSize: number;
  /** How long a claim reserves its events; after it, another instance may send them. */
  readonly leaseSeconds: number;
  /** A SendMessage that takes longer is given up and retried. Shorter than the lease. */
  readonly sendTimeoutMs: number;
  /** Pause when there was nothing (more) to publish. */
  readonly pollIntervalMs: number;
}

/** The PENDING_REFERENCE worker (spec 7.1, ADR-008), a loop inside every app instance. */
export interface PendingReferenceWorkerConfig {
  /** false: this instance does not check pending references. The integration tests start theirs explicitly. */
  readonly enabled: boolean;
  /** Checks before giving up with REFERENCE_NOT_FOUND (only when the reference does not exist). */
  readonly maxAttempts: number;
  /** Backoff between checks: min(maxDelayMs, baseDelayMs * 2^(n-1)), with jitter. */
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Pending transactions checked per run. */
  readonly batchSize: number;
  /** Pause when nothing (more) was due. */
  readonly pollIntervalMs: number;
}

export const APP_CONFIG = Symbol('APP_CONFIG');

export class ConfigValidationError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid environment configuration:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    this.name = 'ConfigValidationError';
  }
}

const requiredText = z.string('is required').trim().min(1, 'is required');
const PORT_MESSAGE = 'must be an integer between 1 and 65535';
const portNumber = z.coerce.number(PORT_MESSAGE).int(PORT_MESSAGE).min(1, PORT_MESSAGE).max(65535, PORT_MESSAGE);
const fifoQueueName = requiredText.endsWith('.fifo', 'must be a FIFO queue name ending in .fifo');
const booleanFlag = z.enum(['true', 'false'], 'must be true or false').transform((value) => value === 'true');

function integerBetween(min: number, max: number) {
  const message = `must be an integer between ${min} and ${max}`;
  return z.coerce.number(message).int(message).min(min, message).max(max, message);
}

/** Comma separated ISO-4217 codes (BRL,USD). Each must pass the same check as Money. */
const currencyList = z
  .string()
  .transform((value) => value.split(',').map((code) => code.trim()))
  .refine((codes) => codes.every((code) => isCurrencyCode(code)), {
    message: 'must be a comma separated list of ISO-4217 currency codes like BRL,USD',
  });

function isCurrencyCode(code: string): boolean {
  try {
    Money.zero(code);
    return true;
  } catch {
    return false;
  }
}

const envSchema = z
  .object({
    PORT: portNumber.default(3000),
    DATABASE_HOST: requiredText,
    DATABASE_PORT: portNumber.default(5432),
    DATABASE_USER: requiredText,
    DATABASE_PASSWORD: requiredText,
    DATABASE_NAME: requiredText,
    AWS_REGION: requiredText,
    AWS_ACCESS_KEY_ID: z.string().trim().min(1).optional(),
    AWS_SECRET_ACCESS_KEY: z.string().trim().min(1).optional(),
    SQS_ENDPOINT: z.url('must be a URL like http://localhost:4566').optional(),
    SQS_WAGER_QUEUE_NAME: fifoQueueName,
    SQS_WAGER_DLQ_NAME: fifoQueueName.default('wager-transactions-dlq.fifo'),
    SQS_CONSUMER_ENABLED: booleanFlag.default(true),
    SQS_CONSUMER_VISIBILITY_TIMEOUT_SECONDS: integerBetween(1, 43_200).default(30),
    SQS_CONSUMER_WAIT_TIME_SECONDS: integerBetween(0, 20).default(10),
    SQS_CONSUMER_SHUTDOWN_TIMEOUT_SECONDS: integerBetween(1, 300).default(15),
    SQS_CONSUMER_RETRY_BASE_SECONDS: integerBetween(1, 3600).default(5),
    SQS_CONSUMER_RETRY_MAX_SECONDS: integerBetween(1, 43_200).default(300),
    SUPPORTED_CURRENCIES: currencyList.default(['BRL']),
    SQS_EVENTS_QUEUE_NAME: fifoQueueName.default('wagering-events.fifo'),
    OUTBOX_PUBLISHER_ENABLED: booleanFlag.default(true),
    OUTBOX_PUBLISHER_BATCH_SIZE: integerBetween(1, 100).default(20),
    OUTBOX_PUBLISHER_LEASE_SECONDS: integerBetween(1, 3600).default(30),
    OUTBOX_PUBLISHER_SEND_TIMEOUT_MS: integerBetween(100, 60_000).default(5_000),
    OUTBOX_PUBLISHER_POLL_INTERVAL_MS: integerBetween(10, 60_000).default(500),
    PENDING_REFERENCE_WORKER_ENABLED: booleanFlag.default(true),
    PENDING_REFERENCE_MAX_ATTEMPTS: integerBetween(1, 100).default(15),
    PENDING_REFERENCE_BASE_DELAY_MS: integerBetween(1, 3_600_000).default(1_000),
    PENDING_REFERENCE_MAX_DELAY_MS: integerBetween(1, 3_600_000).default(60_000),
    PENDING_REFERENCE_BATCH_SIZE: integerBetween(1, 100).default(20),
    PENDING_REFERENCE_POLL_INTERVAL_MS: integerBetween(10, 60_000).default(500),
  })
  .refine((env) => (env.AWS_ACCESS_KEY_ID === undefined) === (env.AWS_SECRET_ACCESS_KEY === undefined), {
    message: 'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set together or both left empty',
    path: ['AWS_ACCESS_KEY_ID'],
  })
  .refine((env) => env.SQS_CONSUMER_SHUTDOWN_TIMEOUT_SECONDS > env.SQS_CONSUMER_WAIT_TIME_SECONDS, {
    message: 'must be greater than SQS_CONSUMER_WAIT_TIME_SECONDS (stop waits for the long poll to return)',
    path: ['SQS_CONSUMER_SHUTDOWN_TIMEOUT_SECONDS'],
  })
  .refine((env) => env.OUTBOX_PUBLISHER_LEASE_SECONDS * 1000 > env.OUTBOX_PUBLISHER_SEND_TIMEOUT_MS, {
    message: 'must be longer than OUTBOX_PUBLISHER_SEND_TIMEOUT_MS (a send must end while the lease holds)',
    path: ['OUTBOX_PUBLISHER_LEASE_SECONDS'],
  })
  .refine((env) => env.PENDING_REFERENCE_MAX_DELAY_MS >= env.PENDING_REFERENCE_BASE_DELAY_MS, {
    message: 'must be at least PENDING_REFERENCE_BASE_DELAY_MS',
    path: ['PENDING_REFERENCE_MAX_DELAY_MS'],
  });

type RawEnv = Readonly<Record<string, string | undefined>>;

export function loadConfig(rawEnv: RawEnv): AppConfig {
  const parsed = envSchema.safeParse(withoutEmptyValues(rawEnv));
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw new ConfigValidationError(problems);
  }

  const env = parsed.data;
  return {
    http: { port: env.PORT },
    wallets: { supportedCurrencies: env.SUPPORTED_CURRENCIES },
    database: {
      host: env.DATABASE_HOST,
      port: env.DATABASE_PORT,
      user: env.DATABASE_USER,
      password: env.DATABASE_PASSWORD,
      dbName: env.DATABASE_NAME,
    },
    sqs: {
      region: env.AWS_REGION,
      endpoint: env.SQS_ENDPOINT,
      credentials:
        env.AWS_ACCESS_KEY_ID !== undefined && env.AWS_SECRET_ACCESS_KEY !== undefined
          ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY }
          : undefined,
      wagerQueueName: env.SQS_WAGER_QUEUE_NAME,
      wagerDeadLetterQueueName: env.SQS_WAGER_DLQ_NAME,
      eventsQueueName: env.SQS_EVENTS_QUEUE_NAME,
      consumer: {
        enabled: env.SQS_CONSUMER_ENABLED,
        visibilityTimeoutSeconds: env.SQS_CONSUMER_VISIBILITY_TIMEOUT_SECONDS,
        waitTimeSeconds: env.SQS_CONSUMER_WAIT_TIME_SECONDS,
        shutdownTimeoutSeconds: env.SQS_CONSUMER_SHUTDOWN_TIMEOUT_SECONDS,
        retryBaseDelaySeconds: env.SQS_CONSUMER_RETRY_BASE_SECONDS,
        retryMaxDelaySeconds: env.SQS_CONSUMER_RETRY_MAX_SECONDS,
      },
    },
    outboxPublisher: {
      enabled: env.OUTBOX_PUBLISHER_ENABLED,
      batchSize: env.OUTBOX_PUBLISHER_BATCH_SIZE,
      leaseSeconds: env.OUTBOX_PUBLISHER_LEASE_SECONDS,
      sendTimeoutMs: env.OUTBOX_PUBLISHER_SEND_TIMEOUT_MS,
      pollIntervalMs: env.OUTBOX_PUBLISHER_POLL_INTERVAL_MS,
    },
    pendingReferenceWorker: {
      enabled: env.PENDING_REFERENCE_WORKER_ENABLED,
      maxAttempts: env.PENDING_REFERENCE_MAX_ATTEMPTS,
      baseDelayMs: env.PENDING_REFERENCE_BASE_DELAY_MS,
      maxDelayMs: env.PENDING_REFERENCE_MAX_DELAY_MS,
      batchSize: env.PENDING_REFERENCE_BATCH_SIZE,
      pollIntervalMs: env.PENDING_REFERENCE_POLL_INTERVAL_MS,
    },
  };
}

/** `FOO=` in a .env file arrives as "". We treat it as "not set" so defaults and "is required" apply. */
function withoutEmptyValues(rawEnv: RawEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawEnv)) {
    if (value !== undefined && value.trim() !== '') {
      result[key] = value;
    }
  }
  return result;
}
