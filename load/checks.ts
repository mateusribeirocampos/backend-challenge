import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { queueDepth } from '../test/integration/messaging/support/sqs-test-queues.js';
import type { Instance } from './cluster.js';
import type { RunQueues } from './cluster.js';
import { pollUntil, query, unpublishedEvents, uuidList } from './database.js';
import type { EventsDrainer } from './events-drainer.js';
import type { CheckResult } from './results.js';
import type { ExpectedBalances } from './wagering.js';

/**
 * Correctness after the load, the part that matters most: a fast system that loses or
 * doubles money is wrong. Every check reads the database (or SQS) directly, and each one
 * says what it found, so a failure in the report shows exactly what broke.
 */

export interface VerifyInput {
  readonly orm: MikroORM;
  readonly sqs: SQSClient;
  readonly queues: RunQueues;
  readonly instance: Instance;
  readonly expected: ExpectedBalances;
  readonly drainer: EventsDrainer;
}

export async function verifyScenario(input: VerifyInput): Promise<CheckResult[]> {
  const wallets = uuidList(input.expected.walletIds());
  return [
    await balanceEqualsLedger(input.orm, wallets),
    await balanceEqualsExpected(input.orm, wallets, input.expected),
    await neverNegative(input.orm, wallets),
    await oneEntryPerMovingTransaction(input.orm, wallets),
    await processedMatchesAnswers(input.orm, wallets, input.expected),
    await noDuplicateOperation(input.orm, wallets),
    await nothingPending(input.orm, wallets),
    await outboxDrained(input.orm),
    await everyEventDelivered(input.orm, input.drainer, wallets),
    await queuesEmpty(input.sqs, input.queues),
    await apiReconciliation(input.instance, input.expected.walletIds()),
  ];
}

function walletCount(count: number): string {
  return count === 1 ? '1 wallet' : `${count} wallets`;
}

function check(name: string, passed: boolean, detail: string): CheckResult {
  return { name, passed, detail };
}

/** wallets.balance = credits - debits of the ledger, for every wallet of the scenario. */
async function balanceEqualsLedger(orm: MikroORM, wallets: string): Promise<CheckResult> {
  const rows = await query<{ id: string; stored: string; rebuilt: string }>(
    orm,
    `select w.id, w.balance_amount::text as stored,
            coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)::numeric(20, 2)::text as rebuilt
       from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
      where w.id in ${wallets}
      group by w.id, w.balance_amount`,
  );
  const different = rows.filter((row) => row.stored !== row.rebuilt);
  return check(
    'Saldo de cada wallet = saldo reconstruído do ledger',
    different.length === 0,
    different.length === 0
      ? `${walletCount(rows.length)} conferida(s)`
      : `divergem: ${different.map((row) => `${row.id} (${row.stored} x ${row.rebuilt})`).join(', ')}`,
  );
}

/** The balance the clients expect from the answers they got. A doubled debit would show here. */
async function balanceEqualsExpected(orm: MikroORM, wallets: string, expected: ExpectedBalances): Promise<CheckResult> {
  const rows = await query<{ id: string; stored: string }>(
    orm,
    `select id, balance_amount::text as stored from wallets where id in ${wallets}`,
  );
  const different = rows.filter((row) => row.stored !== expected.balanceOf(row.id));
  return check(
    'Saldo = saldo esperado pelas respostas da API',
    different.length === 0 && rows.length === expected.walletIds().length,
    different.length === 0
      ? `${walletCount(rows.length)} igual(is) ao calculado pelos clientes`
      : `divergem: ${different.map((row) => `${row.id} (banco ${row.stored}, esperado ${expected.balanceOf(row.id)})`).join(', ')}`,
  );
}

async function neverNegative(orm: MikroORM, wallets: string): Promise<CheckResult> {
  const [row] = await query<{ min_after: string | null; min_balance: string | null }>(
    orm,
    `select (select min(balance_after)::text from wallet_ledger_entries where wallet_id in ${wallets}) as min_after,
            (select min(balance_amount)::text from wallets where id in ${wallets}) as min_balance`,
  );
  const negative = [row?.min_after, row?.min_balance].some((value) => value?.startsWith('-') === true);
  return check(
    'Nenhum saldo negativo, em nenhuma versão do ledger',
    !negative,
    `menor balance_after ${row?.min_after ?? 'n/d'}, menor saldo atual ${row?.min_balance ?? 'n/d'}`,
  );
}

