import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { waitForCriticalDependencies } from '@shared';
import { config as loadEnv } from 'dotenv';
import { WorkerModule } from './worker.module';

const bootstrapLogger = new Logger('WorkerBootstrap');

loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

async function bootstrap(): Promise<void> {
  await waitForCriticalDependencies({ serviceName: 'worker' });
  await NestFactory.createApplicationContext(WorkerModule);
}
void bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  bootstrapLogger.error(`Startup aborted: ${message}`);
  process.exit(1);
});
