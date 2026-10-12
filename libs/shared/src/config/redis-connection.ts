import { ConfigService } from '@nestjs/config';

/**
 * Core ioredis connection options shared by every Redis consumer in the
 * codebase (BullMQ, cache services, throttler storage, readiness probes).
 *
 * Prefers Upstash (free-tier managed Redis) over the legacy self-hosted
 * REDIS_* variables:
 * - UPSTASH_REDIS_HOST / UPSTASH_REDIS_PASSWORD / UPSTASH_REDIS_PORT / UPSTASH_REDIS_TLS
 * - falls back to REDIS_HOST / REDIS_PASSWORD / REDIS_PORT for local dev
 */
export interface RedisCoreConnectionOptions {
  host: string;
  port: number;
  password?: string;
  tls?: { rejectUnauthorized: boolean };
}

const FALSY_FLAGS = new Set(['false', '0', 'off', 'no']);
const DEFAULT_REDIS_HOST = '127.0.0.1';
const DEFAULT_REDIS_PORT = 6379;

function readEnvValue(
  configService: ConfigService | undefined,
  key: string,
): string | undefined {
  const fromConfig = configService?.get<string | undefined>(key);
  const value = fromConfig ?? process.env[key];
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readNumberValue(
  configService: ConfigService | undefined,
  key: string,
  fallbackValue: number,
): number {
  const raw = readEnvValue(configService, key);
  if (raw === undefined) {
    return fallbackValue;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : fallbackValue;
}

function isTruthyFlag(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }

  return !FALSY_FLAGS.has(value.toLowerCase());
}

export function readRedisCoreOptions(
  configService?: ConfigService,
): RedisCoreConnectionOptions {
  const upstashHost = readEnvValue(configService, 'UPSTASH_REDIS_HOST');
  const host =
    upstashHost ??
    readEnvValue(configService, 'REDIS_HOST') ??
    DEFAULT_REDIS_HOST;

  const port = upstashHost
    ? readNumberValue(configService, 'UPSTASH_REDIS_PORT', 6379)
    : readNumberValue(configService, 'REDIS_PORT', DEFAULT_REDIS_PORT);

  const password =
    (upstashHost
      ? readEnvValue(configService, 'UPSTASH_REDIS_PASSWORD')
      : undefined) ??
    readEnvValue(configService, 'UPSTASH_REDIS_PASSWORD') ??
    readEnvValue(configService, 'REDIS_PASSWORD');

  const tlsExplicitlyDisabled = FALSY_FLAGS.has(
    (readEnvValue(configService, 'UPSTASH_REDIS_TLS') ?? '').toLowerCase(),
  );
  const tlsRequested = isTruthyFlag(
    readEnvValue(configService, 'UPSTASH_REDIS_TLS'),
  );
  const useTls = tlsExplicitlyDisabled
    ? false
    : tlsRequested || Boolean(upstashHost);

  return {
    host,
    port,
    password,
    tls: useTls ? { rejectUnauthorized: false } : undefined,
  };
}

/**
 * BullMQ requires `maxRetriesPerRequest: null` on the blocking worker
 * connection. Upstash's TLS endpoint is used by default whenever an
 * Upstash host is configured.
 */
export function buildBullMqConnectionOptions(
  configService?: ConfigService,
): RedisCoreConnectionOptions & { maxRetriesPerRequest: null } {
  return {
    ...readRedisCoreOptions(configService),
    maxRetriesPerRequest: null,
  };
}
