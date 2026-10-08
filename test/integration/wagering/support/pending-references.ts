import type { MikroORM } from '@mikro-orm/postgresql';
import type { AppConfig, PendingReferenceWorkerConfig } from '../../../../src/infrastructure/config/app-config.js';
import { query } from '../../schema/support/schema-sql.js';
import { integrationConfig } from '../../support/integration-config.js';
import { type OpenedWallet, type WagerBody, wager } from './wagering-api.js';

/** Helpers for the PENDING_REFERENCE worker tests. */

/** The test config with the worker ON, checking every 20 ms with short waits. */
export function workerConfig(worker: Partial<PendingReferenceWorkerConfig> = {}, base: AppConfig = integrationConfig()): AppConfig {
  return {
    ...base,
    pendingReferenceWorker: {
      ...base.pendingReferenceWorker,
      enabled: true,
      pollIntervalMs: 20,
      baseDelayMs: 50,
      maxDelayMs: 200,
      ...worker,
    },
  };
}

/**
 * Other tests leave PENDING_REFERENCE rows behind (their references never come). A worker
 * started here would check them too; pushing their next check a day away keeps the
 * worker on this test's rows only.
 */
export async function parkOtherPendingReferences(orm: MikroORM): Promise<void> {
  await query(
    orm,
    `update wager_transactions set next_reference_check_at = now() + interval '1 day' where status = 'PENDING_REFERENCE'`,
  );
}

/** Makes one pending transaction due now ('due') or a day away ('parked'), so a test decides what the worker sees. */
export async function scheduleCheck(orm: MikroORM, externalTransactionId: string, when: 'due' | 'parked'): Promise<void> {
  const at = when === 'due' ? `now() - interval '1 second'` : `now() + interval '1 day'`;
  await query(
    orm,
    `update wager_transactions set next_reference_check_at = ${at}
      where provider_id = 'provider-a' and external_transaction_id = '${externalTransactionId.replaceAll("'", "''")}'`,
  );
}

/** A BET and a reversal of it in the same round, both for 25.00. */
export function betAndReversal(wallet: OpenedWallet, kind: 'REFUND' | 'ROLLBACK'): { bet: WagerBody; reversal: WagerBody } {
  const bet = wager(wallet, { kind: 'BET', money: { amount: '25.00', currency: 'BRL' } });
  const reversal = wager(wallet, {
    kind,
    roundId: bet.roundId,
    money: { amount: '25.00', currency: 'BRL' },
    referenceExternalTransactionId: bet.externalTransactionId,
  });
  return { bet, reversal };
}

export interface StoredReferenceWait {
  readonly id: string;
  readonly status: string;
  readonly failure_code: string | null;
  readonly reference_attempts: number;
  readonly scheduled: boolean;
  readonly reference_transaction_id: string | null;
}

export async function referenceWaitOf(orm: MikroORM, externalTransactionId: string): Promise<StoredReferenceWait | undefined> {
  const [row] = await query<StoredReferenceWait>(
    orm,
    `select id, status, failure_code, reference_attempts, next_reference_check_at is not null as scheduled,
            reference_transaction_id
       from wager_transactions
      where provider_id = 'provider-a' and external_transaction_id = '${externalTransactionId.replaceAll("'", "''")}'`,
  );
  return row;
}

/** Event types written for one transaction, in the order they were written. */
export async function eventTypesOf(orm: MikroORM, transactionId: string): Promise<string[]> {
  const rows = await query<{ event_type: string }>(
    orm,
    `select event_type from outbox_messages
      where payload -> 'data' ->> 'transactionId' = '${transactionId}'
      order by sequence_number`,
  );
  return rows.map((row) => row.event_type);
}
