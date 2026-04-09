import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import {
  assertSignedUrlRuntimeConfig,
  waitForCriticalDependencies,
} from '@shared';
import { config as loadEnv } from 'dotenv';
import { json, urlencoded } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';

const bootstrapLogger = new Logger('ApiBootstrap');

loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

async function bootstrap(): Promise<void> {
  assertSignedUrlRuntimeConfig({ serviceName: 'api' });
  await waitForCriticalDependencies({ serviceName: 'api' });

  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);
  const requestBodyLimit = configService.get<string>(
    'REQUEST_BODY_LIMIT',
    '1mb',
  );

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          defaultSrc: ["'self'"],
          baseUri: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
    }),
  );
  app.use(json({ limit: requestBodyLimit }));
  app.use(urlencoded({ extended: true, limit: requestBodyLimit }));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const corsOrigins = configService
    .get<string>('CORS_ORIGINS', '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  app.enableCors(
    corsOrigins.length > 0
      ? {
          origin: corsOrigins,
          credentials: true,
        }
      : { origin: true },
  );

  app.setGlobalPrefix(configService.get<string>('API_PREFIX', 'api/v2'));

  const port = Number(configService.get<string>('PORT', '3000'));
  await app.listen(port);
}
void bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  bootstrapLogger.error(`Startup aborted: ${message}`);
  process.exit(1);
});
