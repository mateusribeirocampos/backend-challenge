/**
 * bun load/render-report.ts load-results/<run>/result.json
 *
 * Writes docs/teste-de-carga.md again from the JSON of a run, without running any load.
 * The report is a pure function of the result, so this is how a change to the report's
 * text is checked against real numbers in seconds instead of minutes.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderReport } from './report.js';
import type { LoadRunResult } from './results.js';
import { loadSettings } from './settings.js';

const resultPath = process.argv[2];
if (resultPath === undefined) {
  console.error('usage: bun load/render-report.ts load-results/<run>/result.json');
  process.exit(1);
}
const result = JSON.parse(readFileSync(resultPath, 'utf8')) as LoadRunResult;
const reportPath = resolve(import.meta.dir, '..', loadSettings(process.env).reportPath);
writeFileSync(reportPath, renderReport(result));
console.log(`report: ${reportPath}`);
