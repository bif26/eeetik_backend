import { InjectQueue } from '@nestjs/bullmq';
import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { Model } from 'mongoose';
import {
  DEFAULT_METADATA_CACHE_TTL_SECONDS,
  DEFAULT_METADATA_SINGLEFLIGHT_LOCK_TTL_MS,
  DEFAULT_METADATA_SINGLEFLIGHT_MAX_RETRIES,
  DEFAULT_METADATA_SINGLEFLIGHT_WAIT_RETRY_MS,
  DOWNLOAD_PREPARE_JOB_NAME,
  DOWNLOAD_QUEUE_NAME,
  DownloadLog,
  DownloadRequestType,
  DownloadStatus,
  getStructuredLogger,
  REDIS_METADATA_LOCK_PREFIX,
  PostType,
  PrepareDownloadJobData,
  REDIS_METADATA_PREFIX,
  REDIS_UNIQUE_PREFIX,
  TikTokMetadata,
  TikTokScrapeResult,
  TikTokScrapeStats,
} from '@shared';
import { PrepareDownloadDto } from '../dto/prepare-download.dto';
import { TikTokMetadataRequestDto } from '../dto/tiktok-metadata-request.dto';
import { formatCompactCount } from '../helpers/compact-count.formatter';
import { mapAvailableFormats } from '../helpers/available-formats.mapper';
import {
  TikTokPreviewData,
  TikTokPreviewResponse,
  TikTokPreviewStats,
} from '../interfaces/tiktok-preview-response.interface';
import { AdGateService } from './ad-gate.service';
import { MediaTransformService } from './media-transform.service';
import { ObjectStorageService } from './object-storage.service';
import { RedisCacheService } from './redis-cache.service';
import { TikTokScraperService } from './tiktok-scraper.service';

interface MetadataCacheRecord {
  uniqueId: string;
  sourceUrl: string;
  postType: PostType;
  title?: string;
  authorName?: string;
  authorAvatarUrl?: string;
  authorAvatarKey?: string;
  stats?: TikTokScrapeStats;
  hashtags: string[];
  duration?: number;
  thumbnailKey?: string;
  imageKeys: string[];
  originalVideoUrl?: string;
  originalAudioUrl?: string;
  originalImageUrls?: string[];
  rawMetadata?: Record<string, unknown>;
}

const DEFAULT_STORAGE_MAX_MONTHLY_BYTES = 10 * 1024 * 1024 * 1024;

@Injectable()
export class DownloadService {
  private readonly metadataUrlCacheTtlSeconds: number;
  private readonly metadataUidCacheTtlSeconds: number;
  private readonly metadataSingleFlightLockTtlMs: number;
  private readonly metadataSingleFlightWaitRetryMs: number;
  private readonly metadataSingleFlightMaxRetries: number;
  private readonly logger = getStructuredLogger('api');

  constructor(
    @InjectModel(TikTokMetadata.name)
    private readonly tikTokMetadataModel: Model<TikTokMetadata>,
    @InjectModel(DownloadLog.name)
    private readonly downloadLogModel: Model<DownloadLog>,
    @InjectQueue(DOWNLOAD_QUEUE_NAME)
    private readonly downloadQueue: Queue<PrepareDownloadJobData>,
    private readonly configService: ConfigService,
    private readonly redisCacheService: RedisCacheService,
    private readonly scraperService: TikTokScraperService,
    private readonly mediaTransformService: MediaTransformService,
    private readonly objectStorageService: ObjectStorageService,
    private readonly adGateService: AdGateService,
  ) {
    const metadataCacheTtlSeconds = this.getConfigAsInt(
      'METADATA_CACHE_TTL_SECONDS',
      DEFAULT_METADATA_CACHE_TTL_SECONDS,
      { min: 1 },
    );
    this.metadataUrlCacheTtlSeconds = this.getConfigAsInt(
      'METADATA_CACHE_URL_TTL_SECONDS',
      metadataCacheTtlSeconds,
      { min: 1 },
    );
    this.metadataUidCacheTtlSeconds = this.getConfigAsInt(
      'METADATA_CACHE_UID_TTL_SECONDS',
      metadataCacheTtlSeconds,
      { min: 1 },
    );
    this.metadataSingleFlightLockTtlMs = this.getConfigAsInt(
      'METADATA_SINGLEFLIGHT_LOCK_TTL_MS',
      DEFAULT_METADATA_SINGLEFLIGHT_LOCK_TTL_MS,
      { min: 1 },
    );
    this.metadataSingleFlightWaitRetryMs = this.getConfigAsInt(
      'METADATA_SINGLEFLIGHT_WAIT_RETRY_MS',
      DEFAULT_METADATA_SINGLEFLIGHT_WAIT_RETRY_MS,
      { min: 0 },
    );
    this.metadataSingleFlightMaxRetries = this.getConfigAsInt(
      'METADATA_SINGLEFLIGHT_MAX_RETRIES',
      DEFAULT_METADATA_SINGLEFLIGHT_MAX_RETRIES,
      { min: 1 },
    );
  }

