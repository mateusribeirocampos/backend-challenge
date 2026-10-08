import { randomUUID } from 'node:crypto';
import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { MetricName } from '../../src/application/ports/metrics.js';
import { verifyScenario } from '../checks.js';
import { inboxProcessedAtMs, inboxProcessedCount, pollUntil, statusesByExternalPrefix } from '../database.js';
import { type LoopWindow, RequestRecorder, RoundRobin } from '../http-load.js';
import { scrapeAll } from '../observers.js';
import { runAtFixedRate } from '../pacing.js';
import { counterDelta, type PromSample } from '../prometheus.js';
import type { CheckResult, ScenarioResult, SqsResult } from '../results.js';
import { type GeneratedLoad, measureStep } from '../step.js';
import { summarize } from '../stats.js';
import {
  ExpectedBalances,
  idempotencyKey,
  type LoadWallet,
  openWallets,
  submitWager,
  type WagerBody,
  type WagerKind,
  wagerBody,
  wasProcessed,
} from '../wagering.js';
import { BET_AMOUNT, firstInstance, type ScenarioContext, walletAt } from './http-bets.js';

/**
 * Scenario 3: rounds of BET followed by WIN, LOSS or REFUND, over HTTP and over SQS at the
 * same time, on a shared set of wallets, at FIXED rates (open loop). Scenarios 1 and 2 push
 * until the system saturates; this one asks how the latencies, the async path and the
 * outbox behave at a rate the system can sustain. Every fourth HTTP round also sends a
 * second REFUND of the same BET: the API must refuse it (REFERENCE_ALREADY_REVERSED), a
 * 422 that is the expected answer, not an error.
 */

type FollowUp = Exclude<WagerKind, 'BET'>;
const FOLLOW_UP_AMOUNT: Record<FollowUp, string> = { WIN: '2.00', LOSS: '0.00', REFUND: BET_AMOUNT };
const HTTP_CYCLE: readonly FollowUp[] = ['WIN', 'LOSS', 'REFUND', 'REFUND'];
const SQS_CYCLE: readonly FollowUp[] = ['WIN', 'LOSS', 'REFUND'];
const MESSAGE_PREFIX = 'load-mixed-';

interface SecondRefunds {
  sent: number;
  refusedAsReversed: number;
}

export async function runMixed(context: ScenarioContext): Promise<ScenarioResult> {
  const { settings } = context;
  const expected = new ExpectedBalances();
  const wallets = await openWallets(firstInstance(context), settings.mixedWallets);
  for (const wallet of wallets) expected.track(wallet);
  const secondRefunds: SecondRefunds = { sent: 0, refusedAsReversed: 0 };
  const producer = new SqsRoundProducer(context.sqs, context.queues.wager.url, wallets, expected);

  const step = await measureStep(context, {
    label: `${settings.mixedHttpRoundsPerSecond} rodadas/s HTTP + ${settings.mixedSqsRoundsPerSecond} rodadas/s SQS`,
    wallets: settings.mixedWallets,
    generate: async (onWindowStart): Promise<GeneratedLoad> => {
      const recorder = new RequestRecorder();
      const instances = new RoundRobin(context.instances);
      const warmupMs = settings.warmupSeconds * 1000;
      const totalMs = warmupMs + settings.mixedSeconds * 1000;
      const startMs = Date.now();
      const marker = setTimeout(onWindowStart, warmupMs);
      await Promise.all([
        runAtFixedRate(settings.mixedHttpRoundsPerSecond, totalMs, (round) =>
          httpRound(instances, recorder, expected, secondRefunds, walletAt(wallets, round % wallets.length), round),
        ),
        runAtFixedRate(settings.mixedSqsRoundsPerSecond, totalMs, (round) =>
          producer.sendRound(walletAt(wallets, round % wallets.length), round),
        ),
      ]);
      clearTimeout(marker);
      const window: LoopWindow = { startMs: startMs + warmupMs, endMs: startMs + totalMs };
      return { window, recorder };
    },
    settleSqs: (loadStoppedAtMs, metricsBefore, window) => producer.settle(context, loadStoppedAtMs, metricsBefore, window),
  });

  const checks = [
    ...(await verifyScenario({ ...context, instance: firstInstance(context), expected })),
    await everySqsOperationProcessed(context, producer.operations),
    secondRefundRefused(secondRefunds),
  ];
  return {
    id: 'mixed',
    title: 'Misto: HTTP e SQS em taxa fixa',
    description:
      'Rodadas de BET seguidas de WIN, LOSS ou REFUND, por HTTP e por SQS ao mesmo tempo, nas mesmas wallets, em taxa fixa (laço aberto: uma rodada começa a cada intervalo, sem esperar a anterior). Uma em cada quatro rodadas HTTP manda um segundo REFUND da mesma BET, que deve ser recusado com 422.',
    steps: [step],
    checks,
  };
}

