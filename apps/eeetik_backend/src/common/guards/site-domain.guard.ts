import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { RedisCacheService } from '../../download/services/redis-cache.service';

const DEFAULT_DOMAIN_RATE_TTL_MS = 60_000;
const DEFAULT_DOMAIN_RATE_LIMIT = 120;
const DEFAULT_UNIQUE_RATE_TTL_MS = 60_000;
const DEFAULT_UNIQUE_RATE_LIMIT = 20;

@Injectable()
export class SiteDomainGuard implements CanActivate {
  private readonly logger = new Logger(SiteDomainGuard.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly redisCacheService: RedisCacheService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    await this.assertUniqueIdRateLimit(request);

    const allowlist = this.configService.get<string>(
      'SITE_DOMAIN_ALLOWLIST',
      '',
    );
    if (!allowlist.trim()) {
      return true;
    }

    const allowedHosts = new Set(
      allowlist
        .split(',')
        .map((host) => this.normalizeHost(host))
        .filter(Boolean),
    );

    const originHeader = request.headers.origin ?? request.headers.referer;
    if (typeof originHeader !== 'string' || originHeader.length === 0) {
      this.logger.warn(
        `Missing origin header for ${request.method} ${request.url}`,
      );
      throw new ForbiddenException('Origin header is required');
    }

    const requestHost = this.normalizeHost(originHeader);
    if (!allowedHosts.has(requestHost)) {
      this.logger.warn(
        `Blocked origin ${requestHost} for ${request.method} ${request.url}`,
      );
      throw new ForbiddenException('Origin domain is not allowed');
    }
    await this.assertDomainRateLimit(requestHost, request);

    return true;
  }

  private normalizeHost(hostOrUrl: string): string {
    const trimmed = hostOrUrl.trim();
    if (!trimmed) {
      return '';
    }

    const withProtocol = trimmed.includes('://')
      ? trimmed
      : `https://${trimmed}`;

    try {
      return new URL(withProtocol).hostname.toLowerCase();
    } catch {
      throw new ForbiddenException('Invalid origin domain');
    }
  }

  private async assertDomainRateLimit(
    domain: string,
    request: Request,
  ): Promise<void> {
    const ttlMs = this.readPositiveIntegerConfig(
      'THROTTLE_DOMAIN_TTL_MS',
      DEFAULT_DOMAIN_RATE_TTL_MS,
    );
    const limit = this.readPositiveIntegerConfig(
      'THROTTLE_DOMAIN_LIMIT',
      DEFAULT_DOMAIN_RATE_LIMIT,
    );
    const count = await this.redisCacheService.incrementWithTtl(
      `throttle:domain:${domain}`,
      ttlMs,
    );
    if (count <= limit) {
      return;
    }

    this.logger.warn(
      `Domain rate limit exceeded for ${domain} on ${request.method} ${request.url}`,
    );
    throw new HttpException(
      'Domain rate limit exceeded',
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private async assertUniqueIdRateLimit(request: Request): Promise<void> {
    const uniqueId = this.extractUniqueId(request);
    if (!uniqueId) {
      return;
    }

    const ttlMs = this.readPositiveIntegerConfig(
      'THROTTLE_UNIQUE_TTL_MS',
      DEFAULT_UNIQUE_RATE_TTL_MS,
    );
    const limit = this.readPositiveIntegerConfig(
      'THROTTLE_UNIQUE_LIMIT',
      DEFAULT_UNIQUE_RATE_LIMIT,
    );
    const count = await this.redisCacheService.incrementWithTtl(
      `throttle:unique:${uniqueId}`,
      ttlMs,
    );
    if (count <= limit) {
      return;
    }

    this.logger.warn(
      `UniqueId rate limit exceeded for ${uniqueId} on ${request.method} ${request.url}`,
    );
    throw new HttpException(
      'UniqueId rate limit exceeded',
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private extractUniqueId(request: Request): string | undefined {
    if (request.method !== 'POST') {
      return undefined;
    }

    const normalizedPath = (
      request.path ||
      request.originalUrl ||
      ''
    ).toLowerCase();
    if (!normalizedPath.includes('/prepare')) {
      return undefined;
    }

    const body = request.body as Record<string, unknown> | undefined;
    const uniqueId =
      typeof body?.uniqueId === 'string' ? body.uniqueId.trim() : '';
    return uniqueId || undefined;
  }

  private readPositiveIntegerConfig(
    envKey: string,
    fallbackValue: number,
  ): number {
    const value = this.configService.get<string>(envKey);
    if (value === undefined || value.trim().length === 0) {
      return fallbackValue;
    }

    const parsedValue = Number(value);
    if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
      return fallbackValue;
    }

    return Math.floor(parsedValue);
  }
}