  async fetchMetadata(
    payload: TikTokMetadataRequestDto,
    requestId?: string,
  ): Promise<TikTokPreviewResponse> {
    this.assertTikTokUrl(payload.url);

    const cacheKey = this.getMetadataCacheKeyByUrl(payload.url);
    const cachedMetadata =
      await this.redisCacheService.get<MetadataCacheRecord>(cacheKey);

    if (cachedMetadata) {
      await this.cacheMetadataByUniqueId(cachedMetadata);
      this.logger.info('download.metadata.lookup', {
        requestId,
        route: '/model/download/tiktok',
        cache: 'hit',
        source: 'redis',
        uniqueId: cachedMetadata.uniqueId,
      });

      return {
        success: true,
        data: await this.toPublicMetadata(cachedMetadata),
      };
    }

    const lockKey = this.getMetadataLockKey(payload.url);
    const lockToken = randomUUID();
    let hasLock = await this.redisCacheService.acquireLock(
      lockKey,
      lockToken,
      this.metadataSingleFlightLockTtlMs,
    );

    if (!hasLock) {
      const metadataFromWait = await this.waitForCachedMetadata(
        cacheKey,
        lockKey,
      );
      if (metadataFromWait) {
        await this.cacheMetadataByUniqueId(metadataFromWait);
        this.logger.info('download.metadata.lookup', {
          requestId,
          route: '/model/download/tiktok',
          cache: 'hit',
          source: 'redis',
          uniqueId: metadataFromWait.uniqueId,
        });

        return {
          success: true,
          data: await this.toPublicMetadata(metadataFromWait),
        };
      }

      hasLock = await this.redisCacheService.acquireLock(
        lockKey,
        lockToken,
        this.metadataSingleFlightLockTtlMs,
      );
    }

    if (!hasLock) {
      this.logger.warn('download.metadata.singleflight.fallback', {
        requestId,
        route: '/model/download/tiktok',
        cacheKey,
        retries: this.metadataSingleFlightMaxRetries,
      });
    }

    try {
      const cacheAfterLock =
        await this.redisCacheService.get<MetadataCacheRecord>(cacheKey);

      if (cacheAfterLock) {
        await this.cacheMetadataByUniqueId(cacheAfterLock);
        this.logger.info('download.metadata.lookup', {
          requestId,
          route: '/model/download/tiktok',
          cache: 'hit',
          source: 'redis',
          uniqueId: cacheAfterLock.uniqueId,
        });

        return {
          success: true,
          data: await this.toPublicMetadata(cacheAfterLock),
        };
      }

      const mongoMetadata = await this.tikTokMetadataModel
        .findOne({ sourceUrl: payload.url })
        .sort({ updatedAt: -1 })
        .lean()
        .exec();

      if (mongoMetadata) {
        const cacheRecord = this.mapToCacheRecord(mongoMetadata);
        await this.cacheMetadata(payload.url, cacheRecord);
        this.logger.info('download.metadata.lookup', {
          requestId,
          route: '/model/download/tiktok',
          cache: 'miss',
          source: 'mongo',
          uniqueId: cacheRecord.uniqueId,
        });

        return {
          success: true,
          data: await this.toPublicMetadata(cacheRecord),
        };
      }

      const scrapeResult = await this.scraperService.scrape(payload.url);
      const persisted = await this.persistScrapeResult(
        payload.url,
        scrapeResult,
      );
      const cacheRecord = this.mapToCacheRecord(persisted);
      await this.cacheMetadata(payload.url, cacheRecord);
      this.logger.info('download.metadata.lookup', {
        requestId,
        route: '/model/download/tiktok',
        cache: 'miss',
        source: 'scraper',
        uniqueId: cacheRecord.uniqueId,
      });

      return {
        success: true,
        data: await this.toPublicMetadata(cacheRecord),
      };
    } finally {
      if (hasLock) {
        try {
          await this.redisCacheService.releaseLock(lockKey, lockToken);
        } catch (error) {
          this.logger.warn('download.metadata.singleflight.unlock_failed', {
            requestId,
            route: '/model/download/tiktok',
            error: this.toErrorMessage(error),
          });
        }
      }
    }
  }

