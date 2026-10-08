import pg from 'pg';
import type { DependencyCheck } from '../../application/health/check-readiness.js';
import type { DatabaseConfig } from '../config/app-config.js';

/**
 * Readiness of PostgreSQL: one `select 1` on a connection of its own, never one of the
 * pool. The probe has a deadline (the readiness timeout aborts the signal); a database
 * that accepts the connection and never answers would otherwise keep a pool connection
 * busy with a query nobody answers, taking it away from the money path. On abort the
 * socket of this connection is destroyed, so nothing is left waiting.
 */
export class DatabaseCheck implements DependencyCheck {
  readonly name = 'database';

  constructor(private readonly database: DatabaseConfig) {}

  async check(signal: AbortSignal): Promise<void> {
    const client = new pg.Client({
      host: this.database.host,
      port: this.database.port,
      user: this.database.user,
      password: this.database.password,
      database: this.database.dbName,
      connectionTimeoutMillis: this.database.acquireTimeoutMs,
    });
    // A dropped probe connection must not take the process down ('error' with no listener).
    client.on('error', () => {});
    const destroy = () => destroySocket(client);
    signal.addEventListener('abort', destroy, { once: true });
    try {
      await client.connect();
      await client.query('select 1');
    } finally {
      signal.removeEventListener('abort', destroy);
      // Not awaited: on a silent database a graceful end could wait for an answer too.
      destroySocket(client);
    }
  }
}

/** Closes the TCP socket at once: any query still waiting on it fails right away. */
function destroySocket(client: pg.Client): void {
  (client as unknown as { connection?: { stream?: { destroy(): void } } }).connection?.stream?.destroy();
}
