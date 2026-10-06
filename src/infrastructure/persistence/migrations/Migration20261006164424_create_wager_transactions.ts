import { Migration } from '@mikro-orm/migrations';

/**
 * wager_transactions: every operation received from a provider, plus the internal
 * OPENING credit. It is also the persistent idempotency record (ADR-003): the
 * original outcome (status, failure_code, result balance) is stored for replay.
 *
 * OPENING rows have no game context: provider_id is the reserved 'internal', and
 * round_id, game_id and payload_hash are NULL only for them (CHECK
 * wager_transactions_opening_shape). Every other kind must have all three.
 */
export class Migration20261006164424_create_wager_transactions extends Migration {
  override name = 'Migration20261006164424_create_wager_transactions';

  override up(): void {
    this.addSql(`
      create table wager_transactions (
        id uuid not null,
        provider_id text not null,
        external_transaction_id text not null,
        idempotency_key text not null,
        payload_hash text,
        wallet_id uuid not null,
        player_id uuid not null,
        round_id text,
        game_id text,
        kind text not null,
        amount numeric(20, 2) not null,
        currency char(3) not null,
        reference_external_transaction_id text,
        reference_transaction_id uuid,
        status text not null,
        failure_code text,
        result_balance_amount numeric(20, 2),
        result_balance_currency char(3),
        reference_attempts integer not null default 0,
        next_reference_check_at timestamptz,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        processed_at timestamptz,

        constraint wager_transactions_pkey primary key (id),
        constraint wager_transactions_wallet_fk foreign key (wallet_id) references wallets (id),
        constraint wager_transactions_reference_fk
          foreign key (reference_transaction_id) references wager_transactions (id),

        -- idempotency (ADR-003): the same operation is stored once
        constraint wager_transactions_idempotency_key_unique unique (idempotency_key),
        constraint wager_transactions_provider_external_unique unique (provider_id, external_transaction_id),

        constraint wager_transactions_kind_valid
          check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint wager_transactions_status_valid
          check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint wager_transactions_currency_format check (currency ~ '^[A-Z]{3}$'),

        -- amounts: never negative; only LOSS may be zero
        constraint wager_transactions_amount_non_negative check (amount >= 0),
        constraint wager_transactions_amount_positive_when_moving check (kind = 'LOSS' or amount > 0),

        -- references (spec section 7 rules 1 and 3)
        constraint wager_transactions_reference_required
          check (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null),
        constraint wager_transactions_reference_not_allowed
          check (kind not in ('BET', 'OPENING') or reference_external_transaction_id is null),
        constraint wager_transactions_no_self_reference check (
          reference_transaction_id <> id and reference_external_transaction_id <> external_transaction_id),
        -- the single reversal index below ignores NULLs, so a PROCESSED reversal must name its reference
        constraint wager_transactions_processed_reversal_has_reference
          check (kind not in ('REFUND', 'ROLLBACK') or status <> 'PROCESSED' or reference_transaction_id is not null),

        -- outcome columns follow the status
        constraint wager_transactions_failure_code_iff_failed
          check ((status in ('REJECTED', 'FAILED')) = (failure_code is not null)),
        constraint wager_transactions_processed_at_iff_processed
          check ((status = 'PROCESSED') = (processed_at is not null)),
        constraint wager_transactions_result_balance_when_processed
          check (status <> 'PROCESSED' or result_balance_amount is not null),
        constraint wager_transactions_result_balance_pair
          check ((result_balance_amount is null) = (result_balance_currency is null)),
        constraint wager_transactions_result_balance_non_negative check (result_balance_amount >= 0),

        -- PENDING_REFERENCE worker (ADR-008): a waiting row is always scheduled
        constraint wager_transactions_reference_attempts_non_negative check (reference_attempts >= 0),
        constraint wager_transactions_pending_reference_scheduled
          check (status <> 'PENDING_REFERENCE' or next_reference_check_at is not null),

        -- OPENING: internal, born PROCESSED, no game context
        constraint wager_transactions_internal_provider_only_for_opening
          check ((kind = 'OPENING') = (provider_id = 'internal')),
        constraint wager_transactions_opening_shape check (
          (kind = 'OPENING') = (round_id is null)
          and (kind = 'OPENING') = (game_id is null)
          and (kind = 'OPENING') = (payload_hash is null)),
        constraint wager_transactions_opening_born_processed check (kind <> 'OPENING' or status = 'PROCESSED')
      )`);

    // ADR-008: a transaction is reverted at most once, by REFUND or ROLLBACK, whichever
    // comes first. Stricter than rule 4 (per kind), which would allow REFUND + ROLLBACK.
    this.addSql(`
      create unique index wager_transactions_single_reversal
        on wager_transactions (reference_transaction_id)
        where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK')`);

    // At most one OPENING per wallet.
    this.addSql(`
      create unique index wager_transactions_single_opening
        on wager_transactions (wallet_id)
        where kind = 'OPENING'`);

    // The PENDING_REFERENCE worker reads "waiting rows whose next check is due".
    this.addSql(`
      create index wager_transactions_due_pending_reference
        on wager_transactions (next_reference_check_at)
        where status = 'PENDING_REFERENCE'`);

    // Same state machine as ALLOWED_TRANSITIONS in the domain, plus: business fields
    // never change, terminal rows never change, rows are never deleted.
    this.addSql(`
      create function wager_transactions_guard() returns trigger language plpgsql as $$
      begin
        if tg_op = 'DELETE' then
          raise exception 'wager transaction % cannot be deleted', old.id
            using errcode = 'restrict_violation', constraint = 'wager_transactions_no_delete';
        end if;

        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') and new is distinct from old then
          raise exception 'wager transaction % is % and can no longer change', old.id, old.status
            using errcode = 'restrict_violation', constraint = 'wager_transactions_terminal_immutable';
        end if;

        if (new.id, new.provider_id, new.external_transaction_id, new.idempotency_key, new.payload_hash,
            new.wallet_id, new.player_id, new.round_id, new.game_id, new.kind, new.amount, new.currency,
            new.reference_external_transaction_id, new.created_at)
           is distinct from
           (old.id, old.provider_id, old.external_transaction_id, old.idempotency_key, old.payload_hash,
            old.wallet_id, old.player_id, old.round_id, old.game_id, old.kind, old.amount, old.currency,
            old.reference_external_transaction_id, old.created_at) then
          raise exception 'wager transaction % business fields cannot change', old.id
            using errcode = 'restrict_violation', constraint = 'wager_transactions_business_fields_immutable';
        end if;

        if old.status = 'PENDING_REFERENCE' and new.status = 'PENDING' then
          raise exception 'wager transaction % cannot go from PENDING_REFERENCE back to PENDING', old.id
            using errcode = 'check_violation', constraint = 'wager_transactions_valid_transition';
        end if;
        return new;
      end
      $$`);

    this.addSql(`
      create trigger wager_transactions_guard
        before update or delete on wager_transactions
        for each row execute function wager_transactions_guard()`);
  }

  // Must undo everything up() created, in reverse order.
  override down(): void {
    this.addSql('drop trigger wager_transactions_guard on wager_transactions');
    this.addSql('drop function wager_transactions_guard()');
    this.addSql('drop index wager_transactions_due_pending_reference');
    this.addSql('drop index wager_transactions_single_opening');
    this.addSql('drop index wager_transactions_single_reversal');
    this.addSql('drop table wager_transactions');
  }
}
