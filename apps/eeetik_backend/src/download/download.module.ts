import { BullModule } from '@nestjs/bullmq';
import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  DOWNLOAD_QUEUE_NAME,
  DownloadLog,
  DownloadLogSchema,
  TikTokMetadata,
  TikTokMetadataSchema,
  SharedModule,
} from '@shared';
import { SiteDomainGuard } from '../common/guards/site-domain.guard';
import { DownloadController } from './download.controller';
import { AdGateService } from './services/ad-gate.service';
import { DownloadService } from './services/download.service';
import { MediaTransformService } from './services/media-transform.service';
import { ObjectStorageService } from './services/object-storage.service';
import { RedisCacheService } from './services/redis-cache.service';
import { TikTokScraperService } from './services/tiktok-scraper.service';

@Module({
  imports: [
    HttpModule,
    SharedModule,
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
  controllers: [DownloadController],
  providers: [
    SiteDomainGuard,
    AdGateService,
    DownloadService,
    MediaTransformService,
    ObjectStorageService,
    RedisCacheService,
    TikTokScraperService,
  ],
  exports: [DownloadService],
})
export class DownloadModule {}
