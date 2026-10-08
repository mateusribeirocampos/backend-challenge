import { Module } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { CLOCK, type Clock } from './application/ports/clock.js';
import { ID_GENERATOR, type IdGenerator } from './application/ports/id-generator.js';
import { METRICS, type Metrics } from './application/ports/metrics.js';
import { PROVIDER_IDENTITY } from './application/ports/provider-identity.js';
import { STRUCTURED_LOGGER, type StructuredLogger } from './application/ports/structured-logger.js';
import { TRANSACTION_RUNNER, type TransactionRunner } from './application/ports/transaction-runner.js';
import { GetWagerTransaction } from './application/wagering/get-wager-transaction.js';
import { ProcessWagerTransaction } from './application/wagering/process-wager-transaction.js';
import { GetWallet } from './application/wallets/get-wallet.js';
import { GetWalletLedger } from './application/wallets/get-wallet-ledger.js';
import { OpenWallet } from './application/wallets/open-wallet.js';
import { ReconcileWallet } from './application/wallets/reconcile-wallet.js';
import { NoopProviderIdentity } from './infrastructure/auth/noop-provider-identity.js';
import { MikroOrmTransactionRunner } from './infrastructure/persistence/mikro-orm-transaction-runner.js';
import { SystemClock } from './infrastructure/system/system-clock.js';
import { UuidV7IdGenerator } from './infrastructure/system/uuid-v7-id-generator.js';
import { ProviderAuthGuard } from './interfaces/http/provider-auth.guard.js';
import { WagerTransactionsController } from './interfaces/http/wager-transactions.controller.js';
import { WalletsController } from './interfaces/http/wallets.controller.js';
import { APP_CONFIG, type AppConfig } from './infrastructure/config/app-config.js';

/**
 * Composition root of the wallet and wagering features. The use cases are plain
 * classes (no Nest decorator in src/application): this module is the only place that
 * says which adapter implements which port, like a Spring @Configuration with @Bean methods.
 */
@Module({
  controllers: [WalletsController, WagerTransactionsController],
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidV7IdGenerator },
    { provide: PROVIDER_IDENTITY, useClass: NoopProviderIdentity },
    {
      provide: TRANSACTION_RUNNER,
      useFactory: (orm: MikroORM, metrics: Metrics): TransactionRunner => new MikroOrmTransactionRunner(orm, metrics),
      inject: [MikroORM, METRICS],
    },
    {
      provide: OpenWallet,
      useFactory: (runner: TransactionRunner, clock: Clock, ids: IdGenerator, config: AppConfig) =>
        new OpenWallet(runner, clock, ids, config.wallets.supportedCurrencies),
      inject: [TRANSACTION_RUNNER, CLOCK, ID_GENERATOR, APP_CONFIG],
    },
    {
      provide: GetWallet,
      useFactory: (runner: TransactionRunner) => new GetWallet(runner),
      inject: [TRANSACTION_RUNNER],
    },
    {
      provide: GetWalletLedger,
      useFactory: (runner: TransactionRunner) => new GetWalletLedger(runner),
      inject: [TRANSACTION_RUNNER],
    },
    {
      provide: ReconcileWallet,
      useFactory: (runner: TransactionRunner, metrics: Metrics, logger: StructuredLogger) =>
        new ReconcileWallet(runner, metrics, logger),
      inject: [TRANSACTION_RUNNER, METRICS, STRUCTURED_LOGGER],
    },
    {
      provide: ProcessWagerTransaction,
      useFactory: (runner: TransactionRunner, clock: Clock, ids: IdGenerator) =>
        new ProcessWagerTransaction(runner, clock, ids),
      inject: [TRANSACTION_RUNNER, CLOCK, ID_GENERATOR],
    },
    {
      provide: GetWagerTransaction,
      useFactory: (runner: TransactionRunner) => new GetWagerTransaction(runner),
      inject: [TRANSACTION_RUNNER],
    },
    ProviderAuthGuard,
  ],
  // The SQS consumer runs the same use case as POST /wagering/transactions; the
  // background workers use the same clock and id generator (their transaction runner
  // is their own, on a separate pool: see BackgroundWorkersModule).
  exports: [ProcessWagerTransaction, CLOCK, ID_GENERATOR],
})
export class WageringModule {}
