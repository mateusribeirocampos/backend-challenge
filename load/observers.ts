import { readFileSync } from 'node:fs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { MetricName } from '../src/application/ports/metrics.js';
import type { Instance } from './cluster.js';
import { query } from './database.js';
import { maxOf, parsePrometheusText, type PromSample } from './prometheus.js';
import type { CpuCores } from './results.js';

/**
 * What the runner watches while the clients work: GET /metrics of every instance, the
 * outbox lag gauge over time, and how much CPU each component used.
 */

/** GET /metrics of every instance, concatenated (sumOf/maxOf work across instances). */
export async function scrapeAll(instances: readonly Instance[]): Promise<PromSample[]> {
  const texts = await Promise.all(instances.map(async (instance) => (await fetch(`${instance.baseUrl}/metrics`)).text()));
  return texts.flatMap(parsePrometheusText);
}

/**
 * Reads wager_outbox_lag_seconds every interval. Each publisher sets it after each batch
 * to the age of the oldest unpublished event; the largest value among the instances is
 * the freshest view of the backlog.
 */
export class OutboxLagSampler {
  private readonly samples: number[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> = Promise.resolve();

  constructor(
    private readonly instances: readonly Instance[],
    private readonly intervalMs = 500,
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      this.inFlight = this.sample();
    }, this.intervalMs);
  }

  async stop(): Promise<number[]> {
    clearInterval(this.timer);
    await this.inFlight;
    return [...this.samples];
  }

  private async sample(): Promise<void> {
    try {
      const lag = maxOf(await scrapeAll(this.instances), MetricName.OutboxLagSeconds);
      if (lag !== undefined) this.samples.push(lag);
    } catch {
      // a missed sample is not a measurement; the next one will come
    }
  }
}

/** Cumulative CPU seconds of each component at one moment. */
export interface CpuReading {
  readonly atMs: number;
  readonly appInstances: readonly number[];
  readonly postgres: number | undefined;
  readonly sqsEmulator: number | undefined;
  readonly loadGenerator: number;
}

export interface ContainerIds {
  readonly postgres: string | undefined;
  readonly sqsEmulator: string | undefined;
}

/** Container ids of the compose services, to read their cgroup CPU counters. */
export function containerIds(): ContainerIds {
  const idOf = (service: string) => {
    const result = Bun.spawnSync(['docker', 'compose', 'ps', '-q', service], { cwd: `${import.meta.dir}/..` });
    const id = result.stdout.toString().trim();
    return result.exitCode === 0 && id !== '' ? id : undefined;
  };
  return { postgres: idOf('postgres'), sqsEmulator: idOf('sqs') };
}

/** Clock ticks per second of /proc/<pid>/stat (USER_HZ), 100 on almost every Linux. */
const TICKS_PER_SECOND = Number.parseInt(Bun.spawnSync(['getconf', 'CLK_TCK']).stdout.toString().trim(), 10) || 100;

export function readCpu(instances: readonly Instance[], containers: ContainerIds): CpuReading {
  const ownUsage = process.cpuUsage();
  return {
    atMs: performance.now(),
    appInstances: instances.map((instance) => processCpuSeconds(instance.pid) ?? 0),
    postgres: containerCpuSeconds(containers.postgres),
    sqsEmulator: containerCpuSeconds(containers.sqsEmulator),
    loadGenerator: (ownUsage.user + ownUsage.system) / 1_000_000,
  };
}

/** Average cores each component used between two readings. */
export function cpuCoresBetween(before: CpuReading, after: CpuReading): CpuCores {
  const seconds = (after.atMs - before.atMs) / 1000;
  const cores = (start: number | undefined, end: number | undefined) =>
    start === undefined || end === undefined ? undefined : (end - start) / seconds;
  return {
    appInstances: after.appInstances.map((end, index) => cores(before.appInstances[index], end) ?? 0),
    postgres: cores(before.postgres, after.postgres),
    sqsEmulator: cores(before.sqsEmulator, after.sqsEmulator),
    loadGenerator: (after.loadGenerator - before.loadGenerator) / seconds,
  };
}

/** utime + stime of every thread of the process (fields 14 and 15 of /proc/<pid>/stat). */
function processCpuSeconds(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The command name (field 2) is in parentheses and may contain spaces: split after it.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const userTicks = Number.parseInt(fields[11] ?? '', 10);
    const systemTicks = Number.parseInt(fields[12] ?? '', 10);
    return (userTicks + systemTicks) / TICKS_PER_SECOND;
  } catch {
    return undefined;
  }
}

/** usage_usec of the container's cgroup (cgroup v2 with the systemd driver), every process in it. */
function containerCpuSeconds(containerId: string | undefined): number | undefined {
  if (containerId === undefined) return undefined;
  try {
    const stat = readFileSync(`/sys/fs/cgroup/system.slice/docker-${containerId}.scope/cpu.stat`, 'utf8');
    const usage = /^usage_usec (\d+)$/m.exec(stat)?.[1];
    return usage === undefined ? undefined : Number.parseInt(usage, 10) / 1_000_000;
  } catch {
    return undefined; // other cgroup layout (macOS, cgroup v1): the report shows n/d
  }
}

export interface WaitShare {
  /** Backend state plus wait event, e.g. "active / Lock:transactionid"; "active" alone means running on CPU. */
  readonly wait: string;
  /** Fraction of the samples of busy (not idle) connections. */
  readonly share: number;
}

/**
 * Where the database connections of the app spend their time: samples pg_stat_activity
 * and counts the state and wait event of every connection that is not idle. Shows, for
 * example, that in the hot wallet almost every connection waits for the wallet row's lock.
 */
export class PostgresWaitSampler {
  private readonly counts = new Map<string, number>();
  private total = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> = Promise.resolve();

  constructor(
    private readonly orm: MikroORM,
    private readonly intervalMs = 250,
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      this.inFlight = this.sample();
    }, this.intervalMs);
  }

  async stop(): Promise<WaitShare[]> {
    clearInterval(this.timer);
    await this.inFlight;
    return [...this.counts]
      .map(([wait, count]) => ({ wait, share: count / Math.max(1, this.total) }))
      .sort((left, right) => right.share - left.share);
  }

  private async sample(): Promise<void> {
    try {
      const rows = await query<{ wait: string }>(
        this.orm,
        `select state || coalesce(' / ' || wait_event_type || ':' || wait_event, '') as wait
           from pg_stat_activity
          where datname = current_database() and backend_type = 'client backend'
            and state <> 'idle' and pid <> pg_backend_pid()`,
      );
      for (const row of rows) {
        this.counts.set(row.wait, (this.counts.get(row.wait) ?? 0) + 1);
        this.total += 1;
      }
    } catch {
      // a missed sample is not a measurement
    }
  }
}