/** One ledger entry per transaction, and one per PROCESSED transaction that moves money (LOSS does not). */
async function oneEntryPerMovingTransaction(orm: MikroORM, wallets: string): Promise<CheckResult> {
  const [row] = await query<{ entries: number; distinct_transactions: number; moving: number }>(
    orm,
    `select (select count(*)::int from wallet_ledger_entries where wallet_id in ${wallets}) as entries,
            (select count(distinct transaction_id)::int from wallet_ledger_entries where wallet_id in ${wallets}) as distinct_transactions,
            (select count(*)::int from wager_transactions
              where wallet_id in ${wallets} and status = 'PROCESSED' and kind <> 'LOSS') as moving`,
  );
  const passed = row !== undefined && row.entries === row.distinct_transactions && row.entries === row.moving;
  return check(
    'Um lançamento por transação processada que move saldo (sem efeito duplicado)',
    passed,
    `${row?.entries ?? 0} lançamentos, ${row?.distinct_transactions ?? 0} transações distintas no ledger, ${row?.moving ?? 0} transações processadas que movem saldo`,
  );
}

/** Every operation the API answered PROCESSED is in the database, and nothing else is. */
async function processedMatchesAnswers(orm: MikroORM, wallets: string, expected: ExpectedBalances): Promise<CheckResult> {
  const [row] = await query<{ processed: number }>(
    orm,
    `select count(*)::int as processed from wager_transactions
      where wallet_id in ${wallets} and status = 'PROCESSED' and kind <> 'OPENING'`,
  );
  const processed = row?.processed ?? 0;
  return check(
    'Transações PROCESSED no banco = operações aceitas pelas respostas',
    processed === expected.processed(),
    `banco ${processed}, respostas ${expected.processed()}`,
  );
}

async function noDuplicateOperation(orm: MikroORM, wallets: string): Promise<CheckResult> {
  const duplicates = await query<{ external_transaction_id: string }>(
    orm,
    `select external_transaction_id from wager_transactions where wallet_id in ${wallets}
      group by provider_id, external_transaction_id having count(*) > 1`,
  );
  return check(
    'Nenhuma operação gravada duas vezes (providerId + externalTransactionId)',
    duplicates.length === 0,
    duplicates.length === 0 ? 'nenhuma' : `duplicadas: ${duplicates.map((row) => row.external_transaction_id).join(', ')}`,
  );
}

async function nothingPending(orm: MikroORM, wallets: string): Promise<CheckResult> {
  const [row] = await query<{ count: number }>(
    orm,
    `select count(*)::int as count from wager_transactions where wallet_id in ${wallets} and status = 'PENDING_REFERENCE'`,
  );
  return check('Nenhuma transação parada em PENDING_REFERENCE', (row?.count ?? 0) === 0, `${row?.count ?? 0} pendentes`);
}

async function outboxDrained(orm: MikroORM): Promise<CheckResult> {
  const pending = await unpublishedEvents(orm);
  return check('Outbox drenada (todo evento publicado)', pending === 0, `${pending} eventos sem publicar`);
}

/** Every event of the scenario's wallets reached wagering-events.fifo (copies allowed, losses not). */
async function everyEventDelivered(orm: MikroORM, drainer: EventsDrainer, wallets: string): Promise<CheckResult> {
  const rows = await query<{ id: string }>(orm, `select id from outbox_messages where aggregate_id in ${wallets}`);
  const missing = () => rows.filter((row) => !drainer.has(row.id));
  await pollUntil(async () => missing().length === 0, 30_000, 200);
  const lost = missing();
  return check(
    'Todo evento da outbox chegou à fila de eventos (nenhum perdido)',
    lost.length === 0,
    `${rows.length} eventos, ${lost.length} não recebidos; cópias repetidas recebidas no run até aqui: ${drainer.duplicateCopies()}`,
  );
}

async function queuesEmpty(sqs: SQSClient, queues: RunQueues): Promise<CheckResult> {
  const source = await queueDepth(sqs, queues.wager.url);
  const deadLetter = await queueDepth(sqs, queues.wager.deadLetterUrl);
  const left = source.visible + source.inFlight + deadLetter.visible + deadLetter.inFlight;
  return check(
    'Fila de entrada e DLQ vazias',
    left === 0,
    `entrada: ${source.visible} visíveis, ${source.inFlight} em voo; DLQ: ${deadLetter.visible + deadLetter.inFlight}`,
  );
}

/** The app's own reconciliation (POST /wallets/:id/reconciliation) agrees for every wallet. */
async function apiReconciliation(instance: Instance, walletIds: readonly string[]): Promise<CheckResult> {
  const inconsistent: string[] = [];
  for (const walletId of walletIds) {
    const response = await fetch(`${instance.baseUrl}/wallets/${walletId}/reconciliation`, { method: 'POST' });
    const body = (await response.json()) as { consistent?: boolean };
    if (body.consistent !== true) inconsistent.push(walletId);
  }
  return check(
    'Reconciliação da API consistente em todas as wallets',
    inconsistent.length === 0,
    inconsistent.length === 0 ? `${walletCount(walletIds.length)} consistente(s)` : `inconsistentes: ${inconsistent.join(', ')}`,
  );
}
