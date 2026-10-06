import { Migration } from '@mikro-orm/migrations';

/**
 * wallets: one row per player and currency, holding the materialized balance.
 * Guarantees here (spec 5.9): one wallet per player + currency, balance never negative,
 * version >= 1, ISO-4217 shaped currency.
 *
 * How version follows the balance is enforced with the ledger table (next migrations):
 * at COMMIT the wallet balance and version must equal the last ledger entry.
 */
export class Migration20261006164423_create_wallets extends Migration {
  override name = 'Migration20261006164423_create_wallets';

  override up(): void {
    this.addSql(`
      create table wallets (
        id uuid not null,
        player_id uuid not null,
        currency char(3) not null,
        balance_amount numeric(20, 2) not null,
        version integer not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wallets_pkey primary key (id),
        constraint wallets_player_currency_unique unique (player_id, currency),
        constraint wallets_currency_format check (currency ~ '^[A-Z]{3}$'),
        constraint wallets_balance_non_negative check (balance_amount >= 0),
        constraint wallets_version_positive check (version >= 1)
      )`);
  }

  // Must undo everything up() created, in reverse order.
  override down(): void {
    this.addSql('drop table wallets');
  }
}
