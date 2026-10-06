import { describe, expect, test } from 'bun:test';
import type { EventContext } from '../../../../src/domain/events/integration-event.js';
import { WagerTransactionProcessed } from '../../../../src/domain/events/wagering-events.js';
import {
  OutboxMessage,
  type OutboxMessageState,
  type RetryPolicy,
} from '../../../../src/domain/outbox/outbox-message.js';
import { DomainInvariantError } from '../../../../src/domain/shared/domain-error.js';
import { applyWagerTransaction } from '../../../../src/domain/wager/apply-wager-transaction.js';
import { WagerTransactionKind } from '../../../../src/domain/wager/wager-transaction-kind.js';
import { brl, LATER, submitted, WALLET_ID, walletWith } from '../support/domain-fixtures.js';

const OCCURRED_AT = new Date('2026-10-06T12:00:00.000Z');

function processedEvent(): WagerTransactionProcessed {
  const wallet = walletWith(brl('100.00'));
  const bet = submitted({ kind: WagerTransactionKind.Bet, money: brl('25.00'), externalTransactionId: 'bet-1' });
  applyWagerTransaction({ wallet, transaction: bet, reference: undefined, referenceAlreadyReversed: false, ledgerEntryId: 'e', at: LATER });
  const context: EventContext = { eventId: 'event-1', correlationId: 'corr-1', occurredAt: OCCURRED_AT };
  return WagerTransactionProcessed.from(bet, context);
}

/** Policy with a fixed "random", so the delays are exact numbers. */
function policy(random: number): RetryPolicy {
  return { baseDelayMs: 1_000, maxDelayMs: 60_000, random: () => random };
}

function secondsAfter(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1_000);
}

describe('OutboxMessage.enqueue', () => {
  test('copies the event envelope; due right away, never attempted, not published', () => {
    const event = processedEvent();

    const message = OutboxMessage.enqueue(event);

    expect(message.id).toBe('event-1');
    expect(message.aggregateId).toBe(WALLET_ID);
    expect(message.eventType).toBe('WagerTransactionProcessed');
    expect(message.payload).toEqual({ ...event.toJSON() });
    expect(message.occurredAt).toEqual(OCCURRED_AT);
    expect(message.attempts).toBe(0);
    expect(message.nextAttemptAt).toEqual(OCCURRED_AT);
    expect(message.publishedAt).toBeUndefined();
    expect(message.isPending()).toBe(true);
  });

  test('the payload is plain JSON that round-trips through JSON.stringify', () => {
    const message = OutboxMessage.enqueue(processedEvent());

    expect(JSON.parse(JSON.stringify(message.payload))).toEqual(message.payload);
  });
});

describe('isDue', () => {
  test('due at and after nextAttemptAt, not before', () => {
    const message = OutboxMessage.enqueue(processedEvent());

    expect(message.isDue(secondsAfter(OCCURRED_AT, -1))).toBe(false);
    expect(message.isDue(OCCURRED_AT)).toBe(true);
    expect(message.isDue(secondsAfter(OCCURRED_AT, 10))).toBe(true);
  });

  test('a published message is never due again', () => {
    const message = OutboxMessage.enqueue(processedEvent());
    message.markPublished(secondsAfter(OCCURRED_AT, 1));

    expect(message.isPending()).toBe(false);
    expect(message.isDue(secondsAfter(OCCURRED_AT, 3600))).toBe(false);
  });
});

describe('scheduleRetry: exponential backoff with jitter', () => {
  test('random = 1 (top of the jitter range): 1s, 2s, 4s, 8s after each failure', () => {
    const message = OutboxMessage.enqueue(processedEvent());
    const now = secondsAfter(OCCURRED_AT, 100);

    const delays: number[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      message.scheduleRetry(now, policy(1));
      delays.push((message.nextAttemptAt.getTime() - now.getTime()) / 1_000);
    }

    expect(delays).toEqual([1, 2, 4, 8]);
    expect(message.attempts).toBe(4);
  });

  test('random = 0 (bottom of the jitter range): half of the exponential delay', () => {
    const message = OutboxMessage.enqueue(processedEvent());
    const now = secondsAfter(OCCURRED_AT, 100);

    message.scheduleRetry(now, policy(0));
    message.scheduleRetry(now, policy(0));
    message.scheduleRetry(now, policy(0));

    expect(message.nextAttemptAt).toEqual(new Date(now.getTime() + 2_000));
  });

  test('the delay never goes above maxDelayMs', () => {
    const message = OutboxMessage.enqueue(processedEvent());
    const now = secondsAfter(OCCURRED_AT, 100);

    for (let attempt = 0; attempt < 20; attempt++) {
      message.scheduleRetry(now, policy(1));
    }

    expect(message.nextAttemptAt).toEqual(new Date(now.getTime() + 60_000));
    expect(message.attempts).toBe(20);
  });

  test('two publishers failing at the same moment get different times (jitter spreads the retries)', () => {
    const first = OutboxMessage.enqueue(processedEvent());
    const second = OutboxMessage.enqueue(processedEvent());
    const now = secondsAfter(OCCURRED_AT, 100);

    first.scheduleRetry(now, policy(0.1));
    second.scheduleRetry(now, policy(0.9));

    expect(first.nextAttemptAt.getTime()).not.toBe(second.nextAttemptAt.getTime());
  });

  test('the default policy keeps the delay inside [half, full] of the exponential step', () => {
    const message = OutboxMessage.enqueue(processedEvent());
    const now = secondsAfter(OCCURRED_AT, 100);

    message.scheduleRetry(now);

    const delay = message.nextAttemptAt.getTime() - now.getTime();
    expect(delay).toBeGreaterThanOrEqual(500);
    expect(delay).toBeLessThanOrEqual(1_000);
  });
});

describe('published is terminal', () => {
  test('markPublished twice or a retry after publishing are caller bugs', () => {
    const message = OutboxMessage.enqueue(processedEvent());
    message.markPublished(LATER);

    expect(message.publishedAt).toEqual(LATER);
    expect(() => message.markPublished(LATER)).toThrow(DomainInvariantError);
    expect(() => message.scheduleRetry(LATER, policy(1))).toThrow(DomainInvariantError);
  });
});

describe('OutboxMessage.rehydrate', () => {
  test('rebuilds the stored state as it is, without checks', () => {
    const state: OutboxMessageState = {
      id: 'event-9',
      aggregateId: WALLET_ID,
      eventType: 'WalletBalanceChanged',
      payload: { eventId: 'event-9' },
      occurredAt: OCCURRED_AT,
      attempts: 3,
      nextAttemptAt: secondsAfter(OCCURRED_AT, 30),
      publishedAt: undefined,
    };

    const message = OutboxMessage.rehydrate(state);

    expect(message.attempts).toBe(3);
    expect(message.isDue(secondsAfter(OCCURRED_AT, 29))).toBe(false);
    expect(message.isDue(secondsAfter(OCCURRED_AT, 30))).toBe(true);
  });
});
