import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { MetricName } from '../src/application/ports/metrics.js';
import { type Instance, recreateEventsQueue, type RunQueues } from './cluster.js';
import type { EventsDrainer } from './events-drainer.js';
import { eventLagsMs, eventsPublished, eventsWritten, pollUntil, totalEvents, unpublishedEvents } from './database.js';
import { countRequests, type LoopWindow, type RequestRecorder } from './http-load.js';
import {
  type ContainerIds,
  type CpuReading,
  cpuCoresBetween,
  OutboxLagSampler,
  PostgresWaitSampler,
  readCpu,
  scrapeAll,
} from './observers.js';
import { counterDelta, histogramBuckets, histogramDelta, histogramQuantile, type PromSample } from './prometheus.js';
import type { SqsResult, StepResult } from './results.js';
import type { LoadSettings } from './settings.js';
import { summarize } from './stats.js';

/**
 * One measured step: run the load, take the readings at the start and at the end of the
 * measured window, wait for the asynchronous work to finish, and put the numbers together.
 * The three scenarios only decide WHAT each client sends; HOW it is measured is here.
 */

export interface StepContext {
  readonly instances: readonly Instance[];
  readonly orm: MikroORM;
  readonly containers: ContainerIds;
  readonly settings: LoadSettings;
  readonly drainer: EventsDrainer;
  readonly sqs: SQSClient;
  readonly queues: RunQueues;
}

export interface GeneratedLoad {
  readonly window: LoopWindow;
  readonly recorder: RequestRecorder;
}

export interface StepPlan {
  readonly label: string;
  readonly clients?: number;
  readonly wallets: number;
  /** Runs the clients; must call onWindowStart when the warm-up ends. */
  readonly generate: (onWindowStart: () => void) => Promise<GeneratedLoad>;
  /** Mixed scenario: waits for the SQS messages and measures them, before the outbox drain. */
  readonly settleSqs?: (loadStoppedAtMs: number, metricsBefore: readonly PromSample[], window: LoopWindow) => Promise<SqsResult>;
}

interface Readings {
  readonly metrics: PromSample[];
  readonly cpu: CpuReading;
}

async function takeReadings(context: StepContext): Promise<Readings> {
  const cpu = readCpu(context.instances, context.containers);
  return { metrics: await scrapeAll(context.instances), cpu };
}

export async function measureStep(context: StepContext, plan: StepPlan): Promise<StepResult> {
  await startOnFreshEventsQueue(context);
  const sampler = new OutboxLagSampler(context.instances);
  sampler.start();
  const waits = new PostgresWaitSampler(context.orm);
  let windowStart: Promise<Readings> | undefined;
  const { window, recorder } = await plan.generate(() => {
    windowStart = takeReadings(context);
    waits.start();
  });
  const postgresWaits = await waits.stop();
  const end = await takeReadings(context);
  const loadStoppedAtMs = Date.now();
  if (windowStart === undefined) throw new Error('the load ended before the warm-up');
  const start = await windowStart;

  const sqs = await plan.settleSqs?.(loadStoppedAtMs, start.metrics, window);
  const drained = await pollUntil(
    async () => (await unpublishedEvents(context.orm)) === 0,
    context.settings.drainTimeoutSeconds * 1000,
  );
  const drainMs = drained ? Date.now() - loadStoppedAtMs : undefined;
  const gaugeSamples = await sampler.stop();

  const samples = recorder.inWindow(window.startMs, window.endMs);
  const requests = countRequests(samples);
  const windowSeconds = (window.endMs - window.startMs) / 1000;
  const finalAnswers = requests.accepted + requests.businessRejections;
  const events = await eventsWritten(context.orm, window.startMs, window.endMs);

  return {
    label: plan.label,
    clients: plan.clients,
    wallets: plan.wallets,
    warmupSeconds: context.settings.warmupSeconds,
    windowSeconds,
    requests,
    acceptedPerSecond: requests.accepted / windowSeconds,
    answeredPerSecond: finalAnswers / windowSeconds,
    latencyMs: summarize(samples.map((sample) => sample.latencyMs)),
    serverLatencyMs: serverLatency(start.metrics, end.metrics),
    lockConflicts: {
      http: counterDelta(start.metrics, end.metrics, MetricName.LockConflicts, { source: 'http' }),
      sqs: counterDelta(start.metrics, end.metrics, MetricName.LockConflicts, { source: 'sqs' }),
    },
    outbox: {
      events,
      writtenPerSecond: events / windowSeconds,
      publishedPerSecond: (await eventsPublished(context.orm, window.startMs, window.endMs)) / windowSeconds,
      gaugeMaxSeconds: gaugeSamples.length === 0 ? undefined : Math.max(...gaugeSamples),
      gaugeSamples: gaugeSamples.length,
      eventLagMs: summarize(await eventLagsMs(context.orm, window.startMs, window.endMs)),
      drainMs,
    },
    cpuCores: cpuCoresBetween(start.cpu, end.cpu),
    postgresWaits: postgresWaits.slice(0, 5),
    ...(sqs === undefined ? {} : { sqs }),
  };
}

