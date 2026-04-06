import { Injectable } from '@nestjs/common';
import {
  Counter,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

@Injectable()
export class MetricsService {
  private readonly registry = new Registry();
  private readonly requestCounter: Counter<string>;
  private readonly requestDurationHistogram: Histogram<string>;

  constructor() {
    collectDefaultMetrics({
      register: this.registry,
      prefix: 'eeetik_',
    });

    this.requestCounter = new Counter({
      name: 'eeetik_http_requests_total',
      help: 'Total HTTP requests',
      labelNames: ['method', 'route', 'status_code'],
      registers: [this.registry],
    });

    this.requestDurationHistogram = new Histogram({
      name: 'eeetik_http_request_duration_ms',
      help: 'HTTP request duration in milliseconds',
      labelNames: ['method', 'route', 'status_code'],
      buckets: [5, 20, 50, 100, 200, 500, 1000, 3000, 5000],
      registers: [this.registry],
    });
  }

  recordHttpRequest(
    method: string,
    route: string,
    statusCode: number,
    durationMs: number,
  ): void {
    const labels = {
      method,
      route,
      status_code: statusCode.toString(),
    };
    this.requestCounter.inc(labels);
    this.requestDurationHistogram.observe(labels, durationMs);
  }

  getContentType(): string {
    return this.registry.contentType;
  }

  getMetrics(): Promise<string> {
    return this.registry.metrics();
  }
}
