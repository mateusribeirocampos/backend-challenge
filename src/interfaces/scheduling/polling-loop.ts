import { setTimeout as sleep } from 'node:timers/promises';
import { summarizeError } from '../../application/error-summary.js';
import type { StructuredLogger } from '../../application/ports/structured-logger.js';

export interface PollingLoopSettings {
  /** Pause after a run that found no more work. */
  readonly idleDelayMs: number;
  /** Longest pause after failed runs (it doubles from idleDelayMs at each failure in a row). */
  readonly maxErrorDelayMs: number;
  /** On stop, how long to wait for the run in progress. */
  readonly shutdownTimeoutMs: number;
}

/**
 * One run of a background task. Receives shouldStop() to check between items, and
 * returns true when there may be more work right away (a full batch), so the loop
 * runs again without pausing.
 */
export type PollingTask = (shouldStop: () => boolean) => Promise<boolean>;

/**
 * Runs a background task (outbox publisher, PENDING_REFERENCE worker) over and over in
 * this process, like a @Scheduled method in Spring with a fixed delay. Every instance
 * runs its own loop; they never coordinate in memory: the database (FOR UPDATE SKIP
 * LOCKED) decides who gets which row.
 *
 * stop() is the graceful shutdown: no new run starts, the run in progress sees
 * shouldStop() = true, finishes the item it is on and gives back the rest.
 */
export class PollingLoop {
  private loop: Promise<void> | undefined;
  private stopping = false;
  /** Cuts a pause short on stop. Never interrupts a run. */
  private readonly stopSignal = new AbortController();

  constructor(
    private readonly name: string,
    private readonly task: PollingTask,
    private readonly settings: PollingLoopSettings,
    private readonly logger: StructuredLogger,
  ) {}

  start(): void {
    if (this.loop !== undefined) {
      return;
    }
    this.logger.info('worker.started', { worker: this.name });
    this.loop = this.runUntilStopped();
  }

  async stop(): Promise<void> {
    if (this.loop === undefined || this.stopping) {
      return;
    }
    this.stopping = true;
    this.stopSignal.abort();
    const finished = await settlesWithin(this.loop, this.settings.shutdownTimeoutMs);
    const fields = { worker: this.name, finished };
    if (finished) {
      this.logger.info('worker.stopped', fields);
    } else {
      this.logger.warn('worker.stopped', fields);
    }
  }

  private async runUntilStopped(): Promise<void> {
    let consecutiveFailures = 0;
    while (!this.stopping) {
      try {
        const moreWork = await this.task(() => this.stopping);
        consecutiveFailures = 0;
        if (!moreWork) {
          await this.pause(this.settings.idleDelayMs);
        }
      } catch (error) {
        // Never let the loop die: log, wait longer each time, try again.
        consecutiveFailures += 1;
        this.logger.error('worker.run_failed', { worker: this.name, consecutiveFailures, ...summarizeError(error) });
        await this.pause(this.errorDelayMs(consecutiveFailures));
      }
    }
  }

  private errorDelayMs(consecutiveFailures: number): number {
    return Math.min(this.settings.maxErrorDelayMs, this.settings.idleDelayMs * 2 ** consecutiveFailures);
  }

  private async pause(ms: number): Promise<void> {
    try {
      await sleep(ms, undefined, { signal: this.stopSignal.signal });
    } catch {
      // stop() aborted the pause.
    }
  }
}

async function settlesWithin(work: Promise<void>, timeoutMs: number): Promise<boolean> {
  const timer = new AbortController();
  const timedOut = sleep(timeoutMs, false, { signal: timer.signal }).catch(() => false);
  const finished = await Promise.race([work.then(() => true), timedOut]);
  timer.abort();
  return finished;
}
