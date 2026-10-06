import { Money } from '../../../../src/domain/money/money.js';
import type { WagerTransactionKind } from '../../../../src/domain/wager/wager-transaction-kind.js';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
} from '../../../../src/domain/wager/wager-transaction.js';
import { Wallet } from '../../../../src/domain/wallet/wallet.js';

/** Fixed clock: the domain never reads the time by itself, so every test is deterministic. */
export const AT = new Date('2026-10-06T12:00:00.000Z');
export const LATER = new Date('2026-10-06T12:00:05.000Z');

export const PLAYER_ID = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
export const OTHER_PLAYER_ID = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a2';
export const WALLET_ID = '0192f291-27dd-7d3f-8071-5f8685deef37';
export const PROVIDER_ID = 'provider-a';
export const ROUND_ID = 'round-987';

export function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

export function usd(amount: string): Money {
  return Money.from({ amount, currency: 'USD' });
}

/** A stored wallet with the given balance (version 1, as if just opened). */
export function walletWith(balance: Money, playerId = PLAYER_ID): Wallet {
  return Wallet.rehydrate({
    id: WALLET_ID,
    playerId,
    currency: balance.currency,
    balance,
    version: 1,
    createdAt: AT,
    updatedAt: AT,
  });
}

export interface SubmitOptions {
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly externalTransactionId: string;
  readonly referenceExternalTransactionId?: string;
  readonly playerId?: string;
  readonly roundId?: string;
  readonly walletId?: string;
}

/** Builds valid create props; any field can be overridden to test one rule at a time. */
export function submitProps(options: SubmitOptions): CreateWagerTransactionProps {
  return {
    id: `tx-${options.externalTransactionId}`,
    providerId: PROVIDER_ID,
    externalTransactionId: options.externalTransactionId,
    idempotencyKey: `${PROVIDER_ID}:${options.externalTransactionId}`,
    payloadHash: 'a'.repeat(64),
    walletId: options.walletId ?? WALLET_ID,
    playerId: options.playerId ?? PLAYER_ID,
    roundId: options.roundId ?? ROUND_ID,
    gameId: 'fortune-chimp',
    kind: options.kind,
    money: options.money,
    referenceExternalTransactionId: options.referenceExternalTransactionId,
    createdAt: AT,
  };
}

export function submitted(options: SubmitOptions): WagerTransaction {
  return WagerTransaction.create(submitProps(options));
}
