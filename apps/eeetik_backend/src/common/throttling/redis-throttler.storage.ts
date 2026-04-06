import { Logger, OnModuleDestroy } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import Redis from 'ioredis';

interface RedisThrottlerStorageOptions {
  host: string;
  port: number;
  password?: string;
  keyPrefix: string;
}

type RedisIncrementResponse = [
  number | string,
  number | string,
  number | string,
  number | string,
];

interface ThrottlerStorageIncrementResult {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

const REDIS_INCREMENT_SCRIPT = `
local hitKey = KEYS[1]
local blockKey = KEYS[2]
local ttlMs = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local blockDurationMs = tonumber(ARGV[3])

local blockTtlMs = redis.call('PTTL', blockKey)
if blockTtlMs > 0 then
  local blockedHits = tonumber(redis.call('GET', hitKey) or '0')
  local blockedHitTtlMs = redis.call('PTTL', hitKey)
  if blockedHitTtlMs < 0 then
    blockedHitTtlMs = ttlMs
  end
  return { blockedHits, blockedHitTtlMs, 1, blockTtlMs }
end

local totalHits = redis.call('INCR', hitKey)
local hitTtlMs = redis.call('PTTL', hitKey)
if hitTtlMs < 0 then
  redis.call('PEXPIRE', hitKey, ttlMs)
  hitTtlMs = ttlMs
end

if totalHits > limit then
  redis.call('SET', blockKey, '1', 'PX', blockDurationMs)
  redis.call('DEL', hitKey)
  return { totalHits, ttlMs, 1, blockDurationMs }
end

return { totalHits, hitTtlMs, 0, 0 }
`;

export class RedisThrottlerStorage
  implements ThrottlerStorage, OnModuleDestroy
{
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  private readonly redisClient: Redis;
  private readonly fallbackStorage = new ThrottlerStorageService();
  private hasLoggedFallback = false;

  constructor(private readonly options: RedisThrottlerStorageOptions) {
    this.redisClient = new Redis({
      host: options.host,
      port: options.port,
      password: options.password,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
      retryStrategy: () => null,
    });
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageIncrementResult> {
    const ttlMs = this.toPositiveInteger(ttl, 1_000);
    const limitValue = this.toPositiveInteger(limit, 1);
    const blockDurationMs = this.toPositiveInteger(blockDuration, ttlMs);

    try {
      await this.connectIfNeeded();
      return await this.incrementInRedis(
        key,
        ttlMs,
        limitValue,
        blockDurationMs,
        throttlerName,
      );
    } catch (error: unknown) {
      this.logFallback(error);
      return this.fallbackStorage.increment(
        key,
        ttlMs,
        limitValue,
        blockDurationMs,
        throttlerName,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.fallbackStorage.onApplicationShutdown();
    if (this.redisClient.status !== 'end') {
      try {
        await this.redisClient.quit();
      } catch {
        this.redisClient.disconnect();
      }
    }
  }

  private async connectIfNeeded(): Promise<void> {
    if (
      this.redisClient.status === 'wait' ||
      this.redisClient.status === 'end'
    ) {
      await this.redisClient.connect();
    }
  }

  private async incrementInRedis(
    key: string,
    ttlMs: number,
    limit: number,
    blockDurationMs: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageIncrementResult> {
    const keyPrefix = `${this.options.keyPrefix}:${throttlerName}:${key}`;
    const result = (await this.redisClient.eval(
      REDIS_INCREMENT_SCRIPT,
      2,
      `${keyPrefix}:hits`,
      `${keyPrefix}:blocked`,
      String(ttlMs),
      String(limit),
      String(blockDurationMs),
    )) as RedisIncrementResponse;

    const [rawTotalHits, rawTimeToExpireMs, rawIsBlocked, rawBlockExpireMs] =
      result;

    return {
      totalHits: this.toNonNegativeInteger(rawTotalHits),
      timeToExpire: this.millisecondsToSeconds(rawTimeToExpireMs),
      isBlocked: this.toNonNegativeInteger(rawIsBlocked) === 1,
      timeToBlockExpire: this.millisecondsToSeconds(rawBlockExpireMs),
    };
  }

  private toPositiveInteger(value: number, fallbackValue: number): number {
    if (!Number.isFinite(value) || value <= 0) {
      return fallbackValue;
    }

    return Math.floor(value);
  }

  private toNonNegativeInteger(value: number | string): number {
    const parsedValue = Number(value);
    if (!Number.isFinite(parsedValue) || parsedValue < 0) {
      return 0;
    }

    return Math.floor(parsedValue);
  }

  private millisecondsToSeconds(value: number | string): number {
    const milliseconds = this.toNonNegativeInteger(value);
    if (milliseconds === 0) {
      return 0;
    }

    return Math.ceil(milliseconds / 1_000);
  }

  private logFallback(error: unknown): void {
    if (this.hasLoggedFallback) {
      return;
    }

    this.hasLoggedFallback = true;
    const message = error instanceof Error ? error.message : String(error);
    this.logger.warn(
      `Redis throttle storage unavailable, falling back to in-memory storage: ${message}`,
    );
  }
}
