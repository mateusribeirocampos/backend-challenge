import { expect } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { allPublished, type EventsQueue } from '../../messaging/support/outbox-events.js';
import { isEmpty, type TestQueues } from '../../messaging/support/sqs-test-queues.js';
import { query } from '../../schema/support/schema-sql.js';
import { AppProcess } from '../../support/app-process.js';
import { integrationConfig } from '../../support/integration-config.js';
import { waitUntil } from '../../support/wait-until.js';
import { expectBalanceMatchesLedger, type HttpResult, submit, type WagerBody } from '../../wagering/support/wagering-api.js';

/**
 * Several copies of the real app (src/main.ts), each in its own OS process with its own
 * HTTP port, all against the same PostgreSQL and the same test queues. Every copy runs
 * the SQS consumer, the outbox publisher and the PENDING_REFERENCE worker, as in production.
 */

export interface Instance {
  readonly name: string;
  readonly baseUrl: string;
  readonly process: AppProcess;
}

export interface ClusterQueues {
  readonly wager: TestQueues;
  readonly events: EventsQueue;
}

/**
 * Short timings so a crash is recovered in seconds: a message held by a dead process
 * comes back after the visibility timeout, an outbox lease of a dead process expires
 * after 2 s, and a pending reference is checked every 50 to 200 ms.
 */
function instanceEnv(queues: ClusterQueues, port: number, extra: Record<string, string>): Record<string, string> {
  return {
    PORT: String(port),
    DATABASE_NAME: integrationConfig().database.dbName,
    SQS_WAGER_QUEUE_NAME: queues.wager.name,
    SQS_WAGER_DLQ_NAME: queues.wager.deadLetterName,
    SQS_CONSUMER_ENABLED: 'true',
    SQS_CONSUMER_WAIT_TIME_SECONDS: '1',
    SQS_CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '8',
    SQS_CONSUMER_RETRY_BASE_SECONDS: '1',
    SQS_CONSUMER_RETRY_MAX_SECONDS: '2',
    SQS_EVENTS_QUEUE_NAME: queues.events.name,
    OUTBOX_PUBLISHER_ENABLED: 'true',
    OUTBOX_PUBLISHER_POLL_INTERVAL_MS: '20',
    OUTBOX_PUBLISHER_LEASE_SECONDS: '2',
    OUTBOX_PUBLISHER_SEND_TIMEOUT_MS: '1000',
    PENDING_REFERENCE_WORKER_ENABLED: 'true',
    PENDING_REFERENCE_POLL_INTERVAL_MS: '20',
    PENDING_REFERENCE_BASE_DELAY_MS: '50',
    PENDING_REFERENCE_MAX_DELAY_MS: '200',
    // 100 checks of at most 200 ms: about 20 s before a missing reference is given up.
    PENDING_REFERENCE_MAX_ATTEMPTS: '100',
    ...extra,
  };
}

/** Every process a test started, so afterEach can make sure none outlives it. */
const started: AppProcess[] = [];

/** Starts one instance and returns when its HTTP server answers. */
export async function startInstance(name: string, queues: ClusterQueues, extra: Record<string, string> = {}): Promise<Instance> {
  const port = freePort();
  const child = AppProcess.spawn('src/main.ts', instanceEnv(queues, port, extra));
  started.push(child);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitUntil(`${name} answers /health/live`, () => isLive(baseUrl), 20_000);
  } catch (error) {
    throw new Error(`${String(error)}\nOutput of ${name}:\n${child.output.join('\n')}`);
  }
  return { name, baseUrl, process: child };
}

export function startInstances(names: readonly string[], queues: ClusterQueues): Promise<Instance[]> {
  return Promise.all(names.map((name) => startInstance(name, queues)));
}

/** SIGKILL whatever is still running. A leftover worker would touch the rows of later tests. */
export async function killAllInstances(): Promise<void> {
  const running = started.splice(0);
  for (const child of running) {
    child.signal('SIGKILL');
  }
  await Promise.all(running.map((child) => child.exited));
}

async function isLive(baseUrl: string): Promise<boolean> {
  try {
    return (await fetch(`${baseUrl}/health/live`)).status === 200;
  } catch {
    return false; // not listening yet
  }
}

