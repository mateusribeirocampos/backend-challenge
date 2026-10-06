import { WagerTransactionProcessed, WalletBalanceChanged } from '../../domain/events/wagering-events.js';
import { Money, type MoneyProps } from '../../domain/money/money.js';
import { OutboxMessage } from '../../domain/outbox/outbox-message.js';
import { Wallet } from '../../domain/wallet/wallet.js';
import { WalletAlreadyExistsError } from '../errors.js';
import type { Clock } from '../ports/clock.js';
import type { IdGenerator } from '../ports/id-generator.js';
import type { TransactionRunner } from '../ports/transaction-runner.js';
import { toWalletView, type WalletView } from './wallet-view.js';

export interface OpenWalletCommand {
  readonly playerId: string;
  readonly initialBalance: MoneyProps;
  readonly correlationId: string;
}

/**
 * POST /wallets. The wallet row, the internal OPENING transaction, its CREDIT ledger
 * entry and the two events are written in one SQL transaction (spec 9): the database
 * never sees a wallet with a balance and no ledger entry.
 */
export class OpenWallet {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: OpenWalletCommand): Promise<WalletView> {
    const at = this.clock.now();
    const { wallet, opening } = Wallet.open({
      id: this.ids.newId(),
      playerId: command.playerId,
      initialBalance: Money.from(command.initialBalance),
      at,
      openingTransactionId: this.ids.newId(),
      openingLedgerEntryId: this.ids.newId(),
    });

    await this.runner.run(async (repositories) => {
      // ON CONFLICT DO NOTHING on (player_id, currency): two parallel requests for the
      // same player both reach this line; the second waits for the first to commit and
      // then sees the conflict.
      const inserted = await repositories.wallets.insertIfAbsent(wallet);
      if (!inserted) {
        throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency);
      }
      if (opening === undefined) {
        return; // opened at 0.00: nothing moved, so no OPENING, no ledger entry, no event
      }

      // Foreign key order: wallet (above), then the transaction, then its ledger entry.
      await repositories.transactions.insert(opening.transaction);
      await repositories.ledger.append(opening.ledgerEntry);

      const context = (eventId: string) => ({ eventId, correlationId: command.correlationId, occurredAt: at });
      await repositories.outbox.add([
        OutboxMessage.enqueue(WagerTransactionProcessed.from(opening.transaction, context(this.ids.newId()))),
        OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, opening.ledgerEntry, context(this.ids.newId()))),
      ]);
    });

    return toWalletView(wallet);
  }
}
