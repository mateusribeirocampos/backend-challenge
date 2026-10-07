import { Migration } from '@mikro-orm/migrations';

/**
 * numeric accepts 'NaN', and PostgreSQL treats NaN as greater than every number and
 * equal to itself. So "balance_amount >= 0" and the ledger arithmetic check
 * (100 + NaN = NaN) both let it through, and a wallet could hold a balance that
 * Money.from refuses to rebuild. Every monetary column refuses NaN explicitly.
 * A NULL result_balance_amount still passes: NULL <> 'NaN' is unknown, not false.
 */
const NOT_NAN_CHECKS = [
  { table: 'wallets', constraint: 'wallets_balance_not_nan', column: 'balance_amount' },
  { table: 'wager_transactions', constraint: 'wager_transactions_amount_not_nan', column: 'amount' },
  { table: 'wager_transactions', constraint: 'wager_transactions_result_balance_not_nan', column: 'result_balance_amount' },
  { table: 'wallet_ledger_entries', constraint: 'wallet_ledger_entries_amount_not_nan', column: 'amount' },
  { table: 'wallet_ledger_entries', constraint: 'wallet_ledger_entries_balance_before_not_nan', column: 'balance_before' },
  { table: 'wallet_ledger_entries', constraint: 'wallet_ledger_entries_balance_after_not_nan', column: 'balance_after' },
] as const;

export class Migration20261007211824_monetary_not_nan extends Migration {
  override name = 'Migration20261007211824_monetary_not_nan';

  override up(): void {
    for (const { table, constraint, column } of NOT_NAN_CHECKS) {
      this.addSql(`alter table ${table} add constraint ${constraint} check (${column} <> 'NaN'::numeric)`);
    }
  }

  override down(): void {
    for (const { table, constraint } of [...NOT_NAN_CHECKS].reverse()) {
      this.addSql(`alter table ${table} drop constraint ${constraint}`);
    }
  }
}
