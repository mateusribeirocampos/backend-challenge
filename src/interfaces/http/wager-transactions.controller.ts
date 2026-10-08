import { Body, Controller, Get, Headers, Inject, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { LockContentionError } from '../../application/errors.js';
import { METRICS, MetricName, type Metrics } from '../../application/ports/metrics.js';
import { STRUCTURED_LOGGER, type StructuredLogger } from '../../application/ports/structured-logger.js';
import { GetWagerTransaction } from '../../application/wagering/get-wager-transaction.js';
import {
  ProcessWagerTransaction,
  type ProcessWagerTransactionCommand,
} from '../../application/wagering/process-wager-transaction.js';
import type { WagerResultView, WagerTransactionView } from '../../application/wagering/wager-transaction-views.js';
import { correlationIdOf } from './correlation-id.middleware.js';
import type { HttpRequest, HttpResponse } from './http-types.js';
import { ProviderAuthGuard } from './provider-auth.guard.js';
import { parseOrThrow, requiredText, uuidField } from './request-validation.js';
import { httpStatusFor } from './wager-response-status.js';
import { IDEMPOTENCY_KEY_HEADER, toProcessCommand } from './wager-transaction.request.js';

@Controller()
@UseGuards(ProviderAuthGuard)
export class WagerTransactionsController {
  constructor(
    @Inject(ProcessWagerTransaction) private readonly processWagerTransaction: ProcessWagerTransaction,
    @Inject(GetWagerTransaction) private readonly getWagerTransaction: GetWagerTransaction,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(STRUCTURED_LOGGER) private readonly logger: StructuredLogger,
  ) {}

  /**
   * 201 processed, 200 replay, 202 pending reference, 422 rejected (see httpStatusFor).
   * 400, 404, 409 and 503 come from exceptions (ApiExceptionFilter).
   */
  @Post('wagering/transactions')
  async submit(
    @Body() body: unknown,
    @Headers(IDEMPOTENCY_KEY_HEADER.toLowerCase()) idempotencyKey: string | undefined,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<WagerResultView> {
    const command = toProcessCommand(body, idempotencyKey, correlationIdOf(request));
    const result = await this.timed(() => this.processWagerTransaction.execute(command));
    this.record(command, result);
    response.status(httpStatusFor(result));
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  async findById(@Param('transactionId') transactionId: string): Promise<WagerTransactionView> {
    return this.getWagerTransaction.byId(parseOrThrow(uuidField, transactionId, 'transactionId'));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async findByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    return this.getWagerTransaction.byExternalId(
      parseOrThrow(requiredText(64), providerId, 'providerId'),
      parseOrThrow(requiredText(), externalTransactionId, 'externalTransactionId'),
    );
  }

  /** Latency of the use case (spec 12), errors included: a 503 after a 2 s lock wait is latency too. */
  private async timed(work: () => Promise<WagerResultView>): Promise<WagerResultView> {
    const startedAt = performance.now();
    try {
      return await work();
    } catch (error) {
      if (error instanceof LockContentionError) {
        this.metrics.increment(MetricName.LockConflicts, { source: 'http' });
      }
      throw error;
    } finally {
      this.metrics.observe(MetricName.ProcessingDuration, (performance.now() - startedAt) / 1000, { source: 'http' });
    }
  }

  /** The same counters and log fields as the SQS handler: identifiers and status, never the amount. */
  private record(command: ProcessWagerTransactionCommand, result: WagerResultView): void {
    const fields = {
      correlationId: command.correlationId,
      transactionId: result.transactionId,
      walletId: command.walletId,
      providerId: command.providerId,
      status: result.status,
      failureCode: result.failureCode,
    };
    if (result.idempotentReplay) {
      this.metrics.increment(MetricName.DuplicatesDetected, { layer: 'idempotency_key', source: 'http' });
      this.logger.info('wager_http.duplicate', { ...fields, layer: 'idempotency_key' });
      return;
    }
    this.metrics.increment(MetricName.HttpTransactions, { status: result.status });
    this.logger.info('wager_http.processed', fields);
  }
}
