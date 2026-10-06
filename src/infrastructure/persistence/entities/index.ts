import { OutboxMessageEntity } from './outbox-message.entity.js';
import { WagerTransactionEntity } from './wager-transaction.entity.js';
import { WalletLedgerEntryEntity } from './wallet-ledger-entry.entity.js';
import { WalletEntity } from './wallet.entity.js';

/** Every mapped table, registered explicitly in the ORM config (no folder discovery). */
export const ENTITIES = [WalletEntity, WagerTransactionEntity, WalletLedgerEntryEntity, OutboxMessageEntity];
