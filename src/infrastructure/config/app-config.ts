import { z } from 'zod';

/**
 * Typed configuration built from environment variables.
 * Validated once at startup: a missing or malformed variable stops the process
 * before anything connects, with a message naming every invalid variable.
 */
export interface AppConfig {
  readonly http: { readonly port: number };
  readonly database: DatabaseConfig;
  readonly sqs: SqsConfig;
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
    SQS_WAGER_QUEUE_NAME: requiredText.endsWith('.fifo', 'must be a FIFO queue name ending in .fifo'),
  })
  .refine((env) => (env.AWS_ACCESS_KEY_ID === undefined) === (env.AWS_SECRET_ACCESS_KEY === undefined), {
    message: 'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set together or both left empty',
    path: ['AWS_ACCESS_KEY_ID'],
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
