import { randomUUID } from 'node:crypto';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import { headerValue, type HttpRequest, type HttpResponse } from './http-types.js';

export const CORRELATION_ID_HEADER = 'X-Correlation-Id';

/** Accepted as sent; anything else (too long, odd characters) is replaced by a new id. */
const ACCEPTED_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Every request gets a correlation id: the caller's X-Correlation-Id when it is sane,
 * a new UUID otherwise. It goes back in the response header, in every error body and
 * into the events written to the outbox, so one request can be followed end to end.
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(request: HttpRequest, response: HttpResponse, next: () => void): void {
    const correlationId = correlationIdOf(request);
    response.setHeader(CORRELATION_ID_HEADER, correlationId);
    next();
  }
}

/** Also used by the exception filter, which can run before the middleware (e.g. invalid JSON). */
export function correlationIdOf(request: HttpRequest): string {
  if (request.correlationId === undefined) {
    const sent = headerValue(request, CORRELATION_ID_HEADER);
    request.correlationId = sent !== undefined && ACCEPTED_CORRELATION_ID.test(sent) ? sent : randomUUID();
  }
  return request.correlationId;
}
