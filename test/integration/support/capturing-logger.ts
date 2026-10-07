import type { LogFields, StructuredLogger } from '../../../src/application/ports/structured-logger.js';

export interface LogLine {
  readonly level: 'info' | 'warn' | 'error';
  readonly event: string;
  readonly fields: LogFields;
}

/** Keeps the structured log lines in memory so a test can assert on them. */
export class CapturingLogger implements StructuredLogger {
  readonly lines: LogLine[] = [];

  info(event: string, fields: LogFields = {}): void {
    this.lines.push({ level: 'info', event, fields });
  }

  warn(event: string, fields: LogFields = {}): void {
    this.lines.push({ level: 'warn', event, fields });
  }

  error(event: string, fields: LogFields = {}): void {
    this.lines.push({ level: 'error', event, fields });
  }

  events(event: string): LogLine[] {
    return this.lines.filter((line) => line.event === event);
  }
}
