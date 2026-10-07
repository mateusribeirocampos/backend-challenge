import { describe, expect, test } from 'bun:test';
import { InboxMessage, InvalidInboxMessageError } from '../../../../src/domain/inbox/inbox-message.js';
import { DomainInvariantError } from '../../../../src/domain/shared/domain-error.js';
import { AT, LATER } from '../support/domain-fixtures.js';

const received = () =>
  InboxMessage.receive({
    consumerName: 'wager-transactions',
    messageId: 'msg-123',
    payloadHash: 'b'.repeat(64),
    receivedAt: AT,
  });

describe('InboxMessage.receive', () => {
  test('starts not processed, keyed by (consumerName, messageId)', () => {
    const message = received();

    expect(message.consumerName).toBe('wager-transactions');
    expect(message.messageId).toBe('msg-123');
    expect(message.payloadHash).toBe('b'.repeat(64));
    expect(message.receivedAt).toEqual(AT);
    expect(message.isProcessed()).toBe(false);
    expect(message.processedAt).toBeUndefined();
  });

  test.each(['consumerName', 'messageId', 'payloadHash'] as const)('a blank %s is refused', (field) => {
    const attempt = () =>
      InboxMessage.receive({
        consumerName: 'wager-transactions',
        messageId: 'msg-123',
        payloadHash: 'b'.repeat(64),
        receivedAt: AT,
        [field]: ' ',
      });

    expect(attempt).toThrow(InvalidInboxMessageError);
  });
});

describe('InboxMessage.markProcessed', () => {
  test('records when the message was processed', () => {
    const message = received();

    message.markProcessed(LATER);

    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(LATER);
  });

  test('a second markProcessed is a programming error: a message is processed once', () => {
    const message = received();
    message.markProcessed(LATER);

    expect(() => message.markProcessed(LATER)).toThrow(DomainInvariantError);
    expect(message.processedAt).toEqual(LATER);
  });

  test('a processedAt a little before receivedAt (wall clock moved back) is accepted, not a failure', () => {
    const message = received();

    message.markProcessed(new Date(AT.getTime() - 5));

    expect(message.isProcessed()).toBe(true);
  });
});

describe('InboxMessage.rehydrate', () => {
  test('rebuilds a stored row as it is, processed or not, without checks', () => {
    const processed = InboxMessage.rehydrate({
      consumerName: 'wager-transactions',
      messageId: 'msg-123',
      payloadHash: 'b'.repeat(64),
      receivedAt: AT,
      processedAt: LATER,
    });
    const pending = InboxMessage.rehydrate({
      consumerName: 'wager-transactions',
      messageId: 'msg-124',
      payloadHash: 'c'.repeat(64),
      receivedAt: AT,
      processedAt: undefined,
    });

    expect(processed.isProcessed()).toBe(true);
    expect(processed.processedAt).toEqual(LATER);
    expect(pending.isProcessed()).toBe(false);
  });
});

describe('InboxMessage.matchesPayload', () => {
  test('same hash: the same message delivered again; another hash: the messageId was reused for other content', () => {
    const message = received();

    expect(message.matchesPayload('b'.repeat(64))).toBe(true);
    expect(message.matchesPayload('c'.repeat(64))).toBe(false);
  });
});
