import { Controller, Get, Header, Inject } from '@nestjs/common';
import { METRICS } from '../../application/ports/metrics.js';
import type { InMemoryMetrics } from './in-memory-metrics.js';
import { renderPrometheusText } from './prometheus-text.js';

/**
 * GET /metrics for Prometheus to scrape. Open, like the health checks: it carries
 * counts, statuses and durations, never an amount or an identifier. It lives next to
 * the adapter because it reads the adapter's state (InMemoryMetrics), not a port.
 */
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(METRICS) private readonly metrics: InMemoryMetrics) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  render(): string {
    return renderPrometheusText(this.metrics.snapshot());
  }
}
