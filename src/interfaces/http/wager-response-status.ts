import { HttpStatus } from '@nestjs/common';
import type { WagerResultView } from '../../application/wagering/wager-transaction-views.js';
import { WagerTransactionStatus } from '../../domain/wager/wager-transaction-status.js';

/**
 * ADR-007: the status code alone tells the provider what to do.
 *   201 processed now | 200 replay of a processed one     -> done, nothing to resend
 *   202 waiting for the referenced transaction            -> do not resend, query later
 *   422 rejected by a business rule (also on replay)      -> do not resend unchanged
 * Errors (400, 404, 409, 503) never reach this function: they are exceptions mapped
 * by ApiExceptionFilter.
 */
export function httpStatusFor(result: WagerResultView): number {
  switch (result.status) {
    case WagerTransactionStatus.Processed:
      return result.idempotentReplay ? HttpStatus.OK : HttpStatus.CREATED;
    case WagerTransactionStatus.PendingReference:
    case WagerTransactionStatus.Pending:
      return HttpStatus.ACCEPTED;
    case WagerTransactionStatus.Rejected:
    // FAILED (permanent infrastructure error, written from Slice 3 on) is terminal like
    // REJECTED: the same key always gets the same answer, so it must not invite a retry.
    case WagerTransactionStatus.Failed:
      return HttpStatus.UNPROCESSABLE_ENTITY;
  }
}
