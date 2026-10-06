import { describe, expect, test } from 'bun:test';
import { checkReadiness, type DependencyCheck } from '../../../../src/application/health/check-readiness.js';

function upCheck(name: string): DependencyCheck {
  return { name, check: async () => {} };
}

function downCheck(name: string, error: Error): DependencyCheck {
  return {
    name,
    check: async () => {
      throw error;
    },
  };
}

/** Never resolves on its own; only stops when the readiness timeout aborts it. */
function hangingCheck(name: string): DependencyCheck & { aborted: () => boolean } {
  let wasAborted = false;
  return {
    name,
    aborted: () => wasAborted,
    check: (signal) =>
      new Promise<void>(() => {
        signal.addEventListener('abort', () => {
          wasAborted = true;
        });
      }),
  };
}

describe('checkReadiness', () => {
  test('ready when every dependency answers', async () => {
    const report = await checkReadiness([upCheck('database'), upCheck('sqs')], 100);

    expect(report).toEqual({ ready: true, checks: { database: 'up', sqs: 'up' }, failed: [] });
  });

  test('not ready, naming the dependency that failed and why', async () => {
    const report = await checkReadiness(
      [upCheck('database'), downCheck('sqs', new Error('queue does not exist'))],
      100,
    );

    expect(report.ready).toBe(false);
    expect(report.checks).toEqual({ database: 'up', sqs: 'down' });
    expect(report.failed).toEqual([{ name: 'sqs', reason: 'queue does not exist' }]);
  });

  test('uses the error code when the driver error has no message', async () => {
    const refused = Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' });

    const report = await checkReadiness([downCheck('database', refused)], 100);

    expect(report.failed).toEqual([{ name: 'database', reason: 'ECONNREFUSED' }]);
  });

  test('a hanging dependency is reported as down after the timeout and its call is aborted', async () => {
    const hanging = hangingCheck('database');

    const report = await checkReadiness([hanging, upCheck('sqs')], 20);

    expect(report.checks).toEqual({ database: 'down', sqs: 'up' });
    expect(report.failed).toEqual([{ name: 'database', reason: 'timed out after 20ms' }]);
    expect(hanging.aborted()).toBe(true);
  });
});
