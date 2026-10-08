import { ConnectionException } from '@mikro-orm/core';

/**
 * SQLSTATEs for which the same request, sent again, can succeed. Everything else is
 * not transient: a constraint violation, a numeric overflow (22003) or a trigger
 * raising an error gives the same answer on every retry, so retrying only adds load.
 */
const TRANSIENT_SQLSTATES = new Set([
  '55P03', // lock_not_available: our lock_timeout expired waiting for the wallet row
  '40P01', // deadlock_detected
  '40001', // serialization_failure
  '57P01', // admin_shutdown: the server is restarting
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now: the server is starting
  '53300', // too_many_connections
  // Class 08, connection exception: only the codes that mean "the connection failed".
  // 08P01 (protocol_violation) is NOT here: PostgreSQL raises it for a payload it cannot
  // accept, such as a NUL byte in a text parameter, and that payload fails on every retry.
  '08000', // connection_exception
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08003', // connection_does_not_exist
  '08006', // connection_failure
]);

/**
 * Socket errors raised by the driver before PostgreSQL even answers. ENOTFOUND is here on
 * purpose: a DNS failure is usually temporary, and a host name that is really wrong only
 * costs retries until the queue's maxReceiveCount sends the message to the DLQ.
 */
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'EAI_AGAIN',
  'ENOTFOUND',
]);

/**
 * pg raises these without a code. 'Connection terminated': the connection dropped in the
 * middle of a query, or (with "due to connection timeout") a new one did not open in time.
 * 'is not queryable': the next statement (ROLLBACK included) on a client whose connection
 * already died. 'timeout exceeded when trying to connect': no free connection in the pool
 * within DATABASE_POOL_ACQUIRE_TIMEOUT_MS (overload). All can pass on their own: transient.
 */
const CONNECTION_LOST_MESSAGES = [
  'Connection terminated',
  'connection timeout',
  'is not queryable',
  'timeout exceeded when trying to connect',
];

/**
 * Contention, not unavailability: the database answered, another transaction held the
 * row. A retry a few milliseconds later usually wins. A refused connection is NOT here:
 * retrying it in milliseconds only adds load to a database that is down.
 */
const LOCK_CONTENTION_SQLSTATES = new Set([
  '55P03', // lock_not_available
  '40P01', // deadlock_detected
  '40001', // serialization_failure
]);

export function isLockContentionError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && LOCK_CONTENTION_SQLSTATES.has(code);
}

export function isTransientDatabaseError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error instanceof ConnectionException) {
    return true;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && isTransientCode(code)) {
    return true;
  }
  // Node reports a refused connection to several addresses as an AggregateError.
  if (error instanceof AggregateError && error.errors.some((inner) => isTransientDatabaseError(inner))) {
    return true;
  }
  return CONNECTION_LOST_MESSAGES.some((text) => error.message.includes(text));
}

function isTransientCode(code: string): boolean {
  return TRANSIENT_SQLSTATES.has(code) || TRANSIENT_NETWORK_CODES.has(code);
}
