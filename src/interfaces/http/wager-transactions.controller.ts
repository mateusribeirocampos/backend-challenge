import { Body, Controller, Get, Headers, Inject, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { GetWagerTransaction } from '../../application/wagering/get-wager-transaction.js';
import { ProcessWagerTransaction } from '../../application/wagering/process-wager-transaction.js';
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
    const result = await this.processWagerTransaction.execute(command);
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
}