/**
 * MiniStack (1.5.22) rebuilds a FIFO queue's whole deduplication cache on every
 * SendMessage (services/sqs.py, _prune_dedup), so each send costs time proportional to
 * the messages sent to that queue in the last 5 minutes. Real SQS has no such cost.
 * Recreating the events queue (same name, same URL, so the instances keep sending to it)
 * gives each step the same starting point. Done only when the outbox is empty and every
 * published event was received, so nothing in the old queue is lost.
 */
async function startOnFreshEventsQueue(context: StepContext): Promise<void> {
  const timeoutMs = context.settings.drainTimeoutSeconds * 1000;
  await recreateWhenDrained({
    outboxEmpty: () => pollUntil(async () => (await unpublishedEvents(context.orm)) === 0, timeoutMs),
    everyEventReceived: () => pollUntil(async () => context.drainer.received() >= (await totalEvents(context.orm)), timeoutMs),
    recreate: () => recreateEventsQueue(context.sqs, context.queues.events),
  });
}

export interface DrainedQueueSteps {
  /** true once no event is left unpublished, false when the drain timeout ran out. */
  readonly outboxEmpty: () => Promise<boolean>;
  /** true once every published event was read from the events queue, false on timeout. */
  readonly everyEventReceived: () => Promise<boolean>;
  readonly recreate: () => Promise<void>;
}

/**
 * Recreates the events queue only after both waits succeeded. A wait that timed out
 * fails the step instead: deleting the queue then would throw away events not read yet,
 * and the next step would not start from the conditions the report describes.
 */
export async function recreateWhenDrained(steps: DrainedQueueSteps): Promise<void> {
  if (!(await steps.outboxEmpty())) {
    throw new Error('the outbox did not drain within LOAD_DRAIN_TIMEOUT_SECONDS: events queue kept, step aborted');
  }
  if (!(await steps.everyEventReceived())) {
    throw new Error('published events were not all received within LOAD_DRAIN_TIMEOUT_SECONDS: events queue kept, step aborted');
  }
  await steps.recreate();
}

/** p50/p95/p99 in ms estimated from the HTTP histogram buckets observed in the window. */
function serverLatency(before: readonly PromSample[], after: readonly PromSample[]): StepResult['serverLatencyMs'] {
  const delta = histogramDelta(
    histogramBuckets(before, MetricName.ProcessingDuration, { source: 'http' }),
    histogramBuckets(after, MetricName.ProcessingDuration, { source: 'http' }),
  );
  const quantileMs = (quantile: number) => {
    const seconds = histogramQuantile(delta, quantile);
    return seconds === undefined ? undefined : seconds * 1000;
  };
  const [p50, p95, p99] = [quantileMs(0.5), quantileMs(0.95), quantileMs(0.99)];
  return p50 === undefined || p95 === undefined || p99 === undefined ? undefined : { p50, p95, p99 };
}
