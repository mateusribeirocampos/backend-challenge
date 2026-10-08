/**
 * bun run test:load
 *
 * Load test against the real stack: PostgreSQL and MiniStack from docker compose, and N
 * real app processes (src/main.ts). Runs three scenarios, checks that the money is still
 * right after each one, saves the raw numbers in load-results/ and rewrites
 * docs/teste-de-carga.md. Not part of `bun test` nor of the CI: it takes minutes and its
 * numbers depend on the machine.
 *
 * Exit code 1 when any correctness check fails (the report is written anyway).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadConfig } from '../src/infrastructure/config/app-config.js';
import { createSqsClient } from '../src/infrastructure/messaging/sqs-client.provider.js';
import {
  createRunQueues,
  deleteRunQueues,
  freePort,
  type Instance,
  instanceEnv,
  prepareDatabase,
  startInstance,
  stopInstances,
} from './cluster.js';
import { collectEnvironment } from './environment.js';
import { probeSendRate } from './emulator-probe.js';
import { EventsDrainer } from './events-drainer.js';
import { containerIds } from './observers.js';
import { renderReport } from './report.js';
import type { LoadRunResult, ScenarioResult } from './results.js';
import { runDistinctWallets, runHotWallet, type ScenarioContext, warmUpCluster } from './scenarios/http-bets.js';
import { runMixed } from './scenarios/mixed.js';
import { loadSettings } from './settings.js';

const PROJECT_ROOT = resolve(import.meta.dir, '..');

async function main(): Promise<number> {
  const settings = loadSettings(process.env);
  const startedAt = new Date();
  const runDir = join(PROJECT_ROOT, 'load-results', startedAt.toISOString().replaceAll(':', '-'));
  mkdirSync(runDir, { recursive: true });

  const base = loadConfig(process.env);
  const sqs = createSqsClient(base.sqs);
  log(`preparing database ${settings.databaseName} and queues`);
  const orm = await prepareDatabase(base, settings.databaseName);
  log('measuring the SendMessage rate of the SQS emulator');
  const sendProbe = await probeSendRate(sqs);
  const queues = await createRunQueues(sqs);
  const instances: Instance[] = [];
  const drainer = new EventsDrainer(sqs, queues.events.url);
  drainer.start();
  stopEverythingOnSignal(instances, () => deleteRunQueues(sqs, queues));
  try {
    for (let index = 1; index <= settings.instances; index += 1) {
      const env = instanceEnv(queues, settings.databaseName, freePort());
      instances.push(await startInstance(`instance-${index}`, env, join(runDir, `instance-${index}.log`)));
    }
    // The configuration the instances really parsed, for the report.
    const instanceConfig = loadConfig({ ...process.env, ...instanceEnv(queues, settings.databaseName, 3000) });
    const environment = await collectEnvironment(orm, instanceConfig, instances.length, sendProbe);
    const context: ScenarioContext = { instances, orm, containers: containerIds(), settings, sqs, queues, drainer };

    log('warming up the instances (not measured)');
    await warmUpCluster(context);
    const scenarios: ScenarioResult[] = [];
    for (const [name, run] of [
      ['1/3 wallets distintas', runDistinctWallets],
      ['2/3 hot wallet', runHotWallet],
      ['3/3 misto HTTP + SQS', runMixed],
    ] as const) {
      log(`scenario ${name}`);
      const result = await run(context);
      scenarios.push(result);
      printScenario(result);
    }

    const result: LoadRunResult = {
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      environment,
      settings,
      scenarios,
    };
    writeFileSync(join(runDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
    const reportPath = join(PROJECT_ROOT, settings.reportPath);
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, renderReport(result));
    log(`raw results: ${join(runDir, 'result.json')}`);
    log(`report: ${settings.reportPath}`);
    const failed = scenarios.flatMap((scenario) => scenario.checks.filter((check) => !check.passed));
    return failed.length === 0 ? 0 : 1;
  } finally {
    await stopInstances(instances);
    await drainer.stop();
    await deleteRunQueues(sqs, queues).catch(() => undefined);
    await orm.close(true);
    sqs.destroy();
  }
}

/** Ctrl+C or a timeout must not leave app processes running against the load database. */
function stopEverythingOnSignal(instances: readonly Instance[], deleteQueues: () => Promise<void>): void {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      for (const instance of instances) instance.child.kill('SIGKILL');
      void deleteQueues()
        .catch(() => undefined)
        .finally(() => process.exit(130));
    });
  }
}

function log(message: string): void {
  console.log(`[load] ${message}`);
}

/** One line per step and the checks, so the terminal shows the run as it goes. */
function printScenario(scenario: ScenarioResult): void {
  for (const step of scenario.steps) {
    const latency = step.latencyMs;
    log(
      `  ${step.label}: ${step.acceptedPerSecond.toFixed(1)} aceitas/s, ` +
        `p50 ${latency?.p50.toFixed(1) ?? 'n/d'} ms, p99 ${latency?.p99.toFixed(1) ?? 'n/d'} ms, ` +
        `503: ${step.requests.unavailable}, 5xx: ${step.requests.otherServerErrors}, ` +
        `drenagem da outbox ${step.outbox.drainMs ?? 'n/d'} ms`,
    );
  }
  for (const check of scenario.checks) {
    log(`  [${check.passed ? 'ok' : 'FALHOU'}] ${check.name}: ${check.detail}`);
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
