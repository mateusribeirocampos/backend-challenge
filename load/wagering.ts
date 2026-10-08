import { randomUUID } from 'node:crypto';
import { Money } from '../src/domain/money/money.js';
import type { Instance } from './cluster.js';
import { type FinalAnswer, postUntilFinal, type RequestRecorder, type RoundRobin } from './http-load.js';

/**
 * The provider side of the API: open wallets, build wager bodies, and keep the balance
 * each wallet SHOULD have from the answers the clients got. That expected balance is
 * what the correctness check compares with the database: a debit applied twice, or an
 * accepted bet that left no trace, would make them differ.
 */

export const CURRENCY = 'BRL';
/** Large enough that no BET of the run is refused for lack of funds by accident. */
export const INITIAL_BALANCE = '1000000.00';
const PROVIDER = 'provider-load';

export type WagerKind = 'BET' | 'WIN' | 'LOSS' | 'REFUND';

export interface LoadWallet {
  readonly id: string;
  readonly playerId: string;
}

export interface WagerBody {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerKind;
  readonly money: { readonly amount: string; readonly currency: string };
  readonly referenceExternalTransactionId?: string;
}

export async function openWallets(instance: Instance, count: number): Promise<LoadWallet[]> {
  return Promise.all(Array.from({ length: count }, () => openWallet(instance)));
}

async function openWallet(instance: Instance): Promise<LoadWallet> {
  const playerId = randomUUID();
  const response = await fetch(`${instance.baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount: INITIAL_BALANCE, currency: CURRENCY } }),
  });
  if (response.status !== 201) {
    throw new Error(`opening a wallet answered ${response.status}: ${await response.text()}`);
  }
  const body = (await response.json()) as { id: string };
  return { id: body.id, playerId };
}

export interface RoundRef {
  readonly roundId: string;
  /** externalTransactionId of the BET a WIN, LOSS or REFUND settles or reverts. */
  readonly reference?: string;
}

/** channel goes into the externalTransactionId, so the checks can tell HTTP and SQS operations apart. */
export function wagerBody(
  wallet: LoadWallet,
  kind: WagerKind,
  amount: string,
  round: RoundRef = { roundId: `round-${randomUUID()}` },
  channel: 'http' | 'sqs' = 'http',
): WagerBody {
  return {
    providerId: PROVIDER,
    externalTransactionId: `ext-${channel}-${randomUUID()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: round.roundId,
    gameId: 'load-test',
    kind,
    money: { amount, currency: CURRENCY },
    ...(round.reference === undefined ? {} : { referenceExternalTransactionId: round.reference }),
  };
}

/** Spec 9 default key: "{providerId}:{externalTransactionId}". */
export function idempotencyKey(body: WagerBody): string {
  return `${body.providerId}:${body.externalTransactionId}`;
}

export function submitWager(instances: RoundRobin, body: WagerBody, recorder: RequestRecorder): Promise<FinalAnswer> {
  return postUntilFinal(instances, '/wagering/transactions', body, { 'idempotency-key': idempotencyKey(body) }, recorder);
}

/**
 * Balance each wallet should have, built only from what the API answered. Uses the
 * domain Money: the load test follows the same "no number for money" rule.
 */
export class ExpectedBalances {
  private readonly balances = new Map<string, Money>();
  private processedCount = 0;

  track(wallet: LoadWallet): void {
    this.balances.set(wallet.id, Money.from({ amount: INITIAL_BALANCE, currency: CURRENCY }));
  }

  /** A transaction that ended PROCESSED: apply its effect (LOSS moves nothing). */
  applyProcessed(walletId: string, kind: WagerKind, amount: string): void {
    const current = this.balances.get(walletId);
    if (current === undefined) throw new Error(`wallet ${walletId} is not tracked`);
    const money = Money.from({ amount, currency: CURRENCY });
    const next = kind === 'BET' ? current.subtract(money) : kind === 'LOSS' ? current : current.add(money);
    this.balances.set(walletId, next);
    this.processedCount += 1;
  }

  balanceOf(walletId: string): string | undefined {
    return this.balances.get(walletId)?.amount;
  }

  walletIds(): string[] {
    return [...this.balances.keys()];
  }

  /** How many transactions the clients saw PROCESSED (each operation once, retries included). */
  processed(): number {
    return this.processedCount;
  }
}

/** True when the API answered that this operation took effect. */
export function wasProcessed(answer: FinalAnswer): boolean {
  return (answer.status === 201 || answer.status === 200) && answer.body.status === 'PROCESSED';
}
