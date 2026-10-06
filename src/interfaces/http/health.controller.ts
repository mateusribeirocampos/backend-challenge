import { Controller, Get, HttpCode, HttpStatus, Inject, Logger, Res } from '@nestjs/common';
import {
  checkReadiness,
  DEPENDENCY_CHECKS,
  type DependencyCheck,
  type DependencyStatus,
} from '../../application/health/check-readiness.js';
import type { HttpResponse } from './http-types.js';

const READINESS_TIMEOUT_MS = 2_000;

interface HealthResponse {
  status: 'ok' | 'unavailable';
  checks?: Readonly<Record<string, DependencyStatus>>;
  failed?: readonly string[];
}

/** Open endpoints (no auth), as required by the spec. */
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(@Inject(DEPENDENCY_CHECKS) private readonly dependencies: readonly DependencyCheck[]) {}

  /** Liveness: the process answers HTTP. Never touches a dependency. */
  @Get('live')
  @HttpCode(HttpStatus.OK)
  live(): HealthResponse {
    return { status: 'ok' };
  }

  /** Readiness: PostgreSQL and SQS answer. 503 names the dependency that failed. */
  @Get('ready')
  async ready(@Res({ passthrough: true }) response: HttpResponse): Promise<HealthResponse> {
    const report = await checkReadiness(this.dependencies, READINESS_TIMEOUT_MS);
    if (report.ready) {
      return { status: 'ok', checks: report.checks };
    }

    // The reason goes to the log only: health endpoints are public, error text may expose internals.
    for (const failure of report.failed) {
      this.logger.warn(`readiness check failed: ${failure.name}: ${failure.reason}`);
    }
    // A 503 here is a health report, not an API error: it is returned as is, outside
    // the error envelope, so probes and humans read the same body.
    response.status(HttpStatus.SERVICE_UNAVAILABLE);
    return {
      status: 'unavailable',
      checks: report.checks,
      failed: report.failed.map((failure) => failure.name),
    };
  }
}
