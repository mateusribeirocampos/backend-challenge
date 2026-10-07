import { resolve } from 'node:path';

export type ProcessEvent = Readonly<Record<string, unknown>> & { readonly event: string };

export interface ProcessExit {
  readonly exitCode: number | null;
  readonly signalCode: string | null;
}

const PROJECT_ROOT = resolve(import.meta.dir, '../../..');

/**
 * The app (or a test entrypoint) in a REAL child process, so a test can SIGKILL or
 * SIGTERM it. Reads the JSON log lines from stdout; other lines (Nest's own log) are kept
 * only to show them if a test fails.
 */
export class AppProcess {
  readonly events: ProcessEvent[] = [];
  readonly output: string[] = [];
  readonly exited: Promise<ProcessExit>;

  private constructor(private readonly child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>) {
    void this.collect(child.stdout);
    void this.collect(child.stderr);
    this.exited = child.exited.then(() => ({ exitCode: child.exitCode, signalCode: child.signalCode }));
  }

  /** entrypoint relative to the project root; env is added on top of this process's env. */
  static spawn(entrypoint: string, env: Record<string, string>): AppProcess {
    const child = Bun.spawn([process.execPath, entrypoint], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...env },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return new AppProcess(child);
  }

  signal(signal: 'SIGTERM' | 'SIGKILL'): void {
    this.child.kill(signal);
  }

  /** Polls the collected log lines until one matches, or fails showing what the process printed. */
  async waitForEvent(event: string, timeoutMs = 10_000, match: (line: ProcessEvent) => boolean = () => true) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.events.find((line) => line.event === event && match(line));
      if (found !== undefined) {
        return found;
      }
      await Bun.sleep(10);
    }
    throw new Error(`no "${event}" from the child process after ${timeoutMs} ms. Output:\n${this.output.join('\n')}`);
  }

  eventsNamed(event: string): ProcessEvent[] {
    return this.events.filter((line) => line.event === event);
  }

  private async collect(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let pending = '';
    for await (const chunk of stream) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        this.record(line);
      }
    }
    if (pending !== '') {
      this.record(pending);
    }
  }

  private record(line: string): void {
    this.output.push(line);
    if (!line.startsWith('{')) {
      return;
    }
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed.event === 'string') {
        this.events.push(parsed as ProcessEvent);
      }
    } catch {
      // not a log line of ours
    }
  }
}