  async prepareDownload(
    payload: PrepareDownloadDto,
    requestId?: string,
  ): Promise<{
    jobId: string;
    status: DownloadStatus;
  }> {
    this.adGateService.assertAccess(payload);
    await this.assertPrepareWithinMonthlyStorageCap(payload, requestId);

    const metadata = await this.tikTokMetadataModel
      .findOne({ uniqueId: payload.uniqueId })
      .lean()
      .exec();

    if (!metadata) {
      throw new NotFoundException('Metadata uniqueId was not found');
    }

    const jobId = randomUUID();
    await this.downloadQueue.add(
      DOWNLOAD_PREPARE_JOB_NAME,
      {
        uniqueId: payload.uniqueId,
        requestType: payload.requestType,
      },
      {
        jobId,
        removeOnComplete: 500,
        removeOnFail: 1000,
      },
    );

    await this.downloadLogModel.create({
      jobId,
      uniqueId: payload.uniqueId,
      requestType: payload.requestType,
      status: DownloadStatus.PROCESSING,
    });
    this.logger.info('download.prepare.enqueued', {
      requestId,
      route: '/model/download/tiktok/prepare',
      uniqueId: payload.uniqueId,
      jobId,
      requestType: payload.requestType,
      status: DownloadStatus.PROCESSING,
    });

    return {
      jobId,
      status: DownloadStatus.PROCESSING,
    };
  }

  async getStatus(
    jobId: string,
    requestId?: string,
  ): Promise<{
    jobId: string;
    status: DownloadStatus;
    downloadUrl?: string;
    errorMessage?: string;
  }> {
    const downloadLog = await this.downloadLogModel
      .findOne({ jobId })
      .lean()
      .exec();

    if (!downloadLog) {
      throw new NotFoundException('Download job was not found');
    }
    this.logger.info('download.status.lookup', {
      requestId,
      route: '/model/download/tiktok/status/:jobId',
      jobId: downloadLog.jobId,
      uniqueId: downloadLog.uniqueId,
      status: downloadLog.status,
    });

    return {
      jobId: downloadLog.jobId,
      status: downloadLog.status,
      downloadUrl: downloadLog.downloadUrl,
      errorMessage: downloadLog.errorMessage,
    };
  }

  private async persistScrapeResult(
    sourceUrl: string,
    scrapeResult: TikTokScrapeResult,
  ): Promise<TikTokMetadata> {
    const uniqueId = randomUUID();
    const isImagePost = scrapeResult.imageUrls.length > 0;
    const postType = isImagePost ? PostType.IMAGE : PostType.VIDEO;

    if (!isImagePost && !scrapeResult.videoUrl) {
      throw new BadGatewayException(
        'Scraper result did not include video or image resources',
      );
    }

    const thumbnailKey =
      postType === PostType.VIDEO && scrapeResult.thumbnailUrl
        ? await this.persistThumbnail(uniqueId, scrapeResult.thumbnailUrl)
        : undefined;

    const imageKeys =
      postType === PostType.IMAGE
        ? await this.persistImages(uniqueId, scrapeResult.imageUrls)
        : [];
    const authorAvatarKey = scrapeResult.authorAvatarUrl
      ? await this.persistAuthorAvatar(uniqueId, scrapeResult.authorAvatarUrl)
      : undefined;

    const created = await this.tikTokMetadataModel.create({
      uniqueId,
      sourceUrl,
      postType,
      title: scrapeResult.title,
      authorName: scrapeResult.authorName,
      authorAvatarUrl: scrapeResult.authorAvatarUrl,
      authorAvatarKey,
      stats: scrapeResult.stats,
      hashtags: scrapeResult.hashtags,
      duration: scrapeResult.duration,
      thumbnailKey,
      imageKeys,
      originalVideoUrl: scrapeResult.videoUrl,
      originalAudioUrl: scrapeResult.audioUrl,
      originalImageUrls: scrapeResult.imageUrls,
      rawMetadata: scrapeResult.raw,
    });

    return created.toObject();
  }

  private async persistThumbnail(
    uniqueId: string,
    thumbnailUrl: string,
  ): Promise<string> {
    const thumbnailBuffer =
      await this.mediaTransformService.downloadAndConvertToWebp(
        thumbnailUrl,
        1080,
      );
    const thumbnailKey = `metadata/${uniqueId}/thumbnail.webp`;
    await this.objectStorageService.putBuffer(
      thumbnailKey,
      thumbnailBuffer,
      'image/webp',
    );
    return thumbnailKey;
  }

