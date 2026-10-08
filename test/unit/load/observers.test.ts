import { describe, expect, test } from 'bun:test';
import type { Instance } from '../../../load/cluster.js';
import { OutboxLagSampler } from '../../../load/observers.js';

/** A /metrics endpoint whose first scrape is slow and reports 999; the next ones answer 1 at once. */
function metricsServer() {
  let scrapes = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const server = Bun.serve({
    port: 0,
    async fetch() {
      scrapes += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const slow = scrapes === 1;
      if (slow) await Bun.sleep(150);
      inFlight -= 1;
      return new Response(`# TYPE wager_outbox_lag_seconds gauge\nwager_outbox_lag_seconds ${slow ? 999 : 1}\n`);
    },
  });
  return { server, maxInFlight: () => maxInFlight };
}

describe('OutboxLagSampler', () => {
  test('stop() returns every sample taken, including a slow one still running when it was called', async () => {
    const { server, maxInFlight } = metricsServer();
    try {
      const instance = { name: 'stub', baseUrl: `http://127.0.0.1:${server.port}`, pid: 0 } as unknown as Instance;
      const sampler = new OutboxLagSampler([instance], 10);
      sampler.start();
      await Bun.sleep(50); // the slow first scrape is still running

      const samples = await sampler.stop();

      expect(samples).toContain(999);
      // One scrape at a time: a tick that finds one running is skipped.
      expect(maxInFlight()).toBe(1);
    } finally {
      server.stop(true);
    }
  });
});
