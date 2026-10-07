import type { LogFields, StructuredLogger } from '../../application/ports/structured-logger.js';

type Level = 'info' | 'warn' | 'error';

/** One JSON object per line on stdout, the format log collectors read without parsing rules. */
export class JsonLineLogger implements StructuredLogger {
  constructor(private readonly write: (line: string) => void = (line) => process.stdout.write(line)) {}

  info(event: string, fields?: LogFields): void {
    this.log('info', event, fields);
  }

  warn(event: string, fields?: LogFields): void {
    this.log('warn', event, fields);
  }

  error(event: string, fields?: LogFields): void {
    this.log('error', event, fields);
  }

  private log(level: Level, event: string, fields: LogFields = {}): void {
    this.write(`${JSON.stringify({ time: new Date().toISOString(), level, event, ...fields })}\n`);
  }
}
