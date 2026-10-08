import { decimal, NOT_AVAILABLE, table } from './report-format.js';
import type { LoadRunResult, StepResult } from './results.js';

/**
 * Repeatability of several runs of the same experiment on the same machine.
 * The median is used instead of the mean: with three runs, one atypical run moves the
 * mean a lot and the median not at all.
 */
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error('median of an empty list');
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/** Throughput of the step with the most clients on distinct wallets: the headline number of the report. */
function headline(result: LoadRunResult): number {
  const steps = result.scenarios.find((scenario) => scenario.id === 'distinct-wallets')?.steps ?? [];
  return steps.at(-1)?.acceptedPerSecond ?? 0;
}

/** Index of the run whose headline throughput is the median; that run becomes the main report. */
export function medianRunIndex(results: readonly LoadRunResult[]): number {
  const target = median(results.map(headline));
  let best = 0;
  results.forEach((result, index) => {
    if (Math.abs(headline(result) - target) < Math.abs(headline(results[best] as LoadRunResult) - target)) best = index;
  });
  return best;
}

interface Metric {
  readonly name: string;
  readonly read: (step: StepResult) => number | undefined;
}

const METRICS: readonly Metric[] = [
  { name: 'aceitas/s', read: (step) => step.acceptedPerSecond },
  { name: 'p50 (ms)', read: (step) => step.latencyMs?.p50 },
  { name: 'p99 (ms)', read: (step) => step.latencyMs?.p99 },
  { name: 'eventos publicados/s', read: (step) => step.outbox?.publishedPerSecond },
  { name: 'SQS, do envio ao processamento, p99 (ms)', read: (step) => step.sqs?.sendToProcessedMs?.p99 },
];

/** (max - min) / median, as a whole percentage. */
function spread(values: readonly number[]): string {
  const middle = median(values);
  if (middle === 0) return NOT_AVAILABLE;
  return `${decimal(((Math.max(...values) - Math.min(...values)) / middle) * 100, 0)} %`;
}

function checksLine(results: readonly LoadRunResult[]): string {
  return results
    .map((result, index) => {
      const checks = result.scenarios.flatMap((scenario) => scenario.checks);
      return `rodada ${index + 1}: ${checks.filter((check) => check.passed).length}/${checks.length}`;
    })
    .join('; ');
}

export function renderRepeatability(results: readonly LoadRunResult[], mainRunIndex: number): string {
  const first = results[0];
  if (first === undefined) throw new Error('no runs to compare');

  const rows: string[][] = [];
  first.scenarios.forEach((scenario, scenarioIndex) => {
    scenario.steps.forEach((step, stepIndex) => {
      for (const metric of METRICS) {
        const values = results.map((result) => metric.read(result.scenarios[scenarioIndex]?.steps[stepIndex] as StepResult));
        if (values.some((value) => value === undefined)) continue;
        const numbers = values as number[];
        rows.push([scenario.title, step.label, metric.name, ...numbers.map((value) => decimal(value)), decimal(median(numbers)), spread(numbers)]);
      }
    });
  });

  const runHeaders = results.map((_, index) => `Rodada ${index + 1}`);
  const startedAt = results.map((result, index) => `rodada ${index + 1} às ${result.startedAt}`).join(', ');

  return [
    `## Repetibilidade (${results.length} rodadas)`,
    '',
    `O mesmo experimento rodou ${results.length} vezes seguidas, na mesma máquina, com os mesmos parâmetros e sem outros programas abertos (${startedAt}).`,
    `O relatório acima é o da **rodada ${mainRunIndex + 1}**, a de vazão mediana com o maior número de clientes em wallets distintas.`,
    'A tabela usa a **mediana** e não a média: com poucas rodadas, uma rodada atípica puxa a média e não mexe na mediana. A variação é (máximo − mínimo) / mediana.',
    '',
    `Verificações de correção, por rodada: ${checksLine(results)}.`,
    '',
    table(['Cenário', 'Passo', 'Métrica', ...runHeaders, 'Mediana', 'Variação'], rows),
    '',
  ].join('\n');
}
