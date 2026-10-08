import { Migration } from '@mikro-orm/migrations';

/**
 * What the outbox publisher needs from outbox_messages:
 *
 *   - sequence_number: the order the events were written. Events of one wallet are
 *     written under the wallet lock, so for one wallet this is the commit order, even
 *     when two app instances have clocks a few milliseconds apart (occurred_at comes
 *     from the app clock and could tie or go backwards).
 *   - lease_token: which claim owns the lease (locked_until says until when). A
 *     publisher only releases or reschedules rows that still carry its own token.
 *
 * And the guarantees of a confirmed event (spec 3: "não perder eventos confirmados"):
 * the event content never changes, a published row never changes again, and a row
 * that was not published yet cannot be deleted.
 */
export class Migration20261007120000_outbox_publication extends Migration {
  override name = 'Migration20261007120000_outbox_publication';

  override up(): void {
    this.addSql('alter table outbox_messages add column sequence_number bigint generated always as identity');
    this.addSql('alter table outbox_messages add column lease_token uuid');
    this.addSql(`
      alter table outbox_messages add constraint outbox_messages_lease_pair
        check ((lease_token is null) = (locked_until is null))`);

    // "Is there an older unpublished event of this wallet?" and "oldest unpublished events".
    this.addSql(`
      create index outbox_messages_pending_by_aggregate
        on outbox_messages (aggregate_id, sequence_number)
        where published_at is null`);
    this.addSql(`
      create index outbox_messages_pending_in_order
        on outbox_messages (sequence_number)
        where published_at is null`);

    this.addSql(`
      create function outbox_messages_guard() returns trigger language plpgsql as $$
      begin
        if tg_op = 'DELETE' then
          if old.published_at is null then
            raise exception 'outbox message % was not published yet and cannot be deleted', old.id
              using errcode = 'restrict_violation', constraint = 'outbox_messages_no_delete_unpublished';
          end if;
          return old;
        end if;

        if old.published_at is not null and new is distinct from old then
          raise exception 'outbox message % is already published and can no longer change', old.id
            using errcode = 'restrict_violation', constraint = 'outbox_messages_published_immutable';
        end if;

        if (new.id, new.aggregate_id, new.event_type, new.payload, new.occurred_at, new.sequence_number)
           is distinct from
           (old.id, old.aggregate_id, old.event_type, old.payload, old.occurred_at, old.sequence_number) then
          raise exception 'outbox message % event fields cannot change', old.id
            using errcode = 'restrict_violation', constraint = 'outbox_messages_event_immutable';
        end if;
        return new;
      end
      $$`);
    this.addSql(`
      create trigger outbox_messages_guard
        before update or delete on outbox_messages
        for each row execute function outbox_messages_guard()`);
  }

  // Must undo everything up() created, in reverse order.
  override down(): void {
    this.addSql('drop trigger outbox_messages_guard on outbox_messages');
    this.addSql('drop function outbox_messages_guard()');
    this.addSql('drop index outbox_messages_pending_in_order');
    this.addSql('drop index outbox_messages_pending_by_aggregate');
    this.addSql('alter table outbox_messages drop constraint outbox_messages_lease_pair');
    this.addSql('alter table outbox_messages drop column lease_token');
    this.addSql('alter table outbox_messages drop column sequence_number');
  }
}
