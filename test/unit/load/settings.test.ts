import { describe, expect, test } from 'bun:test';
import { assertDisposableLoadDatabase, loadSettings } from '../../../load/settings.js';

/** The load run drops its database: only a name that says "disposable" may be the target. */
describe('load database name', () => {
  test('defaults to wagering_load and accepts any other name ending in _load', () => {
    expect(loadSettings({}).databaseName).toBe('wagering_load');
    expect(loadSettings({ LOAD_DATABASE_NAME: 'review_20261008_load' }).databaseName).toBe('review_20261008_load');
  });

  test('refuses the databases of the application and of bun test, and any name without the suffix', () => {
    for (const name of ['wagering_test', 'wagering', 'postgres', 'load', 'wagering_load_copy']) {
      expect(() => loadSettings({ LOAD_DATABASE_NAME: name })).toThrow();
    }
  });

  test('the guard at the DROP itself refuses the application database even if it ends in _load', () => {
    expect(() => assertDisposableLoadDatabase('wagering_test', 'wagering')).toThrow();
    expect(() => assertDisposableLoadDatabase('app_load', 'app_load')).toThrow();
    expect(() => assertDisposableLoadDatabase('wagering_load', 'wagering')).not.toThrow();
  });
});