  private async persistImages(
    uniqueId: string,
    imageUrls: string[],
  ): Promise<string[]> {
    return Promise.all(
      imageUrls.map(async (imageUrl, index) => {
        const imageBuffer =
          await this.mediaTransformService.downloadAndConvertToWebp(
            imageUrl,
            1440,
          );
        const imageKey = `metadata/${uniqueId}/images/${index + 1}.webp`;
        await this.objectStorageService.putBuffer(
          imageKey,
          imageBuffer,
          'image/webp',
        );
        return imageKey;
      }),
    );
  }

  private async persistAuthorAvatar(
    uniqueId: string,
    authorAvatarUrl: string,
  ): Promise<string> {
    const avatarBuffer =
      await this.mediaTransformService.downloadAndConvertToWebp(
        authorAvatarUrl,
        512,
      );
    const authorAvatarKey = `metadata/${uniqueId}/avatar.webp`;
    await this.objectStorageService.putBuffer(
      authorAvatarKey,
      avatarBuffer,
      'image/webp',
    );
    return authorAvatarKey;
  }

  private mapToCacheRecord(metadata: TikTokMetadata): MetadataCacheRecord {
    return {
      uniqueId: metadata.uniqueId,
      sourceUrl: metadata.sourceUrl,
      postType: metadata.postType,
      title: metadata.title,
      authorName: metadata.authorName,
      authorAvatarUrl: metadata.authorAvatarUrl,
      authorAvatarKey: metadata.authorAvatarKey,
      stats: metadata.stats,
      hashtags: metadata.hashtags ?? [],
      duration: metadata.duration,
      thumbnailKey: metadata.thumbnailKey,
      imageKeys: metadata.imageKeys ?? [],
      originalVideoUrl: metadata.originalVideoUrl,
      originalAudioUrl: metadata.originalAudioUrl,
      originalImageUrls: metadata.originalImageUrls ?? [],
      rawMetadata: metadata.rawMetadata ?? {},
    };
  }

  private async toPublicMetadata(
    record: MetadataCacheRecord,
  ): Promise<TikTokPreviewData> {
    const authorAvatar = record.authorAvatarKey
      ? await this.objectStorageService.getSignedUrl(record.authorAvatarKey)
      : null;
    const stats = this.formatStats(record.stats);
    const hashtags = this.normalizeHashtags(record.hashtags ?? []);

    if (record.postType === PostType.IMAGE) {
      const images = await Promise.all(
        (record.imageKeys ?? []).map((key) =>
          this.objectStorageService.getSignedUrl(key),
        ),
      );

      return {
        uniqueId: record.uniqueId,
        type: PostType.IMAGE,
        title: record.title ?? '',
        author: {
          nickname: record.authorName ?? '',
          avatar: authorAvatar,
        },
        stats,
        hashtags,
        availableFormats: mapAvailableFormats(PostType.IMAGE),
        images,
      };
    }

    const thumbnail = record.thumbnailKey
      ? await this.objectStorageService.getSignedUrl(record.thumbnailKey)
      : null;

    return {
      uniqueId: record.uniqueId,
      type: PostType.VIDEO,
      title: record.title ?? '',
      author: {
        nickname: record.authorName ?? '',
        avatar: authorAvatar,
      },
      stats,
      hashtags,
      availableFormats: mapAvailableFormats(PostType.VIDEO),
      thumbnail,
      duration: record.duration ?? 0,
    };
  }

  private formatStats(stats?: TikTokScrapeStats): TikTokPreviewStats {
    return {
      views: formatCompactCount(stats?.views),
      likes: formatCompactCount(stats?.likes),
      shares: formatCompactCount(stats?.shares),
      comments: formatCompactCount(stats?.comments),
    };
  }

  private normalizeHashtags(hashtags: string[]): string[] {
    return hashtags
      .map((hashtag) => hashtag.trim())
      .filter((hashtag): hashtag is string => hashtag.length > 0)
      .map((hashtag) => (hashtag.startsWith('#') ? hashtag : `#${hashtag}`));
  }

  private async cacheMetadata(
    sourceUrl: string,
    record: MetadataCacheRecord,
  ): Promise<void> {
    await Promise.all([
      this.redisCacheService.set(
        this.getMetadataCacheKeyByUrl(sourceUrl),
        record,
        this.metadataUrlCacheTtlSeconds,
      ),
      this.redisCacheService.set(
        this.getMetadataCacheKeyByUniqueId(record.uniqueId),
        record,
        this.metadataUidCacheTtlSeconds,
      ),
    ]);
  }

