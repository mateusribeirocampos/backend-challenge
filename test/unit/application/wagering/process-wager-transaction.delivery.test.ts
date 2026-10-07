import { describe, expect, test } from 'bun:test';
import { MessageIdConflictError } from '../../../../src/application/errors.js';
import type { Repositories } from '../../../../src/application/ports/repositories.js';
import type { TransactionRunner } from '../../../../src/application/ports/transaction-runner.js';
import {
  type MessageDelivery,
  ProcessWagerTransaction,
  type ProcessWagerTransactionCommand,
} from '../../../../src/application/wagering/process-wager-transaction.js';
import { InboxMessage } from '../../../../src/domain/inbox/inbox-message.js';
import { DomainInvariantError } from '../../../../src/domain/shared/domain-error.js';
import { WagerTransactionKind } from '../../../../src/domain/wager/wager-transaction-kind.js';
import { InvalidWagerTransactionError, type WagerTransaction } from '../../../../src/domain/wager/wager-transaction.js';
import { AT, brl, LATER, PLAYER_ID, ROUND_ID, submitted, WALLET_ID } from '../../domain/support/domain-fixtures.js';

/**
 * The redelivery branch of executeDelivery, with the repositories replaced by small
 * in-memory fakes. Only the methods this branch may call exist; any other call fails the
 * test, which also proves the branch does not touch the wallet, the ledger or the outbox.
 */
const STORED_HASH = 'b'.repeat(64);

function command(): ProcessWagerTransactionCommand {
  return {
    providerId: 'provider-a',
    externalTransactionId: 'b1',
    idempotencyKey: 'provider-a:b1',
    playerId: PLAYER_ID,
    walletId: WALLET_ID,
    roundId: ROUND_ID,
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: { amount: '25.00', currency: 'BRL' },
    correlationId: 'msg-1',
    causationId: 'msg-1',
  };
}

function delivery(payloadHash = STORED_HASH): MessageDelivery {
  return { consumerName: 'wager-transactions', messageId: 'msg-1', payloadHash };
}

/** The operation as the first delivery stored it: PROCESSED, balance 75.00. */
function storedOperation(): WagerTransaction {
  const transaction = submitted({ kind: WagerTransactionKind.Bet, money: brl('25.00'), externalTransactionId: 'b1' });
  transaction.markProcessed({ referenceTransactionId: undefined, resultBalance: brl('75.00'), at: LATER });
  return transaction;
}

function harness(stored: { inbox?: InboxMessage; operation?: WagerTransaction }) {
  const calls: string[] = [];
  const unexpected = (name: string) => () => {
    throw new Error(`${name} must not be called on a redelivery`);
  };
  const repositories = {
    inbox: {
      insertIfAbsent: async () => {
        calls.push('inbox.insertIfAbsent');
        return stored.inbox === undefined;
      },
      find: async () => {
        calls.push('inbox.find');
        return stored.inbox;
      },
      saveProcessed: unexpected('inbox.saveProcessed'),
    },
    transactions: {
      findByIdempotencyKey: async (key: string) => {
        calls.push(`transactions.findByIdempotencyKey(${key})`);
        return stored.operation;
      },
      insertIfAbsent: unexpected('transactions.insertIfAbsent'),
    },
    wallets: { lockById: unexpected('wallets.lockById') },
    ledger: { append: unexpected('ledger.append') },
    outbox: { add: unexpected('outbox.add') },
  } as unknown as Repositories;
  let transactions = 0;
  const runner: TransactionRunner = {
    run: async (work) => {
      transactions += 1;
      return work(repositories);
    },
  };
  let ids = 0;
  const useCase = new ProcessWagerTransaction(runner, { now: () => AT }, { newId: () => `id-${++ids}` });
  return { useCase, calls, transactionsOpened: () => transactions };
}

function storedInbox(payloadHash: string): InboxMessage {
  const inbox = InboxMessage.receive({ consumerName: 'wager-transactions', messageId: 'msg-1', payloadHash, receivedAt: AT });
  inbox.markProcessed(AT);
  return inbox;
}

describe('ProcessWagerTransaction.executeDelivery: a message the inbox already has', () => {
  test('same data: answered from the stored operation, as a duplicate and a replay, nothing written', async () => {
    const { useCase, calls } = harness({ inbox: storedInbox(STORED_HASH), operation: storedOperation() });

    const answer = await useCase.executeDelivery(command(), delivery());

    expect(answer).toEqual({
      duplicateMessage: true,
      result: {
        transactionId: 'tx-b1',
        status: 'PROCESSED',
        balance: { amount: '75.00', currency: 'BRL' },
        idempotentReplay: true,
      },
    });
    expect(calls).toEqual(['inbox.insertIfAbsent', 'inbox.find', 'transactions.findByIdempotencyKey(provider-a:b1)']);
  });

  test('same messageId, different data: MessageIdConflictError, and the operation is never looked at', async () => {
    const { useCase, calls } = harness({ inbox: storedInbox('c'.repeat(64)), operation: storedOperation() });

    await expect(useCase.executeDelivery(command(), delivery(STORED_HASH))).rejects.toBeInstanceOf(MessageIdConflictError);
    expect(calls).toEqual(['inbox.insertIfAbsent', 'inbox.find']);
  });

  test('inbox row without its operation is impossible in a committed state: a loud invariant error, not a silent ack', async () => {
    const { useCase } = harness({ inbox: storedInbox(STORED_HASH) });

    await expect(useCase.executeDelivery(command(), delivery())).rejects.toBeInstanceOf(DomainInvariantError);
  });

  test('a contract violation is refused before any transaction or inbox access', async () => {
    const { useCase, calls, transactionsOpened } = harness({});

    await expect(
      useCase.executeDelivery({ ...command(), kind: WagerTransactionKind.Refund }, delivery()),
    ).rejects.toBeInstanceOf(InvalidWagerTransactionError);
    expect(transactionsOpened()).toBe(0);
    expect(calls).toEqual([]);
  });
});
