import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

const RELEASE_LOCK_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

@Injectable()
export class RedisCacheService implements OnModuleDestroy {
  private readonly redisClient: Redis;

  constructor(private readonly configService: ConfigService) {
    this.redisClient = new Redis({
      host: this.configService.get<string>('REDIS_HOST', '127.0.0.1'),
      port: Number(this.configService.get<string>('REDIS_PORT', '6379')),
      password: this.configService.get<string>('REDIS_PASSWORD') || undefined,
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
    });
  }

  async get<T>(key: string): Promise<T | null> {
    await this.connectIfNeeded();
    const value = await this.redisClient.get(key);
    if (!value) {
      return null;
    }

    return JSON.parse(value) as T;
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.connectIfNeeded();
    await this.redisClient.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  }

  async exists(key: string): Promise<boolean> {
    await this.connectIfNeeded();
    const exists = await this.redisClient.exists(key);
    return exists === 1;
  }

  async acquireLock(
    key: string,
    ownerToken: string,
    ttlMs: number,
  ): Promise<boolean> {
    await this.connectIfNeeded();
    const result = await this.redisClient.set(
      key,
      ownerToken,
      'PX',
      ttlMs,
      'NX',
    );
    return result === 'OK';
  }

  async releaseLock(key: string, ownerToken: string): Promise<void> {
    await this.connectIfNeeded();
    await this.redisClient.eval(RELEASE_LOCK_LUA, 1, key, ownerToken);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redisClient.status !== 'end') {
      await this.redisClient.quit();
    }
  }

  private async connectIfNeeded(): Promise<void> {
    if (this.redisClient.status === 'wait') {
      await this.redisClient.connect();
    }
  }
}
