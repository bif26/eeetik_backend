import { BullModule } from '@nestjs/bullmq';
import { ExecutionContext, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import {
  ThrottlerGuard,
  ThrottlerModule,
  ThrottlerModuleOptions,
} from '@nestjs/throttler';
import { RedisThrottlerStorage } from './common/throttling/redis-throttler.storage';
import { DownloadModule } from './download/download.module';
import { FilesModule } from './files/files.module';
import { HealthModule } from './health/health.module';
import { ObservabilityModule } from './observability/observability.module';
import { RequestMetricsInterceptor } from './observability/request-metrics.interceptor';

const DEFAULT_THROTTLE_TTL_MS = 60_000;
const DEFAULT_THROTTLE_LIMIT = 120;
const DEFAULT_REDIS_HOST = '127.0.0.1';
const DEFAULT_REDIS_PORT = 6_379;
const DEFAULT_THROTTLE_REDIS_KEY_PREFIX = 'throttle';
const HEALTH_AND_METRICS_CONTROLLERS = new Set([
  'HealthController',
  'MetricsController',
]);
const EXPENSIVE_DOWNLOAD_HANDLERS = new Set([
  'DownloadController.getMetadata',
  'DownloadController.prepareDownload',
]);

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService): ThrottlerModuleOptions =>
        buildThrottlerOptions(configService),
    }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        uri: configService.get<string>(
          'MONGO_URI',
          'mongodb://127.0.0.1:27017/eeetik',
        ),
      }),
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        connection: {
          host: configService.get<string>('REDIS_HOST', '127.0.0.1'),
          port: Number(configService.get<string>('REDIS_PORT', '6379')),
          password: configService.get<string>('REDIS_PASSWORD') || undefined,
        },
      }),
    }),
    HealthModule,
    ObservabilityModule,
    DownloadModule,
    FilesModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: RequestMetricsInterceptor,
    },
  ],
})
export class AppModule {}

function buildThrottlerOptions(
  configService: ConfigService,
): ThrottlerModuleOptions {
  const defaultThrottleTtlMs = readPositiveIntegerConfig(
    configService,
    'THROTTLE_TTL_MS',
    DEFAULT_THROTTLE_TTL_MS,
  );
  const defaultThrottleLimit = readPositiveIntegerConfig(
    configService,
    'THROTTLE_LIMIT',
    DEFAULT_THROTTLE_LIMIT,
  );
  const defaultThrottleBlockDurationMs = readPositiveIntegerConfig(
    configService,
    'THROTTLE_BLOCK_DURATION_MS',
    defaultThrottleTtlMs,
  );

  const expensiveThrottleTtlMs = readPositiveIntegerConfig(
    configService,
    'THROTTLE_EXPENSIVE_TTL_MS',
    defaultThrottleTtlMs,
  );
  const expensiveLimitDefault = Math.max(
    1,
    Math.floor(defaultThrottleLimit / 4),
  );
  const expensiveLimitMax = Math.max(1, defaultThrottleLimit - 1);
  const expensiveThrottleLimit = Math.min(
    readPositiveIntegerConfig(
      configService,
      'THROTTLE_EXPENSIVE_LIMIT',
      expensiveLimitDefault,
    ),
    expensiveLimitMax,
  );
  const expensiveThrottleBlockDurationMs = readPositiveIntegerConfig(
    configService,
    'THROTTLE_EXPENSIVE_BLOCK_DURATION_MS',
    expensiveThrottleTtlMs,
  );

  const throttleRedisHost = readStringConfig(
    configService,
    'THROTTLE_REDIS_HOST',
    configService.get<string>('REDIS_HOST', DEFAULT_REDIS_HOST),
  );
  const throttleRedisPort = readPositiveIntegerConfig(
    configService,
    'THROTTLE_REDIS_PORT',
    readPositiveIntegerConfig(configService, 'REDIS_PORT', DEFAULT_REDIS_PORT),
  );
  const throttleRedisPassword = readOptionalConfig(
    configService,
    'THROTTLE_REDIS_PASSWORD',
    configService.get<string>('REDIS_PASSWORD'),
  );
  const throttleRedisKeyPrefix = readStringConfig(
    configService,
    'THROTTLE_REDIS_KEY_PREFIX',
    DEFAULT_THROTTLE_REDIS_KEY_PREFIX,
  );

  return {
    storage: new RedisThrottlerStorage({
      host: throttleRedisHost,
      port: throttleRedisPort,
      password: throttleRedisPassword,
      keyPrefix: throttleRedisKeyPrefix,
    }),
    throttlers: [
      {
        name: 'default',
        ttl: defaultThrottleTtlMs,
        limit: defaultThrottleLimit,
        blockDuration: defaultThrottleBlockDurationMs,
        skipIf: shouldSkipThrottlingForController,
      },
      {
        name: 'expensive',
        ttl: expensiveThrottleTtlMs,
        limit: expensiveThrottleLimit,
        blockDuration: expensiveThrottleBlockDurationMs,
        skipIf: (context: ExecutionContext): boolean =>
          shouldSkipThrottlingForController(context) ||
          !isExpensiveDownloadRequest(context),
      },
    ],
  };
}

function shouldSkipThrottlingForController(context: ExecutionContext): boolean {
  return HEALTH_AND_METRICS_CONTROLLERS.has(context.getClass().name);
}

function isExpensiveDownloadRequest(context: ExecutionContext): boolean {
  const handlerSignature = `${context.getClass().name}.${context.getHandler().name}`;
  return EXPENSIVE_DOWNLOAD_HANDLERS.has(handlerSignature);
}

function readPositiveIntegerConfig(
  configService: ConfigService,
  envKey: string,
  fallbackValue: number,
): number {
  const value = configService.get<string>(envKey);
  if (value === undefined || value.trim().length === 0) {
    return fallbackValue;
  }

  const parsedValue = Number(value);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return fallbackValue;
  }

  return Math.floor(parsedValue);
}

function readStringConfig(
  configService: ConfigService,
  envKey: string,
  fallbackValue: string,
): string {
  const value = configService.get<string>(envKey);
  if (value === undefined || value.trim().length === 0) {
    return fallbackValue;
  }

  return value.trim();
}

function readOptionalConfig(
  configService: ConfigService,
  envKey: string,
  fallbackValue?: string,
): string | undefined {
  const value = configService.get<string>(envKey);
  if (value !== undefined) {
    return normalizeOptionalValue(value);
  }

  return normalizeOptionalValue(fallbackValue);
}

function normalizeOptionalValue(value?: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmedValue = value.trim();
  if (trimmedValue.length === 0) {
    return undefined;
  }

  return trimmedValue;
}
