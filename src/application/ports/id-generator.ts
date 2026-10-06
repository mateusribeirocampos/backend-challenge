/**
 * New ids for wallets, transactions, ledger entries and events. The adapter generates
 * UUIDv7: time ordered, so new rows land at the end of the primary key index instead
 * of at random pages.
 */
export interface IdGenerator {
  newId(): string;
}

export const ID_GENERATOR = Symbol('ID_GENERATOR');
