import { Migration } from '@mikro-orm/migrations';

/**
 * wallet_ledger_entries: append-only history of every balance change.
 *
 * Besides the per-row arithmetic (balance_before +/- amount = balance_after), the schema
 * makes the ledger of each wallet a numbered chain with no gaps and ties the wallet row
 * to its end:
 *   - wallet_version is the wallet version right after the entry, unique per wallet,
 *     so two entries computed from the same wallet state cannot both be stored
 *     (concurrent writers: the second INSERT waits on the index and fails with 23505);
 *   - a BEFORE INSERT trigger requires each entry to start where the previous one ended,
 *     with version + 1 (a stale writer that comes after a commit fails with 23514).
 *     The first entry starts at 0.00 with version 1 when it is the OPENING credit, or
 *     version 2 otherwise (a wallet opened at 0.00 is version 1 with no entry);
 *   - DEFERRED constraint triggers check at COMMIT that the wallet balance and version
 *     equal the last entry's balance_after and wallet_version (0.00 and 1 if none).
 * The per-wallet cursor of the ledger is (wallet_id, wallet_version), served by the
 * unique index.
 */
export class Migration20261006164425_create_wallet_ledger_entries extends Migration {
  override name = 'Migration20261006164425_create_wallet_ledger_entries';

  override up(): void {
    // Targets for the composite foreign keys below. Both are unique already (id is the
    // primary key); PostgreSQL only needs the exact column list declared as unique.
    this.addSql('alter table wallets add constraint wallets_id_currency_unique unique (id, currency)');
    this.addSql(`
      alter table wager_transactions add constraint wager_transactions_ledger_target_unique
        unique (id, wallet_id, amount, currency)`);

    this.addSql(`
      create table wallet_ledger_entries (
        id uuid not null,
        wallet_id uuid not null,
        transaction_id uuid not null,
        direction text not null,
        amount numeric(20, 2) not null,
        currency char(3) not null,
        balance_before numeric(20, 2) not null,
        balance_after numeric(20, 2) not null,
        wallet_version integer not null,
        created_at timestamptz not null,

        constraint wallet_ledger_entries_pkey primary key (id),
        -- same wallet and currency as the wallet row
        constraint wallet_ledger_entries_wallet_fk
          foreign key (wallet_id, currency) references wallets (id, currency),
        -- same wallet, amount and currency as the transaction that caused it
        constraint wallet_ledger_entries_transaction_fk
          foreign key (transaction_id, wallet_id, amount, currency)
          references wager_transactions (id, wallet_id, amount, currency),
        -- a transaction produces at most one entry per wallet (spec 6.4)
        constraint wallet_ledger_entries_one_per_transaction_and_wallet unique (transaction_id, wallet_id),
        constraint wallet_ledger_entries_wallet_version_unique unique (wallet_id, wallet_version),

        constraint wallet_ledger_entries_direction_valid check (direction in ('DEBIT', 'CREDIT')),
        constraint wallet_ledger_entries_amount_positive check (amount > 0),
        constraint wallet_ledger_entries_balance_before_non_negative check (balance_before >= 0),
        constraint wallet_ledger_entries_balance_after_non_negative check (balance_after >= 0),
        constraint wallet_ledger_entries_arithmetic check (
          balance_after = balance_before + case direction when 'CREDIT' then amount else -amount end),
        constraint wallet_ledger_entries_wallet_version_positive check (wallet_version >= 1)
      )`);

    // Append-only (spec 5.5): no UPDATE, no DELETE, no TRUNCATE.
    this.addSql(`
      create function wallet_ledger_entries_append_only() returns trigger language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entries is append-only: % is not allowed', tg_op
          using errcode = 'restrict_violation', constraint = 'wallet_ledger_entries_append_only';
      end
      $$`);
    this.addSql(`
      create trigger wallet_ledger_entries_append_only
        before update or delete on wallet_ledger_entries
        for each row execute function wallet_ledger_entries_append_only()`);
    this.addSql(`
      create trigger wallet_ledger_entries_no_truncate
        before truncate on wallet_ledger_entries
        for each statement execute function wallet_ledger_entries_append_only()`);

    // Each entry continues the previous one of the same wallet, with no gap.
    this.addSql(`
      create function wallet_ledger_entries_chain() returns trigger language plpgsql as $$
      declare
        previous record;
        transaction_kind text;
        expected_version integer;
      begin
        select kind into transaction_kind from wager_transactions where id = new.transaction_id;

        select balance_after, wallet_version into previous
          from wallet_ledger_entries
         where wallet_id = new.wallet_id
         order by wallet_version desc
         limit 1;

        if not found then
          -- First entry: the OPENING credit is version 1; without OPENING the wallet
          -- was opened at 0.00 (version 1, no entry), so its first movement is version 2.
          expected_version := case when transaction_kind = 'OPENING' then 1 else 2 end;
          if new.balance_before <> 0 or new.wallet_version <> expected_version then
            raise exception 'first ledger entry of wallet % must start at 0.00 with version %, got % and %',
              new.wallet_id, expected_version, new.balance_before, new.wallet_version
              using errcode = 'check_violation', constraint = 'wallet_ledger_entries_chain';
          end if;
        elsif transaction_kind = 'OPENING' then
          raise exception 'OPENING must be the first ledger entry of wallet %', new.wallet_id
            using errcode = 'check_violation', constraint = 'wallet_ledger_entries_chain';
        elsif new.balance_before <> previous.balance_after or new.wallet_version <> previous.wallet_version + 1 then
          raise exception 'ledger entry breaks the chain of wallet %: expected balance_before % and wallet_version %, got % and %',
            new.wallet_id, previous.balance_after, previous.wallet_version + 1, new.balance_before, new.wallet_version
            using errcode = 'check_violation', constraint = 'wallet_ledger_entries_chain';
        end if;
        return new;
      end
      $$`);
    this.addSql(`
      create trigger wallet_ledger_entries_chain
        before insert on wallet_ledger_entries
        for each row execute function wallet_ledger_entries_chain()`);

    // At COMMIT: wallet balance and version equal the end of its ledger chain
    // (0.00 and version 1 when the wallet has no entry yet).
    this.addSql(`
      create function wallet_matches_ledger() returns trigger language plpgsql as $$
      declare
        target_wallet_id uuid;
        wallet record;
        last_entry record;
      begin
        if tg_table_name = 'wallets' then
          target_wallet_id := new.id;
        else
          target_wallet_id := new.wallet_id;
        end if;

        select balance_amount, version into wallet from wallets where id = target_wallet_id;

        select balance_after, wallet_version into last_entry
          from wallet_ledger_entries
         where wallet_id = target_wallet_id
         order by wallet_version desc
         limit 1;

        if not found then
          if wallet.balance_amount <> 0 or wallet.version <> 1 then
            raise exception 'wallet % has balance % at version % but no ledger entry',
              target_wallet_id, wallet.balance_amount, wallet.version
              using errcode = 'check_violation', constraint = 'wallets_balance_matches_ledger';
          end if;
        elsif wallet.balance_amount <> last_entry.balance_after or wallet.version <> last_entry.wallet_version then
          raise exception 'wallet % has balance % at version %, ledger ends at % version %',
            target_wallet_id, wallet.balance_amount, wallet.version, last_entry.balance_after, last_entry.wallet_version
            using errcode = 'check_violation', constraint = 'wallets_balance_matches_ledger';
        end if;
        return null;
      end
      $$`);
    this.addSql(`
      create constraint trigger wallets_balance_matches_ledger
        after insert or update on wallets
        deferrable initially deferred
        for each row execute function wallet_matches_ledger()`);
    this.addSql(`
      create constraint trigger wallet_ledger_entries_match_wallet
        after insert on wallet_ledger_entries
        deferrable initially deferred
        for each row execute function wallet_matches_ledger()`);
  }

  // Must undo everything up() created, in reverse order.
  override down(): void {
    this.addSql('drop trigger wallet_ledger_entries_match_wallet on wallet_ledger_entries');
    this.addSql('drop trigger wallets_balance_matches_ledger on wallets');
    this.addSql('drop function wallet_matches_ledger()');
    this.addSql('drop trigger wallet_ledger_entries_chain on wallet_ledger_entries');
    this.addSql('drop function wallet_ledger_entries_chain()');
    this.addSql('drop trigger wallet_ledger_entries_no_truncate on wallet_ledger_entries');
    this.addSql('drop trigger wallet_ledger_entries_append_only on wallet_ledger_entries');
    this.addSql('drop function wallet_ledger_entries_append_only()');
    this.addSql('drop table wallet_ledger_entries');
    this.addSql('alter table wager_transactions drop constraint wager_transactions_ledger_target_unique');
    this.addSql('alter table wallets drop constraint wallets_id_currency_unique');
  }
}
