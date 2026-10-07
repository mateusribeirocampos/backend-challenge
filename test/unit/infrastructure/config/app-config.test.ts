import { describe, expect, test } from 'bun:test';
import { ConfigValidationError, loadConfig } from '../../../../src/infrastructure/config/app-config.js';

const validEnv = {
  DATABASE_HOST: 'localhost',
  DATABASE_USER: 'wagering',
  DATABASE_PASSWORD: 'wagering',
  DATABASE_NAME: 'wagering',
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  SQS_ENDPOINT: 'http://localhost:4566',
  SQS_WAGER_QUEUE_NAME: 'wager-transactions.fifo',
};

function problemsFor(env: Record<string, string | undefined>): readonly string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigValidationError) return error.problems;
    throw error;
  }
  throw new Error('expected loadConfig to throw ConfigValidationError');
}

describe('loadConfig', () => {
  test('builds a typed config and applies defaults for ports', () => {
    const config = loadConfig(validEnv);

    expect(config.http.port).toBe(3000);
    expect(config.database).toEqual({
      host: 'localhost',
      port: 5432,
      user: 'wagering',
      password: 'wagering',
      dbName: 'wagering',
    });
    expect(config.sqs).toEqual({
      region: 'us-east-1',
      endpoint: 'http://localhost:4566',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      wagerQueueName: 'wager-transactions.fifo',
      wagerDeadLetterQueueName: 'wager-transactions-dlq.fifo',
      consumer: {
        enabled: true,
        visibilityTimeoutSeconds: 30,
        waitTimeSeconds: 10,
        shutdownTimeoutSeconds: 15,
        retryBaseDelaySeconds: 5,
        retryMaxDelaySeconds: 300,
      },
    });
  });

  test('reads the SQS consumer settings', () => {
    const config = loadConfig({
      ...validEnv,
      SQS_WAGER_DLQ_NAME: 'other-dlq.fifo',
      SQS_CONSUMER_ENABLED: 'false',
      SQS_CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '60',
      SQS_CONSUMER_WAIT_TIME_SECONDS: '0',
      SQS_CONSUMER_SHUTDOWN_TIMEOUT_SECONDS: '3',
      SQS_CONSUMER_RETRY_BASE_SECONDS: '1',
      SQS_CONSUMER_RETRY_MAX_SECONDS: '30',
    });

    expect(config.sqs.wagerDeadLetterQueueName).toBe('other-dlq.fifo');
    expect(config.sqs.consumer).toEqual({
      enabled: false,
      visibilityTimeoutSeconds: 60,
      waitTimeSeconds: 0,
      shutdownTimeoutSeconds: 3,
      retryBaseDelaySeconds: 1,
      retryMaxDelaySeconds: 30,
    });
  });

  test('refuses consumer settings SQS would refuse, or that make no sense', () => {
    expect(
      problemsFor({
        ...validEnv,
        SQS_WAGER_DLQ_NAME: 'dlq',
        SQS_CONSUMER_ENABLED: 'yes',
        SQS_CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '0',
        SQS_CONSUMER_WAIT_TIME_SECONDS: '21',
        SQS_CONSUMER_SHUTDOWN_TIMEOUT_SECONDS: '301',
      }),
    ).toEqual([
      'SQS_WAGER_DLQ_NAME: must be a FIFO queue name ending in .fifo',
      'SQS_CONSUMER_ENABLED: must be true or false',
      'SQS_CONSUMER_VISIBILITY_TIMEOUT_SECONDS: must be an integer between 1 and 43200',
      'SQS_CONSUMER_WAIT_TIME_SECONDS: must be an integer between 0 and 20',
      'SQS_CONSUMER_SHUTDOWN_TIMEOUT_SECONDS: must be an integer between 1 and 300',
    ]);
  });

  test('the shutdown budget must be longer than one long poll: stop waits for the poll to return', () => {
    expect(
      problemsFor({ ...validEnv, SQS_CONSUMER_WAIT_TIME_SECONDS: '10', SQS_CONSUMER_SHUTDOWN_TIMEOUT_SECONDS: '10' }),
    ).toEqual([
      'SQS_CONSUMER_SHUTDOWN_TIMEOUT_SECONDS: must be greater than SQS_CONSUMER_WAIT_TIME_SECONDS (stop waits for the long poll to return)',
    ]);
  });

  test('converts numeric env strings to numbers', () => {
    const config = loadConfig({ ...validEnv, PORT: '8080', DATABASE_PORT: '6543' });

    expect(config.http.port).toBe(8080);
    expect(config.database.port).toBe(6543);
  });

  test('reports every invalid variable at once, by name', () => {
    const problems = problemsFor({
      ...validEnv,
      DATABASE_HOST: undefined,
      DATABASE_PASSWORD: '',
      PORT: 'abc',
      SQS_ENDPOINT: 'not a url',
      SQS_WAGER_QUEUE_NAME: 'wager-transactions',
    });

    expect(problems).toEqual([
      'PORT: must be an integer between 1 and 65535',
      'DATABASE_HOST: is required',
      'DATABASE_PASSWORD: is required',
      'SQS_ENDPOINT: must be a URL like http://localhost:4566',
      'SQS_WAGER_QUEUE_NAME: must be a FIFO queue name ending in .fifo',
    ]);
  });

  test('error message lists the problems so the startup log is self explanatory', () => {
    expect(() => loadConfig({})).toThrow(/Invalid environment configuration:\n {2}- DATABASE_HOST: is required/);
  });

  test('rejects a port out of range', () => {
    expect(problemsFor({ ...validEnv, DATABASE_PORT: '70000' })).toEqual([
      'DATABASE_PORT: must be an integer between 1 and 65535',
    ]);
  });

  test('without endpoint and keys it targets real AWS with the SDK default credentials', () => {
    const config = loadConfig({
      ...validEnv,
      SQS_ENDPOINT: '',
      AWS_ACCESS_KEY_ID: undefined,
      AWS_SECRET_ACCESS_KEY: undefined,
    });

    expect(config.sqs.endpoint).toBeUndefined();
    expect(config.sqs.credentials).toBeUndefined();
  });

  test('rejects only one of the two AWS keys', () => {
    expect(problemsFor({ ...validEnv, AWS_SECRET_ACCESS_KEY: undefined })).toEqual([
      'AWS_ACCESS_KEY_ID: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set together or both left empty',
    ]);
  });
});
