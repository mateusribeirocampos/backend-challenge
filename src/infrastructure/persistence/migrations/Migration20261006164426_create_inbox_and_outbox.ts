import { Migration } from '@mikro-orm/migrations';

/**
 * Tables of the inbox and the outbox. Created now so the schema is complete; the classes that use
 * them come with the SQS consumer and the outbox publisher.
 *
 * inbox_messages: one row per (consumer, message) already handled. The primary key is
 *   the deduplication: a redelivered SQS message hits it and is not processed again.
 * outbox_messages: integration events written in the same SQL transaction as the
 *   financial change, published later by a worker. id is the event id.
 */
export class Migration20261006164426_create_inbox_and_outbox extends Migration {
  override name = 'Migration20261006164426_create_inbox_and_outbox';

  override up(): void {
    this.addSql(`
      create table inbox_messages (
        consumer_name text not null,
        message_id text not null,
        payload_hash text not null,
        received_at timestamptz not null,
        processed_at timestamptz,
        constraint inbox_messages_pkey primary key (consumer_name, message_id)
      )`);

    this.addSql(`
      create table outbox_messages (
        id uuid not null,
        aggregate_id uuid not null,
        event_type text not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0,
        next_attempt_at timestamptz not null,
        locked_until timestamptz,
        published_at timestamptz,
        constraint outbox_messages_pkey primary key (id),
        constraint outbox_messages_attempts_non_negative check (attempts >= 0)
      )`);

    // The publisher reads "not published yet and due now", oldest first.
    this.addSql(`
      create index outbox_messages_due
        on outbox_messages (next_attempt_at)
        where published_at is null`);
  }

  // Must undo everything up() created, in reverse order.
  override down(): void {
    this.addSql('drop index outbox_messages_due');
    this.addSql('drop table outbox_messages');
    this.addSql('drop table inbox_messages');
  }
}