/** A port nobody uses right now. */
function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const { port } = server;
  void server.stop(true);
  if (port === undefined) throw new Error('no free port');
  return port;
}

/**
 * What a well-behaved provider does: send, and on 503 or a lost connection (the instance
 * died) resend the SAME body with the SAME key to the next instance, until a final answer.
 * `instances` is read on every attempt, so a test can swap a dead instance for a new one.
 */
export async function submitUntilAnswered(
  instances: () => readonly Instance[],
  first: number,
  body: WagerBody,
): Promise<HttpResult> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const live = instances();
    const target = live[(first + attempt) % live.length];
    if (target === undefined) throw new Error('no instance to send to');
    try {
      const response = await submit(target.baseUrl, body);
      if (response.status !== 503) {
        return response;
      }
    } catch {
      // connection refused or reset: that instance is gone, try the next one
    }
    await Bun.sleep(50); // a short pause between resends, not a coordination wait
  }
  throw new Error(`no final answer for ${body.externalTransactionId}`);
}

/**
 * The system is at rest: the source queue is empty, no transaction of these wallets
 * still waits for its reference, and every event of these wallets is published.
 */
export async function waitUntilSettled(
  orm: MikroORM,
  sqs: SQSClient,
  queues: ClusterQueues,
  walletIds: readonly string[],
  timeoutMs = 30_000,
): Promise<void> {
  await waitUntil(
    'the queue is empty, no reference is pending and every event is published',
    async () =>
      (await isEmpty(sqs, queues.wager.url)) &&
      (await pendingReferencesOf(orm, walletIds)) === 0 &&
      (await allPublished(orm, walletIds)),
    timeoutMs,
  );
}

async function pendingReferencesOf(orm: MikroORM, walletIds: readonly string[]): Promise<number> {
  const [row] = await query<{ count: number }>(
    orm,
    `select count(*)::int as count from wager_transactions
      where status = 'PENDING_REFERENCE' and wallet_id in (${walletIds.map((id) => `'${id}'`).join(', ')})`,
  );
  return row?.count ?? 0;
}

/**
 * Final consistency of one wallet (spec 13): the expected balance, equal to the balance
 * rebuilt from the ledger and to what the API answers; never negative at any version;
 * one ledger entry per transaction; one transaction per provider + external id.
 */
export async function expectWalletConsistent(
  orm: MikroORM,
  baseUrl: string,
  walletId: string,
  expectedBalance: string,
): Promise<void> {
  await expectBalanceMatchesLedger(orm, baseUrl, walletId, expectedBalance);

  const [ledger] = await query<{ never_negative: boolean; entries: number; transactions: number }>(
    orm,
    `select min(balance_after) >= 0 as never_negative, count(*)::int as entries,
            count(distinct transaction_id)::int as transactions
       from wallet_ledger_entries where wallet_id = '${walletId}'`,
  );
  expect(ledger?.never_negative).toBe(true);
  expect(ledger?.entries).toBe(ledger?.transactions);

  const duplicates = await query(
    orm,
    `select provider_id, external_transaction_id from wager_transactions
      where wallet_id = '${walletId}'
      group by provider_id, external_transaction_id having count(*) > 1`,
  );
  expect(duplicates).toEqual([]);
}

/** Status of each transaction of a wallet, by kind: e.g. { 'BET PROCESSED': 10, 'BET REJECTED': 20 }. */
export async function outcomesOf(orm: MikroORM, walletId: string): Promise<Record<string, number>> {
  const rows = await query<{ outcome: string; count: number }>(
    orm,
    `select kind || ' ' || status as outcome, count(*)::int as count
       from wager_transactions where wallet_id = '${walletId}' and kind <> 'OPENING'
      group by kind, status`,
  );
  return Object.fromEntries(rows.map((row) => [row.outcome, row.count]));
}

/** How many SQS messages each instance processed (from its JSON logs), for the test summary. */
export function processedPerInstance(instances: readonly Instance[]): Record<string, number> {
  return Object.fromEntries(
    instances.map((instance) => [instance.name, instance.process.eventsNamed('wager_message.processed').length]),
  );
}
