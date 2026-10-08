import type { LatencySummary } from './stats.js';

/**
 * Number formatting of the report: Brazilian notation (1.234,5). The display keeps one or
 * two decimals; the JSON in load-results/ keeps every digit that was measured.
 */

export const NOT_AVAILABLE = 'n/d';

export function decimal(value: number | undefined, digits = 1): string {
  if (value === undefined || Number.isNaN(value)) return NOT_AVAILABLE;
  return value.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function integer(value: number | undefined): string {
  if (value === undefined) return NOT_AVAILABLE;
  return value.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
}

/** Milliseconds shown as seconds, two decimals. */
export function seconds(milliseconds: number | undefined): string {
  return milliseconds === undefined ? NOT_AVAILABLE : decimal(milliseconds / 1000, 2);
}

/** "p50 / p95 / p99 / máx" in ms. */
export function latencyCells(summary: LatencySummary | undefined): string[] {
  if (summary === undefined) return [NOT_AVAILABLE, NOT_AVAILABLE, NOT_AVAILABLE, NOT_AVAILABLE];
  return [decimal(summary.p50), decimal(summary.p95), decimal(summary.p99), decimal(summary.max)];
}

export function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]) => `| ${cells.join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}

/** How many times bigger `after` is than `before`, e.g. "4,2x". */
export function times(after: number | undefined, before: number | undefined): string {
  if (after === undefined || before === undefined || before === 0) return NOT_AVAILABLE;
  return `${decimal(after / before)}x`;
}
