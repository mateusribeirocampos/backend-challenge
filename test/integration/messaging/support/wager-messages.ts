import { randomUUID } from 'node:crypto';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { WAGER_CONSUMER_NAME } from '../../../../src/interfaces/messaging/wager-message-handler.js';
import { query } from '../../schema/support/schema-sql.js';
import { defaultKey, type OpenedWallet, type WagerBody, wager } from '../../wagering/support/wagering-api.js';
import { sendRaw } from './sqs-test-queues.js';

/** The envelope of spec 10. */
export interface WagerEnvelope {
  messageId: string;
  type: string;
  occurredAt: string;
  correlationId?: string;
  data: WagerBody & { idempotencyKey: string };
}

/** A valid BET message for the wallet; override any field of the envelope or of data. */
export function wagerMessage(
  wallet: OpenedWallet,
  dataOverrides: Partial<WagerBody & { idempotencyKey: string }> = {},
  envelopeOverrides: Partial<Omit<WagerEnvelope, 'data'>> = {},
): WagerEnvelope {
  const body = wager(wallet, dataOverrides);
  return {
    messageId: `msg-${randomUUID()}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    ...envelopeOverrides,
    data: { ...body, idempotencyKey: dataOverrides.idempotencyKey ?? defaultKey(body) },
  };
}

/** Sends the envelope with the walletId as MessageGroupId, as producers do. */
export function sendWagerMessage(
  sqs: SQSClient,
  queueUrl: string,
  message: WagerEnvelope,
  options: { groupId?: string; deduplicationId?: string } = {},
): Promise<string> {
  return sendRaw(sqs, queueUrl, JSON.stringify(message), {
    groupId: options.groupId ?? message.data.walletId,
    ...(options.deduplicationId === undefined ? {} : { deduplicationId: options.deduplicationId }),
  });
}

export interface StoredTransaction {
  readonly id: string;
  readonly status: string;
  readonly failure_code: string | null;
  readonly kind: string;
  readonly amount: string;
}

export async function transactionByExternalId(
  orm: MikroORM,
  externalTransactionId: string,
): Promise<StoredTransaction | undefined> {
  const [row] = await query<StoredTransaction>(
    orm,
    `select id, status, failure_code, kind, amount::text as amount
       from wager_transactions
      where provider_id = 'provider-a' and external_transaction_id = '${externalTransactionId.replaceAll("'", "''")}'`,
  );
  return row;
}

export async function inboxRows(
  orm: MikroORM,
  messageId: string,
): Promise<{ consumer_name: string; payload_hash: string; processed: boolean }[]> {
  return query(
    orm,
    `select consumer_name, payload_hash, processed_at is not null as processed
       from inbox_messages
      where consumer_name = '${WAGER_CONSUMER_NAME}' and message_id = '${messageId.replaceAll("'", "''")}'`,
  );
}
