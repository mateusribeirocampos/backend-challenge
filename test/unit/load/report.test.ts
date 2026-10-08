import { describe, expect, test } from 'bun:test';
import { renderReport } from '../../../load/report.js';
import type { CheckResult, LoadRunResult, ScenarioResult, StepResult } from '../../../load/results.js';

/** A step with plausible numbers; override what a test is about. */
function step(overrides: Partial<StepResult> = {}): StepResult {
  return {
    label: '8 clientes',
    clients: 8,
    wallets: 8,
    warmupSeconds: 2,
    windowSeconds: 6,
    requests: {
      total: 6000,
      accepted: 6000,
      businessRejections: 0,
      unavailable: 0,
      otherServerErrors: 0,
      otherClientErrors: 0,
      networkErrors: 0,
      byStatus: { '201': 6000 },
    },
    acceptedPerSecond: 1000,
    answeredPerSecond: 1000,
    latencyMs: { count: 6000, p50: 7.6, p95: 12.25, p99: 15.8, max: 40.1, mean: 8 },
    serverLatencyMs: { p50: 6.3, p95: 9.8, p99: 18.5 },
    lockConflicts: { http: 0, sqs: 0 },
    outbox: {
      events: 12000,
      writtenPerSecond: 2000,
      publishedPerSecond: 300,
      gaugeMaxSeconds: 30.5,
      gaugeSamples: 60,
      eventLagMs: { count: 12000, p50: 10000, p95: 25000, p99: 28000, max: 29000, mean: 12000 },
      drainMs: 41000,
    },
    cpuCores: { appInstances: [1.1, 1.05, 0.98], postgres: 4.3, sqsEmulator: 1, loadGenerator: 0.3 },
    postgresWaits: [{ wait: 'active', share: 0.5 }],
    ...overrides,
  };
}

const passed: CheckResult = { name: 'Saldo de cada wallet = saldo reconstruído do ledger', passed: true, detail: '8 wallets conferidas' };

function scenario(id: ScenarioResult['id'], steps: StepResult[], checks: CheckResult[] = [passed]): ScenarioResult {
  return { id, title: `Cenário ${id}`, description: `Descrição de ${id}.`, steps, checks };
}

function run(scenarios: ScenarioResult[]): LoadRunResult {
  return {
    startedAt: '2026-10-08T10:00:00.000Z',
    finishedAt: '2026-10-08T10:04:00.000Z',
    environment: {
      cpuModel: 'CPU de teste',
      logicalCores: 16,
      memoryGiB: 15.5,
      os: 'Debian GNU/Linux 12',
      kernel: 'Linux 6.10.7',
      bun: '1.4.2',
      postgres: 'PostgreSQL 17.11',
      postgresSettings: { max_connections: '100' },
      sqsEmulator: 'MiniStack 1.5.22 (light)',
      sqsSendProbe: { senders: 8, firstMessages: 1000, firstPerSecond: 1170, laterAfterMessages: 6000, laterPerSecond: 500 },
      appInstances: 3,
      poolSizePerInstance: 10,
      backgroundPoolSizePerInstance: 3,
      poolAcquireTimeoutMs: 2000,
      lockTimeout: '2s',
      consumer: { visibilityTimeoutSeconds: 30, waitTimeSeconds: 10, maxMessages: 10 },
      publisher: { leaseSeconds: 30, batchSize: 20, pollIntervalMs: 500 },
    },
    settings: {
      warmupSeconds: 2,
      stepSeconds: 6,
      clientSteps: [1, 8, 64],
      hotWallets: 1,
      mixedWallets: 20,
      mixedSeconds: 15,
      mixedHttpRoundsPerSecond: 40,
      mixedSqsRoundsPerSecond: 10,
    },
    scenarios,
  };
}

const hotSteps = (lastAccepted: number) => [
  step({ label: '1 cliente', clients: 1, acceptedPerSecond: 180 }),
  step({ label: '8 clientes', clients: 8, acceptedPerSecond: 290 }),
  step({
    label: '64 clientes',
    clients: 64,
    acceptedPerSecond: lastAccepted,
    latencyMs: { count: 1000, p50: 330, p95: 900, p99: 1203.94, max: 1500, mean: 378.4 },
  }),
];

