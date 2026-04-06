import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

@Injectable()
export class SiteDomainGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
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

    const request = context.switchToHttp().getRequest<Request>();
    const originHeader = request.headers.origin ?? request.headers.referer;
    if (typeof originHeader !== 'string' || originHeader.length === 0) {
      throw new ForbiddenException('Origin header is required');
    }

    const requestHost = this.normalizeHost(originHeader);
    if (!allowedHosts.has(requestHost)) {
      throw new ForbiddenException('Origin domain is not allowed');
    }

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
}
