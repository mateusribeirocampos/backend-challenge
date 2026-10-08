import { describe, expect, test } from 'bun:test';
import { percentile, summarize } from '../../../load/stats.js';

describe('percentile (nearest rank)', () => {
  const tenValues = [10, 1, 9, 2, 8, 3, 7, 4, 6, 5];

  test('p50 of 1..10 is 5: half of the values are at or below it', () => {
    expect(percentile(tenValues, 50)).toBe(5);
  });

  test('p95 and p99 of 1..10 are the largest value: 9 values cover only 90%', () => {
    expect(percentile(tenValues, 95)).toBe(10);
    expect(percentile(tenValues, 99)).toBe(10);
  });

  test('p99 of 1..1000 is 990, never an interpolated value that was not measured', () => {
    const values = Array.from({ length: 1000 }, (_, index) => index + 1);
    expect(percentile(values, 99)).toBe(990);
    expect(percentile(values, 99.9)).toBe(999);
  });

  test('the input order does not matter and the input is not changed', () => {
    const values = [3, 1, 2];
    expect(percentile(values, 50)).toBe(2);
    expect(values).toEqual([3, 1, 2]);
  });

  test('p0 is the smallest value, p100 the largest', () => {
    expect(percentile(tenValues, 0)).toBe(1);
    expect(percentile(tenValues, 100)).toBe(10);
  });

  test('no values: there is no percentile', () => {
    expect(percentile([], 50)).toBeUndefined();
  });

  test('a percentile outside 0..100 is a programming error', () => {
    expect(() => percentile(tenValues, 101)).toThrow();
    expect(() => percentile(tenValues, -1)).toThrow();
  });
});

describe('summarize', () => {
  test('count, p50, p95, p99, max and mean of the measured values', () => {
    const values = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(summarize(values)).toEqual({ count: 100, p50: 50, p95: 95, p99: 99, max: 100, mean: 50.5 });
  });

  test('one slow request shows in max and p99 of a small sample, not in p50', () => {
    const values = [...Array.from({ length: 99 }, () => 5), 2000];
    const summary = summarize(values);
    expect(summary?.p50).toBe(5);
    expect(summary?.p99).toBe(5);
    expect(summary?.max).toBe(2000);
  });

  test('no values: undefined, so the report says "n/d" instead of a zero that was never measured', () => {
    expect(summarize([])).toBeUndefined();
  });
});
