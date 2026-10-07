import { describe, expect, test } from 'bun:test';
import {
  CheckConstraintViolationException,
  ConnectionException,
  DeadlockException,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import {
  isLockContentionError,
  isTransientDatabaseError,
} from '../../../../src/infrastructure/persistence/database-error-classifier.js';

/** A driver error as the pg client raises it: a SQLSTATE (or a Node errno code) in `code`. */
function driverError(code: string, message = 'driver error'): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe('isTransientDatabaseError: "retry with the same key" vs "do not retry"', () => {
  test.each([
    ['55P03 lock_not_available (lock_timeout)', '55P03'],
    ['40P01 deadlock_detected', '40P01'],
    ['40001 serialization_failure', '40001'],
    ['57P01 admin_shutdown (database restarting)', '57P01'],
    ['57P03 cannot_connect_now (database starting)', '57P03'],
    ['53300 too_many_connections', '53300'],
    ['08000 connection_exception', '08000'],
    ['08001 unable to connect', '08001'],
    ['08003 connection_does_not_exist', '08003'],
    ['08006 connection_failure', '08006'],
    ['ECONNREFUSED (database down)', 'ECONNREFUSED'],
    ['ECONNRESET (connection dropped)', 'ECONNRESET'],
    ['ETIMEDOUT', 'ETIMEDOUT'],
    ['ENETUNREACH (route to the database temporarily gone)', 'ENETUNREACH'],
    ['EHOSTDOWN (database host down)', 'EHOSTDOWN'],
    ['ENOTFOUND (DNS failed; the SQS redrive bounds a misconfigured host)', 'ENOTFOUND'],
  ])('transient: %s', (_name, code) => {
    expect(isTransientDatabaseError(driverError(code))).toBe(true);
  });

  test.each([
    ['22003 numeric_value_out_of_range (balance overflow)', '22003'],
    ['23505 unique_violation', '23505'],
    ['23514 check_violation (e.g. the ledger checks at COMMIT)', '23514'],
    ['23503 foreign_key_violation', '23503'],
    ['P0001 raise_exception from a trigger', 'P0001'],
    ['42601 syntax error (a bug)', '42601'],
    ['08P01 protocol_violation (e.g. a NUL byte in a text parameter): the same payload fails again', '08P01'],
  ])('not transient: %s', (_name, code) => {
    expect(isTransientDatabaseError(driverError(code))).toBe(false);
  });

  test('MikroORM wrappers are classified by the same SQLSTATE they carry', () => {
    expect(isTransientDatabaseError(new DeadlockException(driverError('40P01')))).toBe(true);
    expect(isTransientDatabaseError(new ConnectionException(driverError('XX000')))).toBe(true);
    expect(isTransientDatabaseError(new UniqueConstraintViolationException(driverError('23505')))).toBe(false);
    expect(isTransientDatabaseError(new CheckConstraintViolationException(driverError('23514')))).toBe(false);
  });

  test('a connection lost mid-query (no code, pg message) is transient', () => {
    expect(isTransientDatabaseError(new Error('Connection terminated unexpectedly'))).toBe(true);
  });

  test('anything else is not: a plain bug must not be retried forever', () => {
    expect(isTransientDatabaseError(new TypeError('x is undefined'))).toBe(false);
    expect(isTransientDatabaseError('a string')).toBe(false);
    expect(isTransientDatabaseError(undefined)).toBe(false);
  });
});

describe('isLockContentionError: transient AND worth retrying right away, in the same process', () => {
  test.each([
    ['55P03 lock_not_available (lock_timeout)', '55P03'],
    ['40P01 deadlock_detected', '40P01'],
    ['40001 serialization_failure', '40001'],
  ])('contention: %s', (_name, code) => {
    expect(isLockContentionError(driverError(code))).toBe(true);
  });

  test('MikroORM wrappers of a deadlock count too', () => {
    expect(isLockContentionError(new DeadlockException(driverError('40P01')))).toBe(true);
  });

  test.each([
    ['ECONNREFUSED (database down: retrying in milliseconds does not help)', 'ECONNREFUSED'],
    ['57P03 cannot_connect_now', '57P03'],
    ['08006 connection_failure', '08006'],
    ['23505 unique_violation', '23505'],
    ['08P01 protocol_violation', '08P01'],
  ])('not contention: %s', (_name, code) => {
    expect(isLockContentionError(driverError(code))).toBe(false);
  });

  test('a connection error without code is not contention', () => {
    expect(isLockContentionError(new ConnectionException(driverError('XX000')))).toBe(false);
    expect(isLockContentionError(new Error('Connection terminated unexpectedly'))).toBe(false);
  });
});
