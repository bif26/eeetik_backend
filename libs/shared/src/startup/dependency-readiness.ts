import { Logger } from '@nestjs/common';
import Redis from 'ioredis';
import mongoose from 'mongoose';

const logger = new Logger('StartupReadiness');

const DEFAULT_STARTUP_MAX_WAIT_MS = 60_000;
const DEFAULT_STARTUP_RETRY_INTERVAL_MS = 2_500;
const DEFAULT_STARTUP_PROBE_TIMEOUT_MS = 3_000;
const DEFAULT_MONGO_URI = 'mongodb://127.0.0.1:27017/eeetik';
const DEFAULT_REDIS_HOST = '127.0.0.1';
const DEFAULT_REDIS_PORT = 6379;

interface WaitForCriticalDependenciesOptions {
  serviceName: string;
}

interface DependencyReadinessCheck {
  dependencyName: string;
  target: string;
  maxWaitMs: number;
  retryIntervalMs: number;
  check: () => Promise<void>;
  troubleshootingTip: string;
}

interface RedisProbeOptions {
  host: string;
  port: number;
  password?: string;
}

export async function waitForCriticalDependencies(
  options: WaitForCriticalDependenciesOptions,
): Promise<void> {
  const maxWaitMs = readPositiveNumberFromEnv(
    'STARTUP_DEPENDENCY_MAX_WAIT_MS',
    DEFAULT_STARTUP_MAX_WAIT_MS,
  );
  const retryIntervalMs = readPositiveNumberFromEnv(
    'STARTUP_DEPENDENCY_RETRY_INTERVAL_MS',
    DEFAULT_STARTUP_RETRY_INTERVAL_MS,
  );
  const probeTimeoutMs = readPositiveNumberFromEnv(
    'STARTUP_DEPENDENCY_PROBE_TIMEOUT_MS',
    DEFAULT_STARTUP_PROBE_TIMEOUT_MS,
  );

  logger.log(
    `[${options.serviceName}] Waiting for critical dependencies (timeout=${maxWaitMs}ms, retryInterval=${retryIntervalMs}ms).`,
  );

  const mongoUri = process.env.MONGO_URI ?? DEFAULT_MONGO_URI;
  await waitForDependency({
    dependencyName: 'MongoDB',
    target: mongoUri,
    maxWaitMs,
    retryIntervalMs,
    check: () => probeMongo(mongoUri, probeTimeoutMs),
    troubleshootingTip:
      'Start MongoDB and verify MONGO_URI. Local command: docker compose up -d mongodb',
  });

  const redisHost = process.env.REDIS_HOST ?? DEFAULT_REDIS_HOST;
  const redisPort = readPositiveNumberFromEnv('REDIS_PORT', DEFAULT_REDIS_PORT);
  const redisPassword = process.env.REDIS_PASSWORD || undefined;
  await waitForDependency({
    dependencyName: 'Redis',
    target: `${redisHost}:${redisPort}`,
    maxWaitMs,
    retryIntervalMs,
    check: () =>
      probeRedis(
        {
          host: redisHost,
          port: redisPort,
          password: redisPassword,
        },
        probeTimeoutMs,
      ),
    troubleshootingTip:
      'Start Redis and verify REDIS_HOST/REDIS_PORT. Local command: docker compose up -d redis',
  });

  logger.log(`[${options.serviceName}] MongoDB and Redis are ready.`);
}

async function waitForDependency(
  readinessCheck: DependencyReadinessCheck,
): Promise<void> {
  logger.log(
    `Checking ${readinessCheck.dependencyName} at ${readinessCheck.target}.`,
  );

  const startedAt = Date.now();
  let attempt = 0;
  let lastErrorMessage = 'Unknown error';

  while (Date.now() - startedAt < readinessCheck.maxWaitMs) {
    attempt += 1;

    try {
      await readinessCheck.check();
      const elapsedMs = Date.now() - startedAt;
      logger.log(
        `${readinessCheck.dependencyName} reachable after ${attempt} attempt${attempt === 1 ? '' : 's'} (${elapsedMs}ms).`,
      );
      return;
    } catch (error: unknown) {
      lastErrorMessage = toErrorMessage(error);
      const elapsedMs = Date.now() - startedAt;
      const remainingMs = readinessCheck.maxWaitMs - elapsedMs;
      if (attempt === 1 || attempt % 5 === 0 || remainingMs <= 0) {
        logger.warn(
          `${readinessCheck.dependencyName} unavailable (attempt ${attempt}): ${lastErrorMessage}. Retrying in ${readinessCheck.retryIntervalMs}ms.`,
        );
      }

      if (remainingMs <= 0) {
        break;
      }

      await sleep(Math.min(readinessCheck.retryIntervalMs, remainingMs));
    }
  }

  throw new Error(
    `${readinessCheck.dependencyName} unavailable after ${readinessCheck.maxWaitMs}ms at ${readinessCheck.target}. Last error: ${lastErrorMessage}. ${readinessCheck.troubleshootingTip}`,
  );
}

async function probeMongo(uri: string, timeoutMs: number): Promise<void> {
  const connection = await mongoose
    .createConnection(uri, {
      serverSelectionTimeoutMS: timeoutMs,
      connectTimeoutMS: timeoutMs,
    })
    .asPromise();

  try {
    if (!connection.db) {
      throw new Error(
        'MongoDB connection initialized without a database handle',
      );
    }

    await connection.db.admin().ping();
  } finally {
    await connection.close().catch(() => undefined);
  }
}

async function probeRedis(
  probeOptions: RedisProbeOptions,
  timeoutMs: number,
): Promise<void> {
  const redisClient = new Redis({
    host: probeOptions.host,
    port: probeOptions.port,
    password: probeOptions.password,
    lazyConnect: true,
    connectTimeout: timeoutMs,
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
    retryStrategy: () => null,
  });

  try {
    await redisClient.connect();
    await redisClient.ping();
  } finally {
    if (redisClient.status !== 'end') {
      try {
        await redisClient.quit();
      } catch {
        redisClient.disconnect();
      }
    }
  }
}

function readPositiveNumberFromEnv(
  envKey: string,
  fallbackValue: number,
): number {
  const value = process.env[envKey];
  if (!value) {
    return fallbackValue;
  }

  const parsedValue = Number(value);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    logger.warn(
      `Ignoring invalid ${envKey}="${value}". Falling back to ${fallbackValue}.`,
    );
    return fallbackValue;
  }

  return parsedValue;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  return 'Unknown error';
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}
