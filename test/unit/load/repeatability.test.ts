import { describe, expect, test } from 'bun:test';
import { median, medianRunIndex, renderRepeatability } from '../../../load/repeatability.js';
import type { LoadRunResult } from '../../../load/results.js';

/** Only the fields the repeatability section reads; the rest of a run does not matter here. */
function run(startedAt: string, distinct64: number, hotP99: number, checksPassed: boolean[]): LoadRunResult {
  const step = (label: string, accepted: number, p50: number, p99: number) => ({
    label,
    acceptedPerSecond: accepted,
    latencyMs: { count: 100, p50, p95: p99, p99, max: p99, mean: p50 },
    outbox: { publishedPerSecond: accepted / 2 },
  });
  return {
    startedAt,
    scenarios: [
      {
        id: 'distinct-wallets',
        title: 'Wallets distintas',
        steps: [step('1 cliente', 200, 5, 8), step('64 clientes', distinct64, 60, 100)],
        checks: checksPassed.map((passed) => ({ name: 'saldo = ledger', passed, detail: '' })),
      },
      {
        id: 'hot-wallet',
        title: 'Hot wallet',
        steps: [step('64 clientes', 160, 340, hotP99)],
        checks: [{ name: 'saldo = ledger', passed: true, detail: '' }],
      },
    ],
  } as unknown as LoadRunResult;
}

describe('median', () => {
  test('is the middle value of an odd count and the mean of the two middle ones of an even count', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  test('throws on an empty list instead of inventing a number', () => {
    expect(() => median([])).toThrow();
  });
});

describe('medianRunIndex', () => {
  test('picks the run whose throughput with the most clients on distinct wallets is the median', () => {
    const runs = [run('r1', 900, 1200, [true]), run('r2', 1000, 1300, [true]), run('r3', 950, 1250, [true])];

    expect(medianRunIndex(runs)).toBe(2);
  });
});

describe('renderRepeatability', () => {
  const runs = [run('r1', 900, 1200, [true, true]), run('r2', 1000, 1300, [true, true]), run('r3', 950, 1250, [true, false])];
  const section = renderRepeatability(runs, 2);

  test('has one column per run, the median and the spread relative to the median', () => {
    expect(section).toContain('| Rodada 1 | Rodada 2 | Rodada 3 | Mediana | Variação |');
    // 64 clients on distinct wallets: 900, 1000, 950 → median 950, spread (1000 - 900) / 950 = 11 %
    expect(section).toContain('| Wallets distintas | 64 clientes | aceitas/s | 900,0 | 1.000,0 | 950,0 | 950,0 | 11 % |');
  });

  test('says which run is the main report and counts the correctness checks per run', () => {
    expect(section).toContain('rodada 3');
    expect(section).toContain('rodada 1: 3/3');
    expect(section).toContain('rodada 3: 2/3');
  });
});
