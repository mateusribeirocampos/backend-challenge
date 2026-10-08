import type { Instance } from './cluster.js';
import type { RequestCounts } from './results.js';

/**
 * The HTTP side of the load: closed-loop clients (each sends, waits for the answer,
 * sends the next one) and a provider that behaves well: on 503 or a lost connection it
 * resends the SAME body with the SAME Idempotency-Key, so a retry can never double an effect.
 */

export interface RequestSample {
  /** Date.now() when fetch() was called: decides if the request is in the measured window. */
  readonly startedAtMs: number;
  /** fetch() to the end of the response body, from performance.now(). */
  readonly latencyMs: number;
  /** HTTP status, or 0 when fetch itself failed (no answer at all). */
  readonly status: number;
}

export interface FinalAnswer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const NETWORK_ERROR = 0;
const MAX_ATTEMPTS = 10;

/** Picks the instances in turn, so the load is spread evenly across all of them. */
export class RoundRobin {
  private next = 0;

  constructor(private readonly instances: readonly Instance[]) {}

  pick(): Instance {
    const instance = this.instances[this.next % this.instances.length];
    this.next += 1;
    if (instance === undefined) throw new Error('no instance');
    return instance;
  }
}

export class RequestRecorder {
  readonly samples: RequestSample[] = [];

  record(sample: RequestSample): void {
    this.samples.push(sample);
  }

  inWindow(startMs: number, endMs: number): RequestSample[] {
    return this.samples.filter((sample) => sample.startedAtMs >= startMs && sample.startedAtMs < endMs);
  }
}

/**
 * POST until a final answer. Each attempt is one sample (a 503 is a request that was
 * really made and answered). 503 waits what Retry-After asks; a lost connection tries
 * the next instance after 100 ms. Throws after 10 attempts: the outcome is then unknown,
 * and the correctness check of the scenario will show it.
 */
export async function postUntilFinal(
  instances: RoundRobin,
  path: string,
  body: unknown,
  headers: Record<string, string>,
  recorder: RequestRecorder,
): Promise<FinalAnswer> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const answer = await timedPost(instances.pick().baseUrl, path, body, headers, recorder);
    if (answer !== undefined && answer.status !== 503) {
      return answer;
    }
    const retryAfterSeconds = answer === undefined ? 0.1 : Number(answer.retryAfter ?? '1');
    await Bun.sleep(retryAfterSeconds * 1000);
  }
  throw new Error(`no final answer for ${path} after ${MAX_ATTEMPTS} attempts`);
}

export async function timedPost(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string>,
  recorder: RequestRecorder,
): Promise<(FinalAnswer & { retryAfter: string | null }) | undefined> {
  const startedAtMs = Date.now();
  const started = performance.now();
  let response: Response;
  let text: string;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    text = await response.text();
  } catch {
    recorder.record({ startedAtMs, latencyMs: performance.now() - started, status: NETWORK_ERROR });
    return undefined;
  }
  // One sample per attempt: an answer that is not JSON (a proxy's HTML 502) is still that status.
  recorder.record({ startedAtMs, latencyMs: performance.now() - started, status: response.status });
  return { status: response.status, body: jsonObjectOrEmpty(text), retryAfter: response.headers.get('retry-after') };
}

function jsonObjectOrEmpty(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = text === '' ? {} : JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Counts the answers by class; 422 is a business answer, kept apart from the errors. */
export function countRequests(samples: readonly RequestSample[]): RequestCounts {
  const byStatus: Record<string, number> = {};
  for (const sample of samples) {
    const key = sample.status === NETWORK_ERROR ? 'network' : String(sample.status);
    byStatus[key] = (byStatus[key] ?? 0) + 1;
  }
  const count = (predicate: (status: number) => boolean) => samples.filter((sample) => predicate(sample.status)).length;
  return {
    total: samples.length,
    accepted: count((status) => status >= 200 && status < 300),
    businessRejections: count((status) => status === 422),
    unavailable: count((status) => status === 503),
    otherServerErrors: count((status) => status >= 500 && status !== 503),
    otherClientErrors: count((status) => status >= 400 && status < 500 && status !== 422),
    networkErrors: count((status) => status === NETWORK_ERROR),
    byStatus,
  };
}

export interface LoopWindow {
  /** Date.now() at the end of the warm-up: the measured window starts here. */
  readonly startMs: number;
  /** Date.now() when the clients stopped starting new requests. */
  readonly endMs: number;
}

/**
 * Runs `clients` closed loops for warm-up + duration. A client never has more than one
 * operation in flight, so the offered load is the number of clients, and latency
 * cannot hide behind a queue inside the load generator. onWindowStart fires at the end
 * of the warm-up, for the "before" readings of the window.
 */
export async function runClosedLoop(
  options: { clients: number; warmupMs: number; durationMs: number; onWindowStart?: () => void },
  operation: (client: number, iteration: number) => Promise<void>,
): Promise<LoopWindow> {
  const loopStart = Date.now();
  const windowStart = loopStart + options.warmupMs;
  const loopEnd = windowStart + options.durationMs;
  const marker = setTimeout(() => options.onWindowStart?.(), options.warmupMs);

  const client = async (index: number) => {
    for (let iteration = 0; Date.now() < loopEnd; iteration += 1) {
      await operation(index, iteration);
    }
  };
  await Promise.all(Array.from({ length: options.clients }, (_, index) => client(index)));
  clearTimeout(marker);
  return { startMs: windowStart, endMs: loopEnd };
}
