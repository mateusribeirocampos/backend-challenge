import { resolve } from 'node:path';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import type { AppConfig } from '../src/infrastructure/config/app-config.js';
import { buildMikroOrmConfig } from '../src/infrastructure/persistence/mikro-orm.config.js';
import {
  createEventsQueue,
  deleteEventsQueue,
  type EventsQueue,
} from '../test/integration/messaging/support/outbox-events.js';
import { createTestQueues, deleteTestQueues, type TestQueues } from '../test/integration/messaging/support/sqs-test-queues.js';
import { assertDisposableLoadDatabase } from './settings.js';

/**
 * The system under test: a database and queues of its own for this run, and N copies of
 * src/main.ts in separate OS processes (HTTP, SQS consumer, outbox publisher and
 * PENDING_REFERENCE worker on in each), as in production.
 */

const PROJECT_ROOT = resolve(import.meta.dir, '..');

export interface RunQueues {
  readonly wager: TestQueues;
  readonly events: EventsQueue;
}

export interface Instance {
  readonly name: string;
  readonly baseUrl: string;
  readonly pid: number;
  readonly child: Bun.Subprocess;
}

/**
 * Drops and recreates the load database, then applies every migration. Every run starts
 * from the same empty schema, and the global numbers (outbox lag, unpublished events)
 * only see this run's rows.
 */
export async function prepareDatabase(app: AppConfig, databaseName: string): Promise<MikroORM> {
  assertDisposableLoadDatabase(databaseName, app.database.dbName);
  const admin = await MikroORM.init({ ...buildMikroOrmConfig(app.database), debug: false });
  try {
    const connection = admin.em.getConnection();
    await connection.execute(`drop database if exists ${databaseName} with (force)`);
    await connection.execute(`create database ${databaseName}`);
  } finally {
    await admin.close(true);
  }
  const orm = await MikroORM.init({ ...buildMikroOrmConfig({ ...app.database, dbName: databaseName }), debug: false });
  await orm.migrator.up();
  return orm;
}

/** Same FIFO queues, DLQ and redrive policy as the integration tests, with a random suffix. */
export async function createRunQueues(sqs: SQSClient): Promise<RunQueues> {
  return { wager: await createTestQueues(sqs), events: await createEventsQueue(sqs) };
}

/** Deletes the events queue and creates it again with the same name (and so the same URL). */
export async function recreateEventsQueue(sqs: SQSClient, queue: EventsQueue): Promise<void> {
  await deleteEventsQueue(sqs, queue);
  const again = await createEventsQueue(sqs, queue.name);
  if (again.url !== queue.url) {
    throw new Error(`the events queue came back with another URL: ${again.url} instead of ${queue.url}`);
  }
}

export async function deleteRunQueues(sqs: SQSClient, queues: RunQueues): Promise<void> {
  await deleteTestQueues(sqs, queues.wager);
  await deleteEventsQueue(sqs, queues.events);
}

/**
 * The env each instance gets on top of .env. Everything not listed keeps the app default
 * (lease 30 s, visibility 30 s, long poll 10 s, publisher poll 500 ms): the run measures
 * the configuration that would ship, not one tuned for the test.
 */
export function instanceEnv(queues: RunQueues, databaseName: string, port: number): Record<string, string> {
  return {
    PORT: String(port),
    DATABASE_NAME: databaseName,
    SQS_WAGER_QUEUE_NAME: queues.wager.name,
    SQS_WAGER_DLQ_NAME: queues.wager.deadLetterName,
    SQS_EVENTS_QUEUE_NAME: queues.events.name,
    SQS_CONSUMER_ENABLED: 'true',
    OUTBOX_PUBLISHER_ENABLED: 'true',
    PENDING_REFERENCE_WORKER_ENABLED: 'true',
  };
}

/**
 * Starts one instance and waits for /health/ready (database and SQS reachable). Its log
 * goes to a file, not to this process: parsing tens of thousands of JSON lines here would
 * steal CPU from the clients that measure latency.
 */
export async function startInstance(name: string, env: Record<string, string>, logPath: string): Promise<Instance> {
  const port = Number.parseInt(env.PORT ?? '', 10);
  const child = Bun.spawn([process.execPath, 'src/main.ts'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ...env },
    stdin: 'ignore',
    stdout: Bun.file(logPath),
    stderr: Bun.file(`${logPath}.stderr`),
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForReady(name, baseUrl, child, logPath);
  return { name, baseUrl, pid: child.pid, child };
}

async function waitForReady(name: string, baseUrl: string, child: Bun.Subprocess, logPath: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${name} exited with code ${child.exitCode} before it was ready; see ${logPath}`);
    }
    try {
      if ((await fetch(`${baseUrl}/health/ready`)).status === 200) return;
    } catch {
      // not listening yet
    }
    await Bun.sleep(100);
  }
  throw new Error(`${name} was not ready after 30 s; see ${logPath}`);
}

/** SIGTERM (graceful: the consumer finishes its long poll), SIGKILL if it takes longer than 20 s. */
export async function stopInstances(instances: readonly Instance[]): Promise<void> {
  for (const instance of instances) {
    instance.child.kill('SIGTERM');
  }
  await Promise.all(
    instances.map(async (instance) => {
      const killer = setTimeout(() => instance.child.kill('SIGKILL'), 20_000);
      await instance.child.exited;
      clearTimeout(killer);
    }),
  );
}

/** A port nobody uses right now. */
export function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const { port } = server;
  void server.stop(true);
  if (port === undefined) throw new Error('no free port');
  return port;
}
