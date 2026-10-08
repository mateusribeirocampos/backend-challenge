import { verifyScenario } from '../checks.js';
import { pollUntil, unpublishedEvents } from '../database.js';
import { RequestRecorder, RoundRobin, runClosedLoop } from '../http-load.js';
import type { ScenarioResult, StepResult } from '../results.js';
import { type GeneratedLoad, measureStep, type StepContext } from '../step.js';
import { ExpectedBalances, type LoadWallet, openWallets, submitWager, wagerBody, wasProcessed } from '../wagering.js';

/**
 * Scenarios 1 and 2: only BETs over HTTP, the same work per request, at growing client
 * counts. The only difference between them is how many wallets the clients share, so the
 * comparison isolates the cost of the per-wallet row lock.
 */

export type ScenarioContext = StepContext;

export const BET_AMOUNT = '1.00';

/** Scenario 1: each client has a wallet of its own, so no request ever waits for another's lock. */
export async function runDistinctWallets(context: ScenarioContext): Promise<ScenarioResult> {
  const expected = new ExpectedBalances();
  const largestStep = Math.max(...context.settings.clientSteps);
  const wallets = await openTrackedWallets(context, expected, largestStep);
  const steps: StepResult[] = [];
  for (const clients of context.settings.clientSteps) {
    steps.push(await betStep(context, expected, clients, clients, (client) => walletAt(wallets, client)));
  }
  return {
    id: 'distinct-wallets',
    title: 'Wallets distintas (baixa disputa)',
    description:
      'Só BET por HTTP. Cada cliente usa uma wallet só dele, então nenhuma requisição espera o lock de outra. As requisições vão para as instâncias em rodízio.',
    steps,
    checks: await verifyScenario({ ...context, instance: firstInstance(context), expected }),
  };
}

/** Scenario 2: every client bets on the same wallet(s): the row lock serializes them. */
export async function runHotWallet(context: ScenarioContext): Promise<ScenarioResult> {
  const expected = new ExpectedBalances();
  const { hotWallets } = context.settings;
  const wallets = await openTrackedWallets(context, expected, hotWallets);
  const steps: StepResult[] = [];
  for (const clients of context.settings.clientSteps) {
    steps.push(await betStep(context, expected, clients, hotWallets, (client) => walletAt(wallets, client % hotWallets)));
  }
  return {
    id: 'hot-wallet',
    title: hotWallets === 1 ? 'Hot wallet (alta disputa, uma wallet)' : `Hot wallets (alta disputa, ${hotWallets} wallets)`,
    description:
      'Só BET por HTTP. Todos os clientes apostam na mesma wallet, então cada transação espera o lock da linha (FOR NO KEY UPDATE) da anterior.',
    steps,
    checks: await verifyScenario({ ...context, instance: firstInstance(context), expected }),
  };
}

/**
 * Not measured: a few seconds of BETs before the first scenario, so the first step does
 * not pay for cold code (JIT, first connections of each pool). Waits until the outbox is
 * empty again, so the first step starts from the same state as the others.
 */
export async function warmUpCluster(context: ScenarioContext): Promise<void> {
  const expected = new ExpectedBalances();
  const clients = 8;
  const wallets = await openTrackedWallets(context, expected, clients);
  const recorder = new RequestRecorder();
  const instances = new RoundRobin(context.instances);
  await runClosedLoop({ clients, warmupMs: 0, durationMs: context.settings.warmupSeconds * 2000 }, async (client) => {
    await submitWager(instances, wagerBody(walletAt(wallets, client), 'BET', BET_AMOUNT), recorder);
  });
  await pollUntil(async () => (await unpublishedEvents(context.orm)) === 0, context.settings.drainTimeoutSeconds * 1000);
}

function betStep(
  context: ScenarioContext,
  expected: ExpectedBalances,
  clients: number,
  walletCount: number,
  walletOf: (client: number) => LoadWallet,
): Promise<StepResult> {
  return measureStep(context, {
    label: `${clients} ${clients === 1 ? 'cliente' : 'clientes'}`,
    clients,
    wallets: walletCount,
    generate: async (onWindowStart): Promise<GeneratedLoad> => {
      const recorder = new RequestRecorder();
      const instances = new RoundRobin(context.instances);
      const window = await runClosedLoop(
        {
          clients,
          warmupMs: context.settings.warmupSeconds * 1000,
          durationMs: context.settings.stepSeconds * 1000,
          onWindowStart,
        },
        async (client) => {
          const wallet = walletOf(client);
          const answer = await submitWager(instances, wagerBody(wallet, 'BET', BET_AMOUNT), recorder);
          if (wasProcessed(answer)) expected.applyProcessed(wallet.id, 'BET', BET_AMOUNT);
        },
      );
      return { window, recorder };
    },
  });
}

async function openTrackedWallets(context: ScenarioContext, expected: ExpectedBalances, count: number): Promise<LoadWallet[]> {
  const wallets = await openWallets(firstInstance(context), count);
  for (const wallet of wallets) expected.track(wallet);
  return wallets;
}

export function walletAt(wallets: readonly LoadWallet[], index: number): LoadWallet {
  const wallet = wallets[index];
  if (wallet === undefined) throw new Error(`no wallet at ${index}`);
  return wallet;
}

export function firstInstance(context: StepContext) {
  const instance = context.instances[0];
  if (instance === undefined) throw new Error('no instance running');
  return instance;
}
