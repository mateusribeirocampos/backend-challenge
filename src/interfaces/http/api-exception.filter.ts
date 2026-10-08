import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus, Inject } from '@nestjs/common';
import { summarizeError } from '../../application/error-summary.js';
import {
  type ApplicationError,
  ExternalTransactionIdConflictError,
  IdempotencyKeyConflictError,
  TransientInfrastructureError,
  WagerTransactionNotFoundError,
  CurrencyNotSupportedError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../application/errors.js';
import { type LogFields, STRUCTURED_LOGGER, type StructuredLogger } from '../../application/ports/structured-logger.js';
import { InvalidMoneyError } from '../../domain/money/money.js';
import { ContractViolationCode } from '../../domain/wager/failure-code.js';
import { InvalidWagerTransactionError } from '../../domain/wager/wager-transaction.js';
import { InvalidWalletError } from '../../domain/wallet/wallet.js';
import { correlationIdOf } from './correlation-id.middleware.js';
import type { HttpRequest, HttpResponse } from './http-types.js';
import { RequestValidationError, type ValidationDetail } from './request-validation.js';

/** The single error body of every endpoint. */
export interface ErrorEnvelope {
  readonly errorCode: string;
  readonly message: string;
  readonly details?: readonly ValidationDetail[];
  readonly correlationId: string;
}

/** Seconds the provider should wait before resending after a 503. */
const RETRY_AFTER_SECONDS = '1';

interface MappedError {
  readonly status: number;
  readonly errorCode: string;
  readonly message: string;
  readonly details?: readonly ValidationDetail[];
}

/**
 * Turns every exception into { errorCode, message, details?, correlationId }.
 * Like a @RestControllerAdvice with @ExceptionHandler methods in Spring: controllers
 * and use cases just throw, and this is the only place that knows status codes for errors.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(@Inject(STRUCTURED_LOGGER) private readonly logger: StructuredLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<HttpRequest>();
    const response = http.getResponse<HttpResponse>();
    const correlationId = correlationIdOf(request);

    const mapped = this.map(exception);
    if (mapped.status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      // Never the message or the stack: a driver error carries the SQL and its parameters (spec 12).
      this.logger.error('http.request_failed', {
        correlationId,
        method: request.method,
        path: request.url.split('?')[0],
        status: mapped.status,
        ...identifiersOf(request),
        ...summarizeError(exception),
      });
    }
    if (mapped.status === HttpStatus.SERVICE_UNAVAILABLE) {
      response.setHeader('Retry-After', RETRY_AFTER_SECONDS);
    }
    response.setHeader('X-Correlation-Id', correlationId);

    const body: ErrorEnvelope = {
      errorCode: mapped.errorCode,
      message: mapped.message,
      ...(mapped.details === undefined ? {} : { details: mapped.details }),
      correlationId,
    };
    response.status(mapped.status).json(body);
  }

  private map(exception: unknown): MappedError {
    // 400: the payload must be fixed. Nothing was stored.
    if (exception instanceof RequestValidationError) {
      return invalid(exception.details);
    }
    if (exception instanceof InvalidWagerTransactionError) {
      return invalid([{ code: exception.code, message: exception.message }]);
    }
    if (exception instanceof InvalidMoneyError) {
      return invalid([{ code: ContractViolationCode.InvalidMoney, message: exception.message }]);
    }
    if (exception instanceof InvalidWalletError) {
      return invalid([{ code: ContractViolationCode.InvalidFormat, message: exception.message }]);
    }

    // 422: a business rule refused the request and nothing was stored (here: a currency the platform does not operate).
    if (exception instanceof CurrencyNotSupportedError) {
      return fromApplicationError(HttpStatus.UNPROCESSABLE_ENTITY, exception);
    }

    // 409: the key or the resource is already taken; resending the same thing will not help.
    if (
      exception instanceof IdempotencyKeyConflictError ||
      exception instanceof ExternalTransactionIdConflictError ||
      exception instanceof WalletAlreadyExistsError
    ) {
      return fromApplicationError(HttpStatus.CONFLICT, exception);
    }

    // 404
    if (exception instanceof WalletNotFoundError || exception instanceof WagerTransactionNotFoundError) {
      return fromApplicationError(HttpStatus.NOT_FOUND, exception);
    }

    // 503 + Retry-After: resend with the same Idempotency-Key.
    if (exception instanceof TransientInfrastructureError) {
      return fromApplicationError(HttpStatus.SERVICE_UNAVAILABLE, exception);
    }

    // Errors raised by Nest or Express themselves: unknown route, body that is not JSON...
    if (exception instanceof HttpException) {
      return fromHttpStatus(exception.getStatus(), exception.message);
    }
    // ...and errors from Express middleware in the http-errors style, which carry a 4xx
    // status but are not HttpException (the body parser's "request entity too large").
    const clientStatus = clientErrorStatusOf(exception);
    if (clientStatus !== undefined) {
      return fromHttpStatus(clientStatus, exception instanceof Error ? exception.message : 'Bad request');
    }

    return { status: HttpStatus.INTERNAL_SERVER_ERROR, errorCode: 'INTERNAL_ERROR', message: 'Internal error' };
  }
}

function invalid(details: readonly ValidationDetail[]): MappedError {
  return { status: HttpStatus.BAD_REQUEST, errorCode: 'VALIDATION_ERROR', message: 'The request is invalid', details };
}

function fromApplicationError(status: number, error: ApplicationError): MappedError {
  return { status, errorCode: error.code, message: error.message };
}

const ERROR_CODE_BY_STATUS: Readonly<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: 'VALIDATION_ERROR',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'PAYLOAD_TOO_LARGE',
};

function fromHttpStatus(status: number, message: string): MappedError {
  const errorCode = ERROR_CODE_BY_STATUS[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'HTTP_ERROR');
  if (status === HttpStatus.BAD_REQUEST) {
    // In practice, a body that is not valid JSON (rejected by the body parser).
    return invalid([{ code: ContractViolationCode.InvalidFormat, message }]);
  }
  return { status, errorCode, message };
}

/** A numeric 4xx `status` or `statusCode` on the error, as the http-errors package sets it. */
function clientErrorStatusOf(exception: unknown): number | undefined {
  if (typeof exception !== 'object' || exception === null) {
    return undefined;
  }
  const { status, statusCode } = exception as { status?: unknown; statusCode?: unknown };
  const candidate = typeof status === 'number' ? status : statusCode;
  return typeof candidate === 'number' && candidate >= 400 && candidate < 500 ? candidate : undefined;
}

const LOGGED_IDENTIFIERS = ['walletId', 'providerId', 'transactionId'] as const;
const SAFE_IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/;

/** walletId, providerId and transactionId from the body or the route, when they look like identifiers. */
function identifiersOf(request: HttpRequest): LogFields {
  const body = typeof request.body === 'object' && request.body !== null ? (request.body as Record<string, unknown>) : {};
  const sources: Record<string, unknown> = { ...body, ...request.params };
  const fields: Record<string, string> = {};
  for (const name of LOGGED_IDENTIFIERS) {
    const value = sources[name];
    if (typeof value === 'string' && SAFE_IDENTIFIER.test(value)) {
      fields[name] = value;
    }
  }
  return fields;
}
