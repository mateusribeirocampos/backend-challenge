/**
 * bun load/summarize-runs.ts [load-results/<run>/result.json ...]
 *
 * Writes docs/teste-de-carga.md from several runs of `bun run test:load`: the full report of the
 * median run, followed by a repeatability table (every run, median and spread). With no
 * arguments it takes the three most recent runs in load-results/. No load is generated.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { medianRunIndex, renderRepeatability } from './repeatability.js';
import { renderReport } from './report.js';
import type { LoadRunResult } from './results.js';
import { loadSettings } from './settings.js';

const root = resolve(import.meta.dir, '..');

function latestRuns(count: number): string[] {
  const dir = join(root, 'load-results');
  return readdirSync(dir)
    .map((name) => join(dir, name, 'result.json'))
    .filter((path) => existsSync(path))
    .sort()
    .slice(-count);
}

const paths = process.argv.length > 2 ? process.argv.slice(2) : latestRuns(3);
if (paths.length < 2) {
  console.error('at least two runs are needed: bun load/summarize-runs.ts <result.json> <result.json> ...');
  process.exit(1);
}

const results = paths.map((path) => JSON.parse(readFileSync(path, 'utf8')) as LoadRunResult);
const mainIndex = medianRunIndex(results);
const reportPath = resolve(root, loadSettings(process.env).reportPath);
writeFileSync(reportPath, `${renderReport(results[mainIndex] as LoadRunResult).trimEnd()}\n\n${renderRepeatability(results, mainIndex)}`);

console.log(`runs: ${paths.join(', ')}`);
console.log(`main report: run ${mainIndex + 1} (${paths[mainIndex]})`);
console.log(`report: ${reportPath}`);
