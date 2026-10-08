/**
 * Just enough of the Prometheus text format to read GET /metrics of the app: counters,
 * the outbox lag gauge and the latency histogram. Each instance exposes its own values,
 * so the samples of every instance are concatenated and summed here.
 */

export interface PromSample {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
}

export interface Bucket {
  /** Upper bound in seconds; the last one is +Inf. */
  readonly le: number;
  /** Cumulative: observations <= le. */
  readonly count: number;
}

export type LabelFilter = Readonly<Record<string, string>>;

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*/;

export function parsePrometheusText(text: string): PromSample[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map(parseLine);
}

/** `name{a="1",b="2"} value` or `name value`. */
function parseLine(line: string): PromSample {
  const name = METRIC_NAME.exec(line)?.[0];
  if (name === undefined) {
    throw new Error(`not a Prometheus sample: ${line}`);
  }
  let rest = line.slice(name.length);
  let labels: Record<string, string> = {};
  if (rest.startsWith('{')) {
    const parsed = parseLabels(rest, line);
    labels = parsed.labels;
    rest = rest.slice(parsed.length);
  }
  return { name, labels, value: parseValue(rest.trim(), line) };
}

/**
 * Reads `{a="x",b="y"}` character by character, because a label value may contain an
 * escaped quote, a comma or a brace. Returns the labels and how many characters it used.
 */
function parseLabels(text: string, line: string): { labels: Record<string, string>; length: number } {
  const labels: Record<string, string> = {};
  let index = 1; // after "{"
  while (text[index] !== '}') {
    const equals = text.indexOf('="', index);
    if (equals === -1) throw new Error(`malformed labels: ${line}`);
    const label = text.slice(index, equals);
    index = equals + 2;
    let value = '';
    while (text[index] !== '"') {
      if (index >= text.length) throw new Error(`unterminated label value: ${line}`);
      if (text[index] === '\\') {
        const escaped = text[index + 1];
        value += escaped === 'n' ? '\n' : (escaped ?? '');
        index += 2;
      } else {
        value += text[index];
        index += 1;
      }
    }
    labels[label] = value;
    index += 1; // closing quote
    if (text[index] === ',') index += 1;
    if (index >= text.length) throw new Error(`unterminated labels: ${line}`);
  }
  return { labels, length: index + 1 };
}

function parseValue(text: string, line: string): number {
  if (text === '+Inf') return Number.POSITIVE_INFINITY;
  if (text === '-Inf') return Number.NEGATIVE_INFINITY;
  const value = Number(text);
  if (text === '' || Number.isNaN(value)) {
    throw new Error(`malformed value: ${line}`);
  }
  return value;
}

function matches(sample: PromSample, name: string, filter: LabelFilter): boolean {
  return sample.name === name && Object.entries(filter).every(([label, value]) => sample.labels[label] === value);
}

/** Sum of every series of this metric whose labels contain the filter (across instances). */
export function sumOf(samples: readonly PromSample[], name: string, filter: LabelFilter = {}): number {
  return samples.filter((sample) => matches(sample, name, filter)).reduce((sum, sample) => sum + sample.value, 0);
}

/** Largest value of a gauge among the instances; undefined when no instance set it yet. */
export function maxOf(samples: readonly PromSample[], name: string, filter: LabelFilter = {}): number | undefined {
  const values = samples.filter((sample) => matches(sample, name, filter)).map((sample) => sample.value);
  return values.length === 0 ? undefined : Math.max(...values);
}

/** How much a counter grew between two scrapes (no instance restarts during a run). */
export function counterDelta(
  before: readonly PromSample[],
  after: readonly PromSample[],
  name: string,
  filter: LabelFilter = {},
): number {
  return sumOf(after, name, filter) - sumOf(before, name, filter);
}

/** The cumulative buckets of a histogram, summed across instances, sorted by bound. */
export function histogramBuckets(samples: readonly PromSample[], name: string, filter: LabelFilter = {}): Bucket[] {
  const byBound = new Map<number, number>();
  for (const sample of samples) {
    if (!matches(sample, `${name}_bucket`, filter)) continue;
    const le = parseValue(sample.labels.le ?? '', `le of ${name}`);
    byBound.set(le, (byBound.get(le) ?? 0) + sample.value);
  }
  return [...byBound]
    .map(([le, count]) => ({ le, count }))
    .sort((left, right) => left.le - right.le);
}

/** Observations made between two scrapes, bucket by bucket. */
export function histogramDelta(before: readonly Bucket[], after: readonly Bucket[]): Bucket[] {
  return after.map((bucket) => ({
    le: bucket.le,
    count: bucket.count - (before.find((old) => old.le === bucket.le)?.count ?? 0),
  }));
}

/**
 * Same estimate as PromQL histogram_quantile: find the bucket where the rank falls and
 * interpolate linearly inside it. Only an estimate (the real values inside a bucket are
 * unknown), which is why the report shows it only as a cross-check of the client side.
 */
export function histogramQuantile(buckets: readonly Bucket[], quantile: number): number | undefined {
  const total = buckets[buckets.length - 1]?.count ?? 0;
  if (total === 0) {
    return undefined;
  }
  const rank = quantile * total;
  let lowerBound = 0;
  let lowerCount = 0;
  for (const bucket of buckets) {
    if (bucket.count >= rank) {
      if (bucket.le === Number.POSITIVE_INFINITY) {
        return lowerBound; // above the largest finite bound: that bound is all we know
      }
      const inBucket = bucket.count - lowerCount;
      if (inBucket === 0) {
        return lowerBound; // quantile 0 on an empty first bucket
      }
      return lowerBound + (bucket.le - lowerBound) * ((rank - lowerCount) / inBucket);
    }
    lowerBound = bucket.le;
    lowerCount = bucket.count;
  }
  return lowerBound;
}
