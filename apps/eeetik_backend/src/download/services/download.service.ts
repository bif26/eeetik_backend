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
import { createHash, randomUUID } from 'node:crypto';
import { Model } from 'mongoose';
import {
  DEFAULT_CDN_URL_CACHE_TTL_SECONDS,
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
  REDIS_CDN_PREFIX,
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

interface CdnUrlCacheRecord {
  uniqueId: string;
  postType: PostType;
  urls: {
    hd?: string;
    sd?: string;
    audio?: string;
    watermark?: string;
  };
  imageUrls: string[];
  title?: string;
  cachedAt: number;
}

const DEFAULT_STORAGE_MAX_MONTHLY_BYTES = 10 * 1024 * 1024 * 1024;
const DEFAULT_PREPARE_WAIT_TIMEOUT_MS = 7_000;
const DEFAULT_PREPARE_WAIT_POLL_INTERVAL_MS = 250;
const DEFAULT_HISTORY_LIMIT = 20;
type StorageBackend = 'telegram' | 'local';

interface PrepareDownloadResponse {
  jobId: string;
  status: DownloadStatus;
  downloadUrl?: string;
  filename?: string;
  filesize?: number;
  expiresIn?: number;
  errorMessage?: string;
}

@Injectable()
export class DownloadService {
  private readonly metadataUrlCacheTtlSeconds: number;
  private readonly metadataUidCacheTtlSeconds: number;
  private readonly cdnCacheTtlSeconds: number;
  private readonly prepareWaitTimeoutMs: number;
  private readonly prepareWaitPollIntervalMs: number;
  private readonly metadataSingleFlightLockTtlMs: number;
  private readonly metadataSingleFlightWaitRetryMs: number;
  private readonly metadataSingleFlightMaxRetries: number;
  private readonly storageBackend: StorageBackend;
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
    this.cdnCacheTtlSeconds = this.getConfigAsInt(
      'CDN_URL_CACHE_TTL_SECONDS',
      DEFAULT_CDN_URL_CACHE_TTL_SECONDS,
      { min: 1 },
    );
    this.prepareWaitTimeoutMs = this.getConfigAsInt(
      'PREPARE_WAIT_TIMEOUT_MS',
      DEFAULT_PREPARE_WAIT_TIMEOUT_MS,
      { min: 0 },
    );
    this.prepareWaitPollIntervalMs = this.getConfigAsInt(
      'PREPARE_WAIT_POLL_INTERVAL_MS',
      DEFAULT_PREPARE_WAIT_POLL_INTERVAL_MS,
      { min: 50 },
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
    this.storageBackend =
      configService.get<string>('STORAGE_BACKEND', 'telegram') === 'local'
        ? 'local'
        : 'telegram';
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
      await this.cacheCdnUrlsFromMetadata(cachedMetadata);
      this.logger.info('download.metadata.lookup', {
        requestId,
        route: '/model/download/tiktok',
        cache: 'hit',
        source: 'redis',
        uniqueId: cachedMetadata.uniqueId,
      });

      return {
        success: true,
        data: this.toPublicMetadata(cachedMetadata),
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
        await this.cacheCdnUrlsFromMetadata(metadataFromWait);
        this.logger.info('download.metadata.lookup', {
          requestId,
          route: '/model/download/tiktok',
          cache: 'hit',
          source: 'redis',
          uniqueId: metadataFromWait.uniqueId,
        });

        return {
          success: true,
          data: this.toPublicMetadata(metadataFromWait),
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
        await this.cacheCdnUrlsFromMetadata(cacheAfterLock);
        this.logger.info('download.metadata.lookup', {
          requestId,
          route: '/model/download/tiktok',
          cache: 'hit',
          source: 'redis',
          uniqueId: cacheAfterLock.uniqueId,
        });

        return {
          success: true,
          data: this.toPublicMetadata(cacheAfterLock),
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
        await this.cacheCdnUrlsFromMetadata(cacheRecord);
        this.logger.info('download.metadata.lookup', {
          requestId,
          route: '/model/download/tiktok',
          cache: 'miss',
          source: 'mongo',
          uniqueId: cacheRecord.uniqueId,
        });

        return {
          success: true,
          data: this.toPublicMetadata(cacheRecord),
        };
      }

      const scrapeResult = await this.scraperService.scrape(payload.url);
      const persisted = await this.persistScrapeResult(
        payload.url,
        scrapeResult,
      );
      const cacheRecord = this.mapToCacheRecord(persisted);
      await this.cacheMetadata(payload.url, cacheRecord);
      await this.cacheCdnUrlsFromScrapeResult(
        cacheRecord.uniqueId,
        cacheRecord.postType,
        scrapeResult,
      );
      this.logger.info('download.metadata.lookup', {
        requestId,
        route: '/model/download/tiktok',
        cache: 'miss',
        source: 'scraper',
        uniqueId: cacheRecord.uniqueId,
      });

      return {
        success: true,
        data: this.toPublicMetadata(cacheRecord),
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
    options?: { skipAdGate?: boolean },
  ): Promise<PrepareDownloadResponse> {
    if (options?.skipAdGate !== true) {
      this.adGateService.assertAccess(payload);
    }

    if (this.storageBackend === 'local') {
      await this.assertPrepareWithinMonthlyStorageCap(payload, requestId);
    }

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
        removeOnComplete: true,
        removeOnFail: 100,
        attempts: 2,
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

    const preparedLog = await this.waitForPrepareResult(jobId);
    if (preparedLog?.status === DownloadStatus.COMPLETED) {
      this.logger.info('download.prepare.completed', {
        requestId,
        route: '/model/download/tiktok/prepare',
        uniqueId: payload.uniqueId,
        jobId,
        requestType: payload.requestType,
        status: DownloadStatus.COMPLETED,
        storageKey: preparedLog.storageKey,
        storageBytes: preparedLog.storageBytes,
      });
      return this.toPrepareDownloadResponse(preparedLog);
    }

    if (preparedLog?.status === DownloadStatus.FAILED) {
      this.logger.warn('download.prepare.failed', {
        requestId,
        route: '/model/download/tiktok/prepare',
        uniqueId: payload.uniqueId,
        jobId,
        requestType: payload.requestType,
        status: DownloadStatus.FAILED,
        errorMessage: preparedLog.errorMessage,
      });
      return this.toPrepareDownloadResponse(preparedLog);
    }

    this.logger.info('download.prepare.processing', {
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

  /**
   * Bot/Mini App flow: enqueue a download job that will be delivered
   * directly to the requesting Telegram chat by the worker.
   * No synchronous wait — the worker sends the media and updates the log.
   */
  async enqueueBotDownload(payload: {
    uniqueId: string;
    requestType: DownloadRequestType;
    chatId: number;
    telegramUserId?: number;
    requestId?: string;
  }): Promise<{ jobId: string; status: DownloadStatus }> {
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
        chatId: payload.chatId,
        telegramUserId: payload.telegramUserId,
      },
      {
        jobId,
        removeOnComplete: true,
        removeOnFail: 100,
        attempts: 2,
      },
    );

    await this.downloadLogModel.create({
      jobId,
      uniqueId: payload.uniqueId,
      requestType: payload.requestType,
      status: DownloadStatus.PROCESSING,
      chatId: payload.chatId,
      telegramUserId: payload.telegramUserId,
    });

    this.logger.info('download.prepare.bot_enqueued', {
      requestId: payload.requestId,
      route: 'bot/enqueue',
      uniqueId: payload.uniqueId,
      jobId,
      requestType: payload.requestType,
      chatId: payload.chatId,
      telegramUserId: payload.telegramUserId,
      status: DownloadStatus.PROCESSING,
    });

    return { jobId, status: DownloadStatus.PROCESSING };
  }

  async getDownloadHistory(
    auth: { type: string; telegramUserId?: number },
    limit = DEFAULT_HISTORY_LIMIT,
    requestId?: string,
  ): Promise<
    Array<{
      jobId: string;
      uniqueId: string;
      requestType: DownloadRequestType;
      status: DownloadStatus;
      createdAt?: Date;
    }>
  > {
    const filter =
      typeof auth.telegramUserId === 'number'
        ? { telegramUserId: auth.telegramUserId }
        : {};

    const logs = await this.downloadLogModel
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(Math.max(1, Math.min(Math.floor(limit), 100)))
      .select({
        jobId: 1,
        uniqueId: 1,
        requestType: 1,
        status: 1,
        createdAt: 1,
      })
      .lean()
      .exec();

    this.logger.info('download.history.lookup', {
      requestId,
      route: '/model/download/tiktok/history',
      telegramUserId: auth.telegramUserId,
      count: logs.length,
    });

    return logs.map((log) => ({
      jobId: log.jobId,
      uniqueId: log.uniqueId,
      requestType: log.requestType,
      status: log.status,
      createdAt: log.createdAt,
    }));
  }

  private async waitForPrepareResult(
    jobId: string,
  ): Promise<Pick<
    DownloadLog,
    | 'jobId'
    | 'status'
    | 'downloadUrl'
    | 'storageKey'
    | 'storageBytes'
    | 'storageExpiresAt'
    | 'errorMessage'
  > | null> {
    if (this.prepareWaitTimeoutMs <= 0) {
      return null;
    }

    const startedAt = Date.now();
    while (Date.now() - startedAt < this.prepareWaitTimeoutMs) {
      const downloadLog = await this.downloadLogModel
        .findOne({ jobId })
        .lean()
        .exec();
      if (!downloadLog) {
        await this.sleep(this.prepareWaitPollIntervalMs);
        continue;
      }

      if (
        downloadLog.status === DownloadStatus.COMPLETED ||
        downloadLog.status === DownloadStatus.FAILED
      ) {
        return downloadLog;
      }

      await this.sleep(this.prepareWaitPollIntervalMs);
    }

    return null;
  }

  private toPrepareDownloadResponse(
    downloadLog: Pick<
      DownloadLog,
      | 'jobId'
      | 'status'
      | 'downloadUrl'
      | 'storageKey'
      | 'storageBytes'
      | 'storageExpiresAt'
      | 'errorMessage'
    >,
  ): PrepareDownloadResponse {
    const filename = downloadLog.storageKey
      ? downloadLog.storageKey.split('/').pop()
      : undefined;
    const expiresInSeconds = downloadLog.storageExpiresAt
      ? Math.max(
          0,
          Math.floor(
            (downloadLog.storageExpiresAt.getTime() - Date.now()) / 1000,
          ),
        )
      : undefined;

    return {
      jobId: downloadLog.jobId,
      status: downloadLog.status,
      downloadUrl: downloadLog.downloadUrl,
      filename,
      filesize: downloadLog.storageBytes,
      expiresIn: expiresInSeconds,
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
      thumbnailUrl:
        postType === PostType.VIDEO ? scrapeResult.thumbnailUrl : undefined,
      imageKeys,
      originalVideoUrl:
        scrapeResult.videoHdUrl ??
        scrapeResult.videoSdUrl ??
        scrapeResult.videoUrl,
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
    await this.objectStorageService.putBuffer(
      uniqueId,
      'thumbnail.webp',
      thumbnailBuffer,
    );
    return 'thumbnail.webp';
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
        const imageFilename = `image-${index}.webp`;
        await this.objectStorageService.putBuffer(
          uniqueId,
          imageFilename,
          imageBuffer,
        );
        return imageFilename;
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
    await this.objectStorageService.putBuffer(
      uniqueId,
      'avatar.webp',
      avatarBuffer,
    );
    return 'avatar.webp';
  }

  private mapToCacheRecord(metadata: TikTokMetadata): MetadataCacheRecord {
    return {
      uniqueId: metadata.uniqueId,
      sourceUrl: metadata.sourceUrl,
      postType: metadata.postType,
      title: metadata.title,
      authorName: metadata.authorName,
      authorAvatarUrl: metadata.authorAvatarUrl,
      authorAvatarKey: this.normalizeStoredFilename(
        metadata.uniqueId,
        metadata.authorAvatarKey,
      ),
      stats: metadata.stats,
      hashtags: metadata.hashtags ?? [],
      duration: metadata.duration,
      thumbnailKey: this.normalizeStoredFilename(
        metadata.uniqueId,
        metadata.thumbnailKey,
      ),
      imageKeys: (metadata.imageKeys ?? [])
        .map((key) => this.normalizeStoredFilename(metadata.uniqueId, key))
        .filter((key): key is string => typeof key === 'string'),
      originalVideoUrl: metadata.originalVideoUrl,
      originalAudioUrl: metadata.originalAudioUrl,
      originalImageUrls: metadata.originalImageUrls ?? [],
      rawMetadata: metadata.rawMetadata ?? {},
    };
  }

  private toPublicMetadata(record: MetadataCacheRecord): TikTokPreviewData {
    const authorAvatarFilename = this.normalizeStoredFilename(
      record.uniqueId,
      record.authorAvatarKey,
    );
    const authorAvatar = authorAvatarFilename
      ? this.objectStorageService.getSignedUrl(
          record.uniqueId,
          authorAvatarFilename,
        )
      : null;
    const stats = this.formatStats(record.stats);
    const hashtags = this.normalizeHashtags(record.hashtags ?? []);

    if (record.postType === PostType.IMAGE) {
      const images = (record.imageKeys ?? [])
        .map((key) => this.normalizeStoredFilename(record.uniqueId, key))
        .filter((filename): filename is string => typeof filename === 'string')
        .map((filename) =>
          this.objectStorageService.getSignedUrl(record.uniqueId, filename),
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

    const thumbnailFilename = this.normalizeStoredFilename(
      record.uniqueId,
      record.thumbnailKey,
    );
    const thumbnail = thumbnailFilename
      ? this.objectStorageService.getSignedUrl(
          record.uniqueId,
          thumbnailFilename,
        )
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

  private async cacheCdnUrlsFromScrapeResult(
    uniqueId: string,
    postType: PostType,
    scrapeResult: TikTokScrapeResult,
  ): Promise<void> {
    const record: CdnUrlCacheRecord = {
      uniqueId,
      postType,
      urls: {
        hd: scrapeResult.videoHdUrl ?? scrapeResult.videoUrl,
        sd: scrapeResult.videoSdUrl ?? scrapeResult.videoUrl,
        audio: scrapeResult.audioUrl,
        watermark: scrapeResult.videoWatermarkUrl,
      },
      imageUrls: scrapeResult.imageUrls,
      title: scrapeResult.title,
      cachedAt: Date.now(),
    };
    await this.cacheCdnUrls(record);
  }

  private async cacheCdnUrlsFromMetadata(
    record: MetadataCacheRecord,
  ): Promise<void> {
    const cdnRecord: CdnUrlCacheRecord = {
      uniqueId: record.uniqueId,
      postType: record.postType,
      urls: {
        hd: record.originalVideoUrl,
        sd: record.originalVideoUrl,
        audio: record.originalAudioUrl,
      },
      imageUrls: record.originalImageUrls ?? [],
      title: record.title,
      cachedAt: Date.now(),
    };
    await this.cacheCdnUrls(cdnRecord);
  }

  private async cacheCdnUrls(record: CdnUrlCacheRecord): Promise<void> {
    if (
      !record.urls.hd &&
      !record.urls.sd &&
      !record.urls.audio &&
      record.imageUrls.length === 0
    ) {
      return;
    }

    try {
      await this.redisCacheService.set(
        this.getCdnCacheKey(record.uniqueId),
        record,
        this.cdnCacheTtlSeconds,
      );
    } catch (error) {
      this.logger.warn('download.cdn.cache_failed', {
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
    return `${REDIS_METADATA_PREFIX}${this.hashUrl(url)}`;
  }

  private getMetadataCacheKeyByUniqueId(uniqueId: string): string {
    return `${REDIS_UNIQUE_PREFIX}${uniqueId}`;
  }

  private getCdnCacheKey(uniqueId: string): string {
    return `${REDIS_CDN_PREFIX}${uniqueId}`;
  }

  private getMetadataLockKey(url: string): string {
    return `${REDIS_METADATA_LOCK_PREFIX}${this.hashUrl(url)}`;
  }

  private hashUrl(url: string): string {
    return createHash('sha256').update(url.trim()).digest('hex');
  }

  private normalizeStoredFilename(
    uniqueId: string,
    keyOrFilename?: string,
  ): string | undefined {
    if (!keyOrFilename) {
      return undefined;
    }

    const trimmed = keyOrFilename.trim().replace(/^\/+/, '');
    if (!trimmed) {
      return undefined;
    }

    if (!trimmed.includes('/')) {
      return trimmed;
    }

    const segments = trimmed.split('/').filter((segment) => segment.length > 0);
    if (segments.length === 0) {
      return undefined;
    }

    if (
      segments[0] === 'metadata' &&
      segments.length >= 3 &&
      segments[1] === uniqueId
    ) {
      if (segments[2] === 'images' && segments.length >= 4) {
        const rawFilename = segments[3];
        const ext = rawFilename.includes('.')
          ? rawFilename.slice(rawFilename.lastIndexOf('.'))
          : '.webp';
        const stem = rawFilename.replace(/\.[^.]*$/, '');
        const index = Number(stem);
        if (Number.isFinite(index)) {
          return `image-${Math.max(0, Math.floor(index))}${ext}`;
        }

        return rawFilename;
      }

      return segments[segments.length - 1];
    }

    if (
      segments[0] === 'downloads' &&
      segments.length >= 3 &&
      segments[1] === uniqueId
    ) {
      return segments[segments.length - 1];
    }

    if (segments[0] === uniqueId && segments.length >= 2) {
      return segments[segments.length - 1];
    }

    return segments[segments.length - 1];
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
