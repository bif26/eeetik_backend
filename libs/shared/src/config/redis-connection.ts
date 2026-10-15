import { ConfigService } from '@nestjs/config';

/**
 * Core ioredis connection options shared by every Redis consumer in the
 * codebase (BullMQ, cache services, throttler storage, readiness probes).
 *
 * Resolution order:
 * 1. REDIS_URL – full connection string (`redis://` / `rediss://`). This is
 *    what Heroku Redis, Redis Cloud, Railway, Render Key Value and most
 *    providers expose as a single variable.
 * 2. UPSTASH_REDIS_HOST / UPSTASH_REDIS_PASSWORD / UPSTASH_REDIS_PORT / UPSTASH_REDIS_TLS
 * 3. REDIS_HOST / REDIS_PASSWORD / REDIS_PORT for local dev
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

/**
 * Parses a `redis://` / `rediss://` connection URL (Heroku Redis, Redis
 * Cloud, Render Key Value, …) into core connection options.
 *
 * - `rediss://` enables TLS (`rejectUnauthorized: false`, matching the
 *   Upstash handling)
 * - passwords may live in the URL password slot (`redis://:pw@host`) or the
 *   username slot (`redis://default:pw@host` style providers are handled)
 * - returns null when the URL is malformed or has a foreign scheme
 */
export function parseRedisUrl(
  rawUrl: string,
): RedisCoreConnectionOptions | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return null;
  }

  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    return null;
  }

  const decode = (value: string): string => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };

  const options: RedisCoreConnectionOptions = {
    host: parsed.hostname,
    port: Number(parsed.port) || DEFAULT_REDIS_PORT,
    tls:
      parsed.protocol === 'rediss:' ? { rejectUnauthorized: false } : undefined,
  };

  const password = parsed.password
    ? decode(parsed.password)
    : parsed.username && parsed.username !== 'default'
      ? decode(parsed.username)
      : undefined;
  if (password) {
    options.password = password;
  }

  return options;
}

export function readRedisCoreOptions(
  configService?: ConfigService,
): RedisCoreConnectionOptions {
  const redisUrl = readEnvValue(configService, 'REDIS_URL');
  if (redisUrl) {
    const parsed = parseRedisUrl(redisUrl);
    if (parsed) {
      return parsed;
    }
  }

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
