import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Cheap guard for the eliminatory rule "no number for money": the domain never turns
 * a value into a JavaScript number. Decimal#toNumber and the global converters are
 * the usual ways a float sneaks in.
 */
const DOMAIN_DIR = join(import.meta.dir, '../../../src/domain');
const FORBIDDEN = [/\bparseFloat\(/, /\bparseInt\(/, /\bNumber\(/, /\.toNumber\(/, /\bMath\.round\(/];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts'))
    .map((file) => join(dir, file));
}

describe('no number for money in src/domain', () => {
  test('there is domain code to check', () => {
    expect(sourceFiles(DOMAIN_DIR).length).toBeGreaterThan(0);
  });

  test('no parseFloat, parseInt, Number(), toNumber() or Math.round in the domain', () => {
    const offenders = sourceFiles(DOMAIN_DIR).flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .map((line, index) => ({ file, line: index + 1, text: line }))
        .filter(({ text }) => FORBIDDEN.some((pattern) => pattern.test(text))),
    );

    expect(offenders).toEqual([]);
  });
});
