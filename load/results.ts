import type { SendProbe } from './emulator-probe.js';
import type { WaitShare } from './observers.js';
import type { LatencySummary } from './stats.js';

/**
 * What one run of `bun run test:load` measured. Saved as JSON under load-results/ and
 * turned into docs/teste-de-carga.md by report.ts. Durations are milliseconds or
 * seconds (number); no money value is ever stored here.
 */

export type ScenarioId = 'distinct-wallets' | 'hot-wallet' | 'mixed';

/** Final HTTP answers in the measured window, by class. */
export interface RequestCounts {
  readonly total: number;
  /** 200, 201, 202: the operation was taken (201 processed, 200 replay, 202 pending). */
  readonly accepted: number;
  /** 422: a business rule said no (INSUFFICIENT_FUNDS, REFERENCE_ALREADY_REVERSED...). Expected, not an error. */
  readonly businessRejections: number;
  /** 503 + Retry-After: lock timeout, deadlock or database unavailable. */
  readonly unavailable: number;
  readonly otherServerErrors: number;
  readonly otherClientErrors: number;
  /** fetch failed: connection refused, reset, timeout. */
  readonly networkErrors: number;
  /** Every status seen, e.g. { "201": 900, "422": 3 }, so nothing hides behind a class. */
  readonly byStatus: Readonly<Record<string, number>>;
}

/** Average cores used during the window: CPU seconds / wall seconds. */
export interface CpuCores {
  readonly appInstances: readonly number[];
  readonly postgres: number | undefined;
  readonly sqsEmulator: number | undefined;
  readonly loadGenerator: number;
}

export interface OutboxResult {
  /** Events written in the window. */
  readonly events: number;
  /** Events written per second in the window, and events the publishers sent per second in it. */
  readonly writtenPerSecond: number;
  readonly publishedPerSecond: number;
  /** Largest wager_outbox_lag_seconds seen on /metrics (any instance) from the window start until drained. */
  readonly gaugeMaxSeconds: number | undefined;
  readonly gaugeSamples: number;
  /** published_at - occurred_at of each event written in the window, from the database. */
  readonly eventLagMs: LatencySummary | undefined;
  /** From the moment the last client stopped until no event was left unpublished. */
  readonly drainMs: number | undefined;
}

/** The asynchronous path of the mixed scenario: SendMessage to processed (inbox row). */
export interface SqsResult {
  readonly sent: number;
  readonly processed: number;
  readonly offeredPerSecond: number;
  readonly processedPerSecond: number;
  readonly sendToProcessedMs: LatencySummary | undefined;
  readonly retries: number;
  readonly deadLettered: number;
  readonly lockConflicts: number;
  /** From the moment the producer stopped until every message was processed. */
  readonly drainMs: number | undefined;
}

export interface StepResult {
  /** "16 clientes", or the fixed rates of the mixed scenario. */
  readonly label: string;
  /** Closed-loop clients; undefined for the open-loop (fixed rate) mixed scenario. */
  readonly clients: number | undefined;
  readonly wallets: number;
  readonly warmupSeconds: number;
  /** Real length of the measured window (it can exceed the configured one by a few ms). */
  readonly windowSeconds: number;
  readonly requests: RequestCounts;
  readonly acceptedPerSecond: number;
  /** Final answers (accepted + 422) per second: work the system finished. */
  readonly answeredPerSecond: number;
  /** Client side: from fetch() to the end of the response body, every request in the window. */
  readonly latencyMs: LatencySummary | undefined;
  /** Server side estimate from the wager_processing_duration_seconds{source="http"} histogram. */
  readonly serverLatencyMs: { readonly p50: number; readonly p95: number; readonly p99: number } | undefined;
  /** wager_lock_conflicts_total in the window, by source. */
  readonly lockConflicts: { readonly http: number; readonly sqs: number };
  readonly outbox: OutboxResult;
  readonly cpuCores: CpuCores | undefined;
  /** State and wait event of the busy PostgreSQL connections, sampled in the window, most frequent first. */
  readonly postgresWaits: readonly WaitShare[];
  readonly sqs?: SqsResult;
}

export interface CheckResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface ScenarioResult {
  readonly id: ScenarioId;
  readonly title: string;
  readonly description: string;
  readonly steps: readonly StepResult[];
  readonly checks: readonly CheckResult[];
}

export interface Environment {
  readonly cpuModel: string;
  readonly logicalCores: number;
  readonly memoryGiB: number;
  readonly os: string;
  readonly kernel: string;
  readonly bun: string;
  readonly postgres: string;
  readonly postgresSettings: Readonly<Record<string, string>>;
  readonly sqsEmulator: string;
  /** SendMessage rate of the emulator on an empty FIFO queue and after a few thousand messages. */
  readonly sqsSendProbe: SendProbe;
  readonly appInstances: number;
  /** Connections per instance (pg-pool default: the project does not set one). */
  readonly poolSizePerInstance: number;
  readonly lockTimeout: string;
  readonly consumer: { readonly visibilityTimeoutSeconds: number; readonly waitTimeSeconds: number; readonly maxMessages: number };
  readonly publisher: { readonly leaseSeconds: number; readonly batchSize: number; readonly pollIntervalMs: number };
}

export interface RunSettingsView {
  readonly warmupSeconds: number;
  readonly stepSeconds: number;
  readonly clientSteps: readonly number[];
  readonly hotWallets: number;
  readonly mixedWallets: number;
  readonly mixedSeconds: number;
  /** Mixed scenario, open loop: HTTP rounds (2 or 3 requests) and SQS rounds (2 messages) started per second. */
  readonly mixedHttpRoundsPerSecond: number;
  readonly mixedSqsRoundsPerSecond: number;
}

export interface LoadRunResult {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly environment: Environment;
  readonly settings: RunSettingsView;
  readonly scenarios: readonly ScenarioResult[];
}
