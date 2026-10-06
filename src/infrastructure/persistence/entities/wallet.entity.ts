import { defineEntity, type InferEntity, p } from '@mikro-orm/core';

/**
 * Mapping of the wallets table. The migration is the source of truth for the schema
 * (constraints, triggers); this only tells MikroORM how to read and write the columns.
 *
 * version is a plain integer on purpose, NOT `.version()`: MikroORM's optimistic lock
 * would bump it on every flush by itself, but here the version must move exactly with
 * the ledger (the schema checks wallet.version == last entry's wallet_version at COMMIT).
 */
export const WalletEntity = defineEntity({
  name: 'WalletRecord',
  tableName: 'wallets',
  properties: {
    id: p.uuid().primary(),
    playerId: p.uuid(),
    currency: p.string(),
    // numeric(20,2) read and written as a string: never a JavaScript number.
    balanceAmount: p.decimal('string'),
    version: p.integer(),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
  },
});

export type WalletRecord = InferEntity<typeof WalletEntity>;
