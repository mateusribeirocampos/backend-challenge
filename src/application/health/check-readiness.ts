/**
 * Port implemented by each external dependency the service needs to do useful work
 * (PostgreSQL, SQS). check() resolves when the dependency answers and rejects otherwise.
 */
export interface DependencyCheck {
  readonly name: string;
  check(signal: AbortSignal): Promise<void>;
}

export const DEPENDENCY_CHECKS = Symbol('DEPENDENCY_CHECKS');

export type DependencyStatus = 'up' | 'down';

export interface ReadinessReport {
  readonly ready: boolean;
  readonly checks: Readonly<Record<string, DependencyStatus>>;
  readonly failed: readonly DependencyFailure[];
}

export interface DependencyFailure {
  readonly name: string;
  readonly reason: string;
}

/**
 * Runs every check in parallel, each one with its own time limit, so a dependency
 * that hangs makes the answer "not ready" instead of making the probe hang.
 */
export async function checkReadiness(
  dependencies: readonly DependencyCheck[],
  timeoutMs: number,
): Promise<ReadinessReport> {
  const results = await Promise.all(
    dependencies.map(async (dependency) => ({
      name: dependency.name,
      error: await runWithTimeout(dependency, timeoutMs),
    })),
  );

  const checks: Record<string, DependencyStatus> = {};
  const failed: DependencyFailure[] = [];
  for (const result of results) {
    checks[result.name] = result.error === undefined ? 'up' : 'down';
    if (result.error !== undefined) {
      failed.push({ name: result.name, reason: result.error });
    }
  }

  return { ready: failed.length === 0, checks, failed };
}

/** Returns undefined on success, or a short reason on failure or timeout. */
async function runWithTimeout(dependency: DependencyCheck, timeoutMs: number): Promise<string | undefined> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    await Promise.race([dependency.check(controller.signal), timeout]);
    return undefined;
  } catch (error) {
    return describeError(error);
  } finally {
    clearTimeout(timer);
  }
}

/** Some driver errors have an empty message (e.g. AggregateError on ECONNREFUSED); fall back to code or name. */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as { code?: unknown }).code;
  return error.message || (typeof code === 'string' ? code : '') || error.name;
}
