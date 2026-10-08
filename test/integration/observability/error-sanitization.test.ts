import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { ProcessWagerTransaction } from '../../../src/application/wagering/process-wager-transaction.js';
import { createSqsClient } from '../../../src/infrastructure/messaging/sqs-client.provider.js';
import {
  attribute,
  consumerConfig,
  createTestQueues,
  deleteTestQueues,
  receiveDeadLetters,
  type TestQueues,
} from '../messaging/support/sqs-test-queues.js';
import { sendWagerMessage, wagerMessage } from '../messaging/support/wager-messages.js';
import { openMigratedDatabase } from '../schema/support/schema-sql.js';
import { integrationConfig } from '../support/integration-config.js';
import { type RunningTestApp, startTestApp } from '../support/test-app.js';
import { waitUntil } from '../support/wait-until.js';
import { openWallet, submit, wager } from '../wagering/support/wagering-api.js';

setDefaultTimeout(20_000);

/** A value that only exists inside the failing SQL: if it shows up anywhere, raw error text leaked. */
const MARKER = '987.65';

/**
 * Review point F: an unexpected database error carries the SQL and the failing row in
 * its message (pg's CHECK violation does). Logs, the HTTP body and the DLQ attributes
 * must keep class, SQLSTATE and constraint, never that text.
 */
describe('unexpected errors are sanitized before logs, HTTP bodies and DLQ attributes (spec 12)', () => {
  let orm: MikroORM;
  let sqs: SQSClient;
  let queues: TestQueues;
  let app: RunningTestApp;

  /** A real PostgreSQL error: the CHECK wallets_balance_non_negative refuses a negative balance. */
  function failWithRealDatabaseError(walletId: string): Promise<never> {
    return orm.em
      .fork()
      .execute(`update wallets set balance_amount = -${MARKER} where id = '${walletId}'`)
      .then(() => {
        throw new Error('the update should have been refused');
      });
  }

  beforeAll(async () => {
    orm = await openMigratedDatabase();
    sqs = createSqsClient(integrationConfig().sqs);
  });

  afterAll(async () => {
    sqs.destroy();
    await orm.close(true);
  });

  beforeEach(async () => {
    queues = await createTestQueues(sqs);
    app = await startTestApp(consumerConfig(queues));
  });

  afterEach(async () => {
    await app.close();
    await deleteTestQueues(sqs, queues);
  });

  test('HTTP: 500 with a generic body; the log line has class, SQLSTATE, constraint and identifiers only', async () => {
    const wallet = await openWallet(app.baseUrl, '100.00');
    spyOn(app.get(ProcessWagerTransaction), 'execute').mockImplementation(() => failWithRealDatabaseError(wallet.id));

    const response = await submit(app.baseUrl, wager(wallet), undefined, { 'x-correlation-id': 'corr-sanitize-1' });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ errorCode: 'INTERNAL_ERROR', message: 'Internal error', correlationId: 'corr-sanitize-1' });
    expect(app.logs.events('http.request_failed')[0]?.fields).toEqual(
      expect.objectContaining({
        correlationId: 'corr-sanitize-1',
        walletId: wallet.id,
        providerId: 'provider-a',
        status: 500,
        errorClass: 'CheckConstraintViolationException',
        errorCode: '23514',
        constraint: 'wallets_balance_non_negative',
      }),
    );
    expect(JSON.stringify(app.logs.lines)).not.toContain(MARKER);
  });

  test('SQS: the DLQ attributes and the consumer logs name the error without its text', async () => {
    const wallet = await openWallet(app.baseUrl, '100.00');
    spyOn(app.get(ProcessWagerTransaction), 'executeDelivery').mockImplementation(() => failWithRealDatabaseError(wallet.id));
    const message = wagerMessage(wallet);

    await sendWagerMessage(sqs, queues.url, message);

    let deadLetters: Awaited<ReturnType<typeof receiveDeadLetters>> = [];
    await waitUntil('the message reaches the DLQ', async () => {
      deadLetters = await receiveDeadLetters(sqs, queues);
      return deadLetters.length > 0;
    });
    const letter = deadLetters[0];
    expect(letter && attribute(letter, 'reason')).toBe('UNEXPECTED_ERROR');
    expect(letter && attribute(letter, 'errorCode')).toBe('23514');
    expect(letter && attribute(letter, 'detail')).toBe(
      'CheckConstraintViolationException code=23514 constraint=wallets_balance_non_negative',
    );
    expect(JSON.stringify(letter?.MessageAttributes)).not.toContain(MARKER);
    expect(app.logs.events('wager_message.permanent_failure')[0]?.fields).toEqual(
      expect.objectContaining({ messageId: message.messageId, walletId: wallet.id, providerId: 'provider-a' }),
    );
    expect(JSON.stringify(app.logs.lines)).not.toContain(MARKER);
  });
});
