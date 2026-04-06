import { HttpModule } from '@nestjs/axios';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import {
  DOWNLOAD_QUEUE_NAME,
  DownloadLog,
  DownloadLogSchema,
  TikTokMetadata,
  TikTokMetadataSchema,
} from '@shared';
import { DownloadPrepareProcessor } from './processors/download-prepare.processor';
import { StorageRetentionService } from './services/storage-retention.service';
import { WorkerMediaService } from './services/worker-media.service';
import { WorkerObjectStorageService } from './services/worker-object-storage.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    HttpModule,
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
    BullModule.registerQueue({
      name: DOWNLOAD_QUEUE_NAME,
    }),
    MongooseModule.forFeature([
      {
        name: TikTokMetadata.name,
        schema: TikTokMetadataSchema,
      },
      {
        name: DownloadLog.name,
        schema: DownloadLogSchema,
      },
    ]),
  ],
  providers: [
    DownloadPrepareProcessor,
    StorageRetentionService,
    WorkerMediaService,
    WorkerObjectStorageService,
  ],
})
export class WorkerModule {}