  private async cacheMetadataByUniqueId(
    record: MetadataCacheRecord,
  ): Promise<void> {
    try {
      await this.redisCacheService.set(
        this.getMetadataCacheKeyByUniqueId(record.uniqueId),
        record,
        this.metadataUidCacheTtlSeconds,
      );
    } catch (error) {
      this.logger.warn('download.metadata.cache_uid_failed', {
        uniqueId: record.uniqueId,
        error: this.toErrorMessage(error),
      });
    }
  }

  private async waitForCachedMetadata(
    cacheKey: string,
    lockKey: string,
  ): Promise<MetadataCacheRecord | null> {
    for (
      let attempt = 0;
      attempt < this.metadataSingleFlightMaxRetries;
      attempt += 1
    ) {
      await this.sleep(this.metadataSingleFlightWaitRetryMs);
      const cachedMetadata =
        await this.redisCacheService.get<MetadataCacheRecord>(cacheKey);
      if (cachedMetadata) {
        return cachedMetadata;
      }

      const lockStillHeld = await this.redisCacheService.exists(lockKey);
      if (!lockStillHeld) {
        return null;
      }
    }

    return null;
  }

  private sleep(delayMs: number): Promise<void> {
    if (delayMs === 0) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    });
  }

  private async assertPrepareWithinMonthlyStorageCap(
    payload: { uniqueId: string; requestType: DownloadRequestType },
    requestId?: string,
  ): Promise<void> {
    const storageCapBytes = this.getConfigAsInt(
      'STORAGE_MAX_MONTHLY_BYTES',
      DEFAULT_STORAGE_MAX_MONTHLY_BYTES,
      { min: 1 },
    );
    const currentUsageBytes = await this.getCurrentMonthStorageUsageBytes();
    if (currentUsageBytes < storageCapBytes) {
      return;
    }

    this.logger.warn('download.prepare.blocked.storage_cap', {
      requestId,
      route: '/model/download/tiktok/prepare',
      uniqueId: payload.uniqueId,
      requestType: payload.requestType,
      currentUsageBytes,
      storageCapBytes,
    });

    throw new ServiceUnavailableException(
      `Monthly storage cap reached (${currentUsageBytes}/${storageCapBytes} bytes). New prepare requests are paused until STORAGE_MAX_MONTHLY_BYTES is increased.`,
    );
  }

  private async getCurrentMonthStorageUsageBytes(): Promise<number> {
    const now = new Date();
    const monthStartUtc = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    const usage = await this.downloadLogModel
      .aggregate<{ _id: null; totalBytes: number }>([
        {
          $match: {
            createdAt: { $gte: monthStartUtc },
            storageBytes: { $gt: 0 },
          },
        },
        {
          $group: {
            _id: null,
            totalBytes: { $sum: '$storageBytes' },
          },
        },
      ])
      .exec();

    return usage[0]?.totalBytes ?? 0;
  }

  private getConfigAsInt(
    key: string,
    fallbackValue: number,
    options: { min: number },
  ): number {
    const rawValue = this.configService.get<string>(key);
    if (rawValue === undefined) {
      return fallbackValue;
    }

    const value = Number(rawValue);
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      return fallbackValue;
    }

    return value >= options.min ? value : fallbackValue;
  }

  private getMetadataCacheKeyByUrl(url: string): string {
    return `${REDIS_METADATA_PREFIX}${encodeURIComponent(url)}`;
  }

  private getMetadataCacheKeyByUniqueId(uniqueId: string): string {
    return `${REDIS_UNIQUE_PREFIX}${uniqueId}`;
  }

  private getMetadataLockKey(url: string): string {
    return `${REDIS_METADATA_LOCK_PREFIX}${encodeURIComponent(url)}`;
  }

  private toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return 'Unknown error';
  }

  private assertTikTokUrl(url: string): void {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new BadRequestException('Invalid URL');
    }

    if (parsedUrl.protocol !== 'https:') {
      throw new BadRequestException('Only HTTPS TikTok URLs are supported');
    }

    const hostname = parsedUrl.hostname.toLowerCase();
    const isTikTokDomain =
      hostname === 'tiktok.com' || hostname.endsWith('.tiktok.com');

    if (!isTikTokDomain) {
      throw new BadRequestException('Only TikTok URLs are supported');
    }
  }
}
