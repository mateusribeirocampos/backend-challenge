import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { AppConfig } from '../../src/infrastructure/config/app-config.js';
import { integrationConfig } from './support/integration-config.js';
import { type RunningTestApp, startTestApp } from './support/test-app.js';

async function getJson(url: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url);
  return { status: response.status, body: await response.json() };
}

function withSqs(config: AppConfig, sqs: Partial<AppConfig['sqs']>): AppConfig {
  return { ...config, sqs: { ...config.sqs, ...sqs } };
}

describe('health endpoints against real PostgreSQL and SQS', () => {
  let app: RunningTestApp;

  beforeAll(async () => {
    app = await startTestApp(integrationConfig());
  });

  afterAll(async () => {
    await app.close();
  });

  test('GET /health/live answers 200 without touching dependencies', async () => {
    const { status, body } = await getJson(`${app.baseUrl}/health/live`);

    expect(status).toBe(200);
    expect(body).toEqual({ status: 'ok' });
  });

  test('GET /health/ready answers 200 when PostgreSQL and the SQS queue answer', async () => {
    const { status, body } = await getJson(`${app.baseUrl}/health/ready`);

    expect(status).toBe(200);
    expect(body).toEqual({ status: 'ok', checks: { database: 'up', sqs: 'up' } });
  });
});

describe('readiness with a broken SQS configuration', () => {
  const cases: { name: string; sqs: Partial<AppConfig['sqs']> }[] = [
    { name: 'queue that does not exist', sqs: { wagerQueueName: 'queue-that-does-not-exist.fifo' } },
    // Port 1 on loopback: nothing listens there, the connection is refused.
    { name: 'endpoint where nothing listens', sqs: { endpoint: 'http://127.0.0.1:1' } },
  ];

  for (const { name, sqs } of cases) {
    test(`${name}: /health/ready is 503 naming sqs, /health/live stays 200`, async () => {
      const app = await startTestApp(withSqs(integrationConfig(), sqs));
      try {
        const ready = await getJson(`${app.baseUrl}/health/ready`);
        const live = await getJson(`${app.baseUrl}/health/live`);

        expect(ready.status).toBe(503);
        expect(ready.body).toEqual({
          status: 'unavailable',
          checks: { database: 'up', sqs: 'down' },
          failed: ['sqs'],
        });
        expect(live.status).toBe(200);
      } finally {
        await app.close();
      }
    });
  }
});
