import type { MetricLabels } from '../../application/ports/metrics.js';

export interface Sample {
  readonly labels: MetricLabels;
  readonly value: number;
}

export interface HistogramSample {
  readonly labels: MetricLabels;
  /** Cumulative: cumulativeCounts[i] = observations <= buckets[i]. */
  readonly cumulativeCounts: readonly number[];
  readonly sum: number;
  readonly count: number;
}

export type MetricFamily =
  | { readonly name: string; readonly type: 'counter' | 'gauge'; readonly samples: readonly Sample[] }
  | {
      readonly name: string;
      readonly type: 'histogram';
      readonly buckets: readonly number[];
      readonly samples: readonly HistogramSample[];
    };

/**
 * The Prometheus text exposition format (version 0.0.4), written by hand: a TYPE line per
 * metric, then one "name{labels} value" line per label set. Small enough that a client
 * library would add a dependency without removing any real complexity.
 */
export function renderPrometheusText(families: readonly MetricFamily[]): string {
  return families.map(renderFamily).join('');
}

function renderFamily(family: MetricFamily): string {
  const lines = [`# TYPE ${family.name} ${family.type}`];
  if (family.type === 'histogram') {
    for (const sample of family.samples) {
      lines.push(...histogramLines(family.name, family.buckets, sample));
    }
  } else {
    for (const sample of family.samples) {
      lines.push(`${family.name}${labelBlock(sample.labels)} ${String(sample.value)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** One _bucket line per bound plus +Inf (= count), then _sum and _count. */
function histogramLines(name: string, buckets: readonly number[], sample: HistogramSample): string[] {
  const bucketLines = buckets.map(
    (bound, index) =>
      `${name}_bucket${labelBlock(sample.labels, String(bound))} ${sample.cumulativeCounts[index] ?? 0}`,
  );
  return [
    ...bucketLines,
    `${name}_bucket${labelBlock(sample.labels, '+Inf')} ${sample.count}`,
    `${name}_sum${labelBlock(sample.labels)} ${String(sample.sum)}`,
    `${name}_count${labelBlock(sample.labels)} ${sample.count}`,
  ];
}

/** {a="1",b="2"} in the order the labels were given, le last; empty when there is no label. */
function labelBlock(labels: MetricLabels, le?: string): string {
  const pairs = Object.entries(labels).map(([label, value]) => `${label}="${escapeLabelValue(value)}"`);
  if (le !== undefined) {
    pairs.push(`le="${le}"`);
  }
  return pairs.length === 0 ? '' : `{${pairs.join(',')}}`;
}

/** The format reserves three characters in label values: backslash, double quote and line feed. */
function escapeLabelValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}