describe('renderReport', () => {
  test('environment and methodology come from the result, not from this machine', () => {
    const report = renderReport(run([scenario('distinct-wallets', [step()])]));

    expect(report).toContain('CPU de teste, 16 núcleos lógicos');
    expect(report).toContain('| Bun | 1.4.2 |');
    expect(report).toContain(
      '10 por instância para HTTP e consumer (30 no total) e 3 para publisher e worker; espera máxima por conexão de 2.000 ms',
    );
    expect(report).toContain('| `lock_timeout` | 2s |');
    expect(report).toContain('1.170,0/s nas primeiras 1.000 mensagens, 500,0/s depois de 6.000');
    expect(report).toContain('passos de 1, 8, 64 clientes, 6 s medidos por passo');
  });

  test('one row per step, numbers in Brazilian notation as measured', () => {
    const report = renderReport(run([scenario('distinct-wallets', [step()])]));

    expect(report).toContain('| 8 clientes | 1.000,0 | 7,6 | 12,3 | 15,8 | 40,1 | 6,3 / 9,8 / 18,5 |');
    expect(report).toContain('| 8 clientes | 6.000 | 6.000 | 0 | 0 | 0 | 0 | 0 | 0 / 0 |');
  });

  test('nothing measured is shown as n/d, never as zero', () => {
    const report = renderReport(run([scenario('distinct-wallets', [step({ latencyMs: undefined, serverLatencyMs: undefined })])]));

    expect(report).toContain('| 8 clientes | 1.000,0 | n/d | n/d | n/d | n/d | n/d |');
  });

  test('every check passed: the summary says so with the count', () => {
    const report = renderReport(run([scenario('distinct-wallets', [step()], [passed, passed])]));

    expect(report).toContain('as 2 verificações passaram no cenário');
    expect(report).not.toContain('FALHOU');
  });

  test('a failed check is in the summary and in the scenario table, with what was found', () => {
    const failed: CheckResult = { name: 'Saldo = saldo esperado pelas respostas da API', passed: false, detail: 'banco 10.00, esperado 9.00' };
    const report = renderReport(run([scenario('distinct-wallets', [step()], [passed, failed])]));

    expect(report).toContain('**Correção: 1 de 2 verificações FALHARAM.**');
    expect(report).toContain('| Saldo = saldo esperado pelas respostas da API | **FALHOU** | banco 10.00, esperado 9.00 |');
  });

  test('hot wallet that loses throughput after the peak: the analysis says it fell, with the measured values', () => {
    const report = renderReport(run([scenario('hot-wallet', hotSteps(168.3))]));

    expect(report).toContain('subiu até 290,0/s com 8 clientes e depois caiu para 168,3/s com 64 clientes');
    expect(report).toContain('A queda depois do pico não foi isolada neste teste');
    // Little's law: 64 / 168.3 s = 380.3 ms
    expect(report).toContain('64 / 168,3 = 380,3 ms; a média medida foi 378,4 ms');
  });

  test('hot wallet that only flattens: no claim of a fall', () => {
    const report = renderReport(run([scenario('hot-wallet', hotSteps(285))]));

    expect(report).toContain('subiu até 290,0/s e parou de crescer');
    expect(report).not.toContain('A queda depois do pico');
  });

  test('no 503 in the hot wallet: explains the pool bound against the lock_timeout', () => {
    const report = renderReport(run([scenario('hot-wallet', hotSteps(200))]));

    expect(report).toContain('Nenhum `503` e nenhum conflito de lock na hot wallet');
    // 30 connections x (1000 / 200 = 5 ms) = 150 ms
    expect(report).toContain('cerca de 30 × 5,00 = 150,0 ms');
    // The pool wait is bounded since the pool fix: the report must not say otherwise.
    expect(report).toContain('esperam uma conexão livre dentro da instância por até 2.000 ms');
    expect(report).not.toContain('não tem prazo de espera');
  });

  test('503 in the hot wallet: reports the count instead of the pool explanation', () => {
    const steps = hotSteps(200).map((each) => step({ ...each, requests: { ...each.requests, unavailable: 7 } }));
    const report = renderReport(run([scenario('hot-wallet', steps)]));

    expect(report).toContain('houve 21 respostas `503`');
    expect(report).not.toContain('Nenhum `503`');
  });

  test('hot wallet fall with internal PostgreSQL waits: cites them as evidence, with their share', () => {
    const steps = hotSteps(168.3);
    const withWaits = steps.map((each, index) =>
      index === 2
        ? step({
            ...each,
            postgresWaits: [
              { wait: 'active / Lock:transactionid', share: 0.819 },
              { wait: 'active / LWLock:BufferContent', share: 0.091 },
            ],
          })
        : each,
    );
    const report = renderReport(run([scenario('hot-wallet', withWaits)]));

    expect(report).toContain('foi `active / Lock:transactionid` (81,9% das amostras)');
    expect(report).toContain('apareceram também `active / LWLock:BufferContent` (9,1%)');
  });

  test('a latency above the lock_timeout without any 503 is attributed to the pool wait', () => {
    const report = renderReport(run([scenario('hot-wallet', hotSteps(168.3))]));

    // max 1500 ms is below 2 s: no claim
    expect(report).not.toContain('passou do `lock_timeout` sem nenhum `503`');
    const slow = hotSteps(168.3).map((each, index) =>
      index === 2 ? step({ ...each, latencyMs: { count: 900, p50: 436.5, p95: 942.1, p99: 1358.6, max: 2595.4, mean: 455 } }) : each,
    );
    expect(renderReport(run([scenario('hot-wallet', slow)]))).toContain(
      'O máximo medido com 64 clientes, 2.595,4 ms, passou do `lock_timeout` sem nenhum `503`',
    );
  });

  test('hot wallet publishing collapses: the report does not blame the shared pool, the publisher has its own', () => {
    const steps = hotSteps(168.3).map((each, index) =>
      step({ ...each, outbox: { ...each.outbox, publishedPerSecond: index === 2 ? 4.3 : 280 } }),
    );
    const report = renderReport(run([scenario('hot-wallet', steps)]));

    expect(report).toContain('a publicação caiu para 4,3/s');
    expect(report).toContain('O publisher usa um pool próprio (3 conexões por instância)');
    expect(report).not.toContain('mesmo pool');
  });

  test('publishing slower than the emulator alone: the report does not blame the emulator for all of it', () => {
    const report = renderReport(run([scenario('distinct-wallets', [step()])]));

    // 300 published/s against 500/s the emulator took alone after 6.000 messages
    expect(report).toContain('A publicação não acompanhou');
    expect(report).toContain('então o emulador não explica tudo');
  });
});
