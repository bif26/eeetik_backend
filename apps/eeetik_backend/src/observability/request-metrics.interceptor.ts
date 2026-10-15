import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { getStructuredLogger } from '@shared';
import { randomUUID } from 'node:crypto';
import { Request, Response } from 'express';
import { Observable, finalize } from 'rxjs';
import { MetricsService } from './metrics.service';

type RequestWithId = Request & {
  requestId?: string;
};

@Injectable()
export class RequestMetricsInterceptor implements NestInterceptor {
  private readonly logger = getStructuredLogger('api');

  constructor(private readonly metricsService: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<RequestWithId>();
    const response = http.getResponse<Response>();
    const start = process.hrtime.bigint();
    const requestId = this.resolveRequestId(request.headers['x-request-id']);
    request.requestId = requestId;
    response.setHeader('x-request-id', requestId);

    return next.handle().pipe(
      finalize(() => {
        const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
        const route = this.resolveRoute(request);

        this.metricsService.recordHttpRequest(
          request.method,
          route,
          response.statusCode,
          durationMs,
        );

        this.logger.info('http.request.completed', {
          requestId,
          route,
          method: request.method,
          statusCode: response.statusCode,
          durationMs: Number(durationMs.toFixed(2)),
        });
      }),
    );
  }

  private resolveRoute(request: RequestWithId): string {
    const routePath = this.resolveRoutePath(request.route);
    if (routePath) {
      return `${request.baseUrl}${routePath}`;
    }

    return request.originalUrl || request.url;
  }

  private resolveRoutePath(route: unknown): string | undefined {
    if (!route || typeof route !== 'object') {
      return undefined;
    }

    const routeCandidate = route as { path?: unknown };
    return typeof routeCandidate.path === 'string'
      ? routeCandidate.path
      : undefined;
  }

  private resolveRequestId(headerValue: string | string[] | undefined): string {
    if (typeof headerValue === 'string' && headerValue.trim().length > 0) {
      return headerValue.trim();
    }

    if (Array.isArray(headerValue)) {
      const first = headerValue.find((value) => value.trim().length > 0);
      if (first) {
        return first.trim();
      }
    }

    return randomUUID();
  }
}