/** One HTTP round: BET, then its follow-up; every fourth round also a second REFUND. */
async function httpRound(
  instances: RoundRobin,
  recorder: RequestRecorder,
  expected: ExpectedBalances,
  secondRefunds: SecondRefunds,
  wallet: LoadWallet,
  round: number,
): Promise<void> {
  const bet = wagerBody(wallet, 'BET', BET_AMOUNT);
  if (!wasProcessed(await submitWager(instances, bet, recorder))) return;
  expected.applyProcessed(wallet.id, 'BET', BET_AMOUNT);

  const followUp = HTTP_CYCLE[round % HTTP_CYCLE.length] ?? 'LOSS';
  const amount = FOLLOW_UP_AMOUNT[followUp];
  const reference = { roundId: bet.roundId, reference: bet.externalTransactionId };
  if (wasProcessed(await submitWager(instances, wagerBody(wallet, followUp, amount, reference), recorder))) {
    expected.applyProcessed(wallet.id, followUp, amount);
  }

  if (round % HTTP_CYCLE.length === HTTP_CYCLE.length - 1) {
    secondRefunds.sent += 1;
    const answer = await submitWager(instances, wagerBody(wallet, 'REFUND', BET_AMOUNT, reference), recorder);
    if (answer.status === 422 && answer.body.failureCode === 'REFERENCE_ALREADY_REVERSED') {
      secondRefunds.refusedAsReversed += 1;
    } else if (wasProcessed(answer)) {
      expected.applyProcessed(wallet.id, 'REFUND', BET_AMOUNT); // a bug: keep the balance check truthful
    }
  }
}

interface SentMessage {
  readonly messageId: string;
  readonly sentAtMs: number;
}

/**
 * Sends rounds over SQS: a BET and its follow-up with the same MessageGroupId (the
 * walletId), the BET first, so FIFO delivers them in that order. Each message counts in
 * the expected balance as processed; the check everySqsOperationProcessed confirms that
 * assumption against the database.
 */
class SqsRoundProducer {
  readonly sent: SentMessage[] = [];
  operations = 0;

  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
    private readonly wallets: readonly LoadWallet[],
    private readonly expected: ExpectedBalances,
  ) {}

  async sendRound(wallet: LoadWallet, round: number): Promise<void> {
    const bet = wagerBody(wallet, 'BET', BET_AMOUNT, undefined, 'sqs');
    const followUp = SQS_CYCLE[round % SQS_CYCLE.length] ?? 'LOSS';
    const amount = FOLLOW_UP_AMOUNT[followUp];
    const settle = wagerBody(wallet, followUp, amount, { roundId: bet.roundId, reference: bet.externalTransactionId }, 'sqs');
    await this.send(bet);
    await this.send(settle);
    this.expected.applyProcessed(wallet.id, 'BET', BET_AMOUNT);
    this.expected.applyProcessed(wallet.id, followUp, amount);
    this.operations += 2;
  }

  private async send(body: WagerBody): Promise<void> {
    const messageId = `${MESSAGE_PREFIX}${randomUUID()}`;
    const envelope = {
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: { ...body, idempotencyKey: idempotencyKey(body) },
    };
    const sentAtMs = Date.now();
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(envelope),
        MessageGroupId: body.walletId,
        MessageDeduplicationId: messageId,
      }),
    );
    this.sent.push({ messageId, sentAtMs });
  }

  /** Waits until every message was processed, then measures send to processed. */
  async settle(
    context: ScenarioContext,
    loadStoppedAtMs: number,
    metricsBefore: readonly PromSample[],
    window: LoopWindow,
  ): Promise<SqsResult> {
    const allProcessed = await pollUntil(
      async () => (await inboxProcessedCount(context.orm, MESSAGE_PREFIX)) >= this.sent.length,
      context.settings.drainTimeoutSeconds * 1000,
      100,
    );
    const drainMs = allProcessed ? Date.now() - loadStoppedAtMs : undefined;
    const metricsAfter = await scrapeAll(context.instances);
    const processedAt = await inboxProcessedAtMs(context.orm, MESSAGE_PREFIX);
    const inWindow = (ms: number) => ms >= window.startMs && ms < window.endMs;
    const windowSeconds = (window.endMs - window.startMs) / 1000;
    const sentInWindow = this.sent.filter((message) => inWindow(message.sentAtMs));

    const latencies = sentInWindow.flatMap((message) => {
      const processed = processedAt.get(message.messageId);
      return processed === undefined ? [] : [processed - message.sentAtMs];
    });
    return {
      sent: this.sent.length,
      processed: processedAt.size,
      offeredPerSecond: sentInWindow.length / windowSeconds,
      processedPerSecond: [...processedAt.values()].filter(inWindow).length / windowSeconds,
      sendToProcessedMs: summarize(latencies),
      retries: counterDelta(metricsBefore, metricsAfter, MetricName.MessageRetries),
      deadLettered: counterDelta(metricsBefore, metricsAfter, MetricName.MessagesDeadLettered),
      lockConflicts: counterDelta(metricsBefore, metricsAfter, MetricName.LockConflicts, { source: 'sqs' }),
      drainMs,
    };
  }
}

async function everySqsOperationProcessed(context: ScenarioContext, operations: number): Promise<CheckResult> {
  const statuses = await statusesByExternalPrefix(context.orm, 'ext-sqs-');
  const processed = statuses.PROCESSED ?? 0;
  const total = Object.values(statuses).reduce((sum, count) => sum + count, 0);
  return {
    name: 'Toda operação enviada por SQS foi processada uma vez',
    passed: processed === operations && total === operations,
    detail: `${operations} enviadas, ${total} gravadas (${JSON.stringify(statuses)})`,
  };
}

function secondRefundRefused(secondRefunds: SecondRefunds): CheckResult {
  return {
    name: 'Segundo REFUND da mesma BET recusado (REFERENCE_ALREADY_REVERSED)',
    passed: secondRefunds.refusedAsReversed === secondRefunds.sent,
    detail: `${secondRefunds.refusedAsReversed} de ${secondRefunds.sent} recusados`,
  };
}
