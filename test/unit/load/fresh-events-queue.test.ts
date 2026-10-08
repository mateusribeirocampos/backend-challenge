import { describe, expect, test } from 'bun:test';
import { recreateWhenDrained } from '../../../load/step.js';

/** The events queue is recreated between steps only when nothing in it can be lost. */
describe('recreateWhenDrained', () => {
  function attempt(outboxEmpty: boolean, everyEventReceived: boolean) {
    let recreated = false;
    const run = recreateWhenDrained({
      outboxEmpty: async () => outboxEmpty,
      everyEventReceived: async () => everyEventReceived,
      recreate: async () => {
        recreated = true;
      },
    });
    return { run, recreated: () => recreated };
  }

  test('both waits done: the queue is recreated', async () => {
    const { run, recreated } = attempt(true, true);
    await run;
    expect(recreated()).toBe(true);
  });

  test('the outbox did not drain in time: the step fails and the old queue is kept', async () => {
    const { run, recreated } = attempt(false, true);
    await expect(run).rejects.toThrow('outbox');
    expect(recreated()).toBe(false);
  });

  test('published events still missing from the queue: the step fails and the old queue is kept', async () => {
    const { run, recreated } = attempt(true, false);
    await expect(run).rejects.toThrow('received');
    expect(recreated()).toBe(false);
  });
});
