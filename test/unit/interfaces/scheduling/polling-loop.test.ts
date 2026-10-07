import { describe, expect, test } from 'bun:test';
import { PollingLoop, type PollingLoopSettings } from '../../../../src/interfaces/scheduling/polling-loop.js';
import { CapturingLogger } from '../../../integration/support/capturing-logger.js';

const SETTINGS: PollingLoopSettings = { idleDelayMs: 5, maxErrorDelayMs: 20, shutdownTimeoutMs: 1_000 };

async function waitFor(description: string, condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${description}`);
    await Bun.sleep(1);
  }
}

describe('PollingLoop', () => {
  test('runs again at once while the task says there is more work, then pauses', async () => {
    const answers = [true, true, false];
    let runs = 0;
    const loop = new PollingLoop('test', async () => answers[runs++] ?? false, SETTINGS, new CapturingLogger());

    loop.start();
    await waitFor('four runs', () => runs >= 4);
    await loop.stop();

    expect(runs).toBeGreaterThanOrEqual(4);
  });

  test('stop waits for the run in progress, which sees shouldStop() = true, and starts no new run', async () => {
    let finishRun: () => void = () => {};
    let sawStop = false;
    let runs = 0;
    const loop = new PollingLoop(
      'test',
      async (shouldStop) => {
        runs += 1;
        await new Promise<void>((resolve) => {
          finishRun = resolve;
        });
        sawStop = shouldStop();
        return true;
      },
      SETTINGS,
      new CapturingLogger(),
    );

    loop.start();
    await waitFor('the first run', () => runs === 1);
    const stopped = loop.stop();
    finishRun();
    await stopped;

    expect(sawStop).toBe(true);
    expect(runs).toBe(1);
  });

  test('an error does not end the loop: it is logged and the task runs again after a pause', async () => {
    let runs = 0;
    const logs = new CapturingLogger();
    const loop = new PollingLoop(
      'publisher',
      async () => {
        runs += 1;
        if (runs === 1) throw new Error('database down');
        return false;
      },
      SETTINGS,
      logs,
    );

    loop.start();
    await waitFor('a second run', () => runs >= 2);
    await loop.stop();

    expect(logs.events('worker.run_failed')[0]?.fields).toEqual(
      expect.objectContaining({ worker: 'publisher', error: 'Error: database down', consecutiveFailures: 1 }),
    );
  });

  test('stop during a pause returns without waiting for the pause to end', async () => {
    const loop = new PollingLoop('test', async () => false, { ...SETTINGS, idleDelayMs: 60_000 }, new CapturingLogger());
    loop.start();
    await Bun.sleep(5);

    const startedAt = Date.now();
    await loop.stop();

    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});
