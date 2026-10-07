import { describe, expect, test } from 'bun:test';
import { CurrencyNotSupportedError } from '../../../../src/application/errors.js';
import type { Clock } from '../../../../src/application/ports/clock.js';
import type { IdGenerator } from '../../../../src/application/ports/id-generator.js';
import type { TransactionRunner } from '../../../../src/application/ports/transaction-runner.js';
import { OpenWallet } from '../../../../src/application/wallets/open-wallet.js';

const clock: Clock = { now: () => new Date('2026-10-07T12:00:00.000Z') };
let counter = 0;
const ids: IdGenerator = { newId: () => `0192f291-27dd-7d3f-8071-${String(++counter).padStart(12, '0')}` };

/** Fails the test if the use case touches the database. */
const untouchedRunner = {
  run: () => {
    throw new Error('the database must not be touched for an unsupported currency');
  },
} as unknown as TransactionRunner;

describe('OpenWallet: currencies the platform operates', () => {
  test('refuses a valid ISO-4217 code the platform does not operate, before touching the database', async () => {
    const openWallet = new OpenWallet(untouchedRunner, clock, ids, ['BRL']);

    const attempt = openWallet.execute({
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      initialBalance: { amount: '10.00', currency: 'USD' },
      correlationId: 'test',
    });

    await expect(attempt).rejects.toBeInstanceOf(CurrencyNotSupportedError);
    await expect(attempt).rejects.toMatchObject({ code: 'CURRENCY_NOT_SUPPORTED' });
  });

  test.each(['XAU', 'HRK', 'USN'])('refuses %p (valid ISO-4217, not money the platform operates)', async (currency) => {
    const openWallet = new OpenWallet(untouchedRunner, clock, ids, ['BRL']);

    await expect(
      openWallet.execute({
        playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
        initialBalance: { amount: '10.00', currency },
        correlationId: 'test',
      }),
    ).rejects.toBeInstanceOf(CurrencyNotSupportedError);
  });
});
