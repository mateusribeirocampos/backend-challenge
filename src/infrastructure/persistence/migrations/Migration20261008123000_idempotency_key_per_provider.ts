import { Migration } from '@mikro-orm/migrations';

/**
 * The Idempotency-Key is unique per provider, not across the whole table. Provider A
 * and provider B can both send "tx-1" without one blocking (or replaying) the other,
 * and no key format is imposed on them: "{providerId}:{externalTransactionId}" is only
 * the recommended default. The insert-first statement uses ON CONFLICT DO NOTHING
 * without a target, so it follows the new constraint unchanged.
 *
 * down() restores the global constraint; it fails if two providers already share a key,
 * which is the data this migration allows.
 */
export class Migration20261008123000_idempotency_key_per_provider extends Migration {
  override name = 'Migration20261008123000_idempotency_key_per_provider';

  override up(): void {
    this.addSql('alter table wager_transactions drop constraint wager_transactions_idempotency_key_unique');
    this.addSql(
      `alter table wager_transactions
         add constraint wager_transactions_provider_idempotency_key_unique unique (provider_id, idempotency_key)`,
    );
  }

  override down(): void {
    this.addSql('alter table wager_transactions drop constraint wager_transactions_provider_idempotency_key_unique');
    this.addSql('alter table wager_transactions add constraint wager_transactions_idempotency_key_unique unique (idempotency_key)');
  }
}
