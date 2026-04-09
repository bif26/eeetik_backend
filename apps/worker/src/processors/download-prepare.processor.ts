import { Job } from 'bullmq';
import { InjectModel } from '@nestjs/mongoose';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Model } from 'mongoose';
import {
  DOWNLOAD_QUEUE_NAME,
  DownloadLog,
  DownloadRequestType,
  DownloadStatus,
  getStructuredLogger,
  PostType,
  PrepareDownloadJobData,
  REDIS_CDN_PREFIX,
  TikTokMetadata,
} from '@shared';
import { WorkerMediaService } from '../services/worker-media.service';
import { WorkerObjectStorageService } from '../services/worker-object-storage.service';
import { WorkerRedisCacheService } from '../services/worker-redis-cache.service';

const DEFAULT_STORAGE_RETENTION_HOURS = 72;
const DEFAULT_STORAGE_MAX_MONTHLY_BYTES = 10 * 1024 * 1024 * 1024;
const DEFAULT_DOWNLOAD_LOCK_TTL_MS = 15_000;
const DEFAULT_DOWNLOAD_LOCK_WAIT_MS = 7_000;
const DEFAULT_DOWNLOAD_LOCK_WAIT_POLL_MS = 250;

interface CreatedDownloadAsset {
  storageKey: string;
  storageBytes: number;
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
}

@Injectable()
@Processor(DOWNLOAD_QUEUE_NAME)
export class DownloadPrepareProcessor extends WorkerHost {
  private readonly logger = getStructuredLogger('worker');

  constructor(
    @InjectModel(TikTokMetadata.name)
    private readonly tikTokMetadataModel: Model<TikTokMetadata>,
    @InjectModel(DownloadLog.name)
    private readonly downloadLogModel: Model<DownloadLog>,
    private readonly workerMediaService: WorkerMediaService,
    private readonly workerObjectStorageService: WorkerObjectStorageService,
    private readonly workerRedisCacheService: WorkerRedisCacheService,
    private readonly configService: ConfigService,
  ) {
    super();
  }

  async process(job: Job<PrepareDownloadJobData>): Promise<void> {
    const jobId = this.getJobId(job);
    const { uniqueId, requestType } = job.data;
    this.logger.info('download.job.started', {
      jobId,
      uniqueId,
      requestType,
    });

    try {
      const metadata = await this.tikTokMetadataModel
        .findOne({ uniqueId })
        .lean()
        .exec();

      if (!metadata) {
        throw new NotFoundException(
          `No metadata found for uniqueId: ${uniqueId}`,
        );
      }

      const { storageKey, storageBytes } = await this.createDownloadAsset(
        metadata,
        requestType,
      );
      await this.assertWithinMonthlyStorageCap({
        jobId,
        uniqueId,
        requestType,
        storageKey,
        storageBytes,
      });

      const storageExpiresAt = this.getStorageExpirationDate();
      const { uniqueId: fileUniqueId, filename } =
        this.workerObjectStorageService.parseStorageKey(storageKey);
      const downloadUrl = this.workerObjectStorageService.getSignedUrl(
        fileUniqueId,
        filename,
      );

      await this.downloadLogModel
        .updateOne(
          { jobId },
          {
            status: DownloadStatus.COMPLETED,
            storageKey,
            storageBytes,
            storageExpiresAt,
            storageDeletedAt: undefined,
            downloadUrl,
            errorMessage: undefined,
          },
        )
        .exec();
      this.logger.info('download.job.completed', {
        jobId,
        uniqueId,
        requestType,
        status: DownloadStatus.COMPLETED,
        storageKey,
        storageBytes,
        storageExpiresAt: storageExpiresAt.toISOString(),
      });
    } catch (error) {
      const errorMessage = this.toErrorMessage(error);
      await this.downloadLogModel
        .updateOne(
          { jobId },
          {
            status: DownloadStatus.FAILED,
            errorMessage,
          },
        )
        .exec();
      this.logger.error('download.job.failed', {
        jobId,
        uniqueId,
        requestType,
        status: DownloadStatus.FAILED,
        errorMessage,
      });

      throw error;
    }
  }

  private async createDownloadAsset(
    metadata: TikTokMetadata,
    requestType: DownloadRequestType,
  ): Promise<CreatedDownloadAsset> {
    if (requestType === DownloadRequestType.ZIP) {
      return this.withDownloadLock(
        metadata.uniqueId,
        requestType,
        'images.zip',
        async () => this.createZipAsset(metadata),
      );
    }

    if (requestType === DownloadRequestType.AUDIO) {
      return this.withDownloadLock(
        metadata.uniqueId,
        requestType,
        'audio.mp3',
        async () => {
          const filename = 'audio.mp3';
          const existingAsset = await this.getExistingAsset(
            metadata.uniqueId,
            filename,
          );
          if (existingAsset) {
            return existingAsset;
          }

          const sourceUrl = await this.resolveSourceUrl(
            metadata,
            DownloadRequestType.AUDIO,
          );
          const stream =
            await this.workerMediaService.downloadAsStream(sourceUrl);
          const storageBytes = await this.workerObjectStorageService.putStream(
            metadata.uniqueId,
            filename,
            stream,
          );
          return {
            storageKey: this.workerObjectStorageService.toStorageKey(
              metadata.uniqueId,
              filename,
            ),
            storageBytes,
          };
        },
      );
    }

    const videoFilename =
      requestType === DownloadRequestType.HD ? 'video-hd.mp4' : 'video-sd.mp4';
    return this.withDownloadLock(
      metadata.uniqueId,
      requestType,
      videoFilename,
      async () => {
        const existingAsset = await this.getExistingAsset(
          metadata.uniqueId,
          videoFilename,
        );
        if (existingAsset) {
          return existingAsset;
        }

        const sourceUrl = await this.resolveSourceUrl(metadata, requestType);
        const stream =
          await this.workerMediaService.downloadAsStream(sourceUrl);
        const storageBytes = await this.workerObjectStorageService.putStream(
          metadata.uniqueId,
          videoFilename,
          stream,
        );
        return {
          storageKey: this.workerObjectStorageService.toStorageKey(
            metadata.uniqueId,
            videoFilename,
          ),
          storageBytes,
        };
      },
    );
  }

  private async createZipAsset(
    metadata: TikTokMetadata,
  ): Promise<CreatedDownloadAsset> {
    if (
      metadata.postType !== PostType.IMAGE ||
      metadata.imageKeys.length === 0
    ) {
      throw new NotFoundException(
        `Image keys are missing for ZIP request. uniqueId: ${metadata.uniqueId}`,
      );
    }

    const zipFilename = 'images.zip';
    const existingAsset = await this.getExistingAsset(
      metadata.uniqueId,
      zipFilename,
    );
    if (existingAsset) {
      return existingAsset;
    }

    const imageBuffers = await Promise.all(
      metadata.imageKeys.map(async (key, index) => {
        const filename = this.normalizeStoredFilename(
          metadata.uniqueId,
          key,
          index,
        );
        return {
          name: filename,
          body: await this.workerObjectStorageService.getBuffer(
            metadata.uniqueId,
            filename,
          ),
        };
      }),
    );

    const zipBuffer = await this.workerMediaService.buildZip(imageBuffers);
    const storageBytes = await this.workerObjectStorageService.putBuffer(
      metadata.uniqueId,
      zipFilename,
      zipBuffer,
    );
    return {
      storageKey: this.workerObjectStorageService.toStorageKey(
        metadata.uniqueId,
        zipFilename,
      ),
      storageBytes,
    };
  }

  private async getExistingAsset(
    uniqueId: string,
    filename: string,
  ): Promise<CreatedDownloadAsset | null> {
    const exists = await this.workerObjectStorageService.fileExists(
      uniqueId,
      filename,
    );
    if (!exists) {
      return null;
    }

    const storageBytes = await this.workerObjectStorageService.getFileSize(
      uniqueId,
      filename,
    );
    return {
      storageKey: this.workerObjectStorageService.toStorageKey(
        uniqueId,
        filename,
      ),
      storageBytes,
    };
  }

  private async resolveSourceUrl(
    metadata: TikTokMetadata,
    requestType:
      | DownloadRequestType.AUDIO
      | DownloadRequestType.HD
      | DownloadRequestType.SD,
  ): Promise<string> {
    const cachedCdn = await this.getCachedCdnUrls(metadata.uniqueId);
    const sourceUrl =
      requestType === DownloadRequestType.AUDIO
        ? (cachedCdn?.urls.audio ?? metadata.originalAudioUrl)
        : requestType === DownloadRequestType.HD
          ? (cachedCdn?.urls.hd ?? metadata.originalVideoUrl)
          : (cachedCdn?.urls.sd ?? metadata.originalVideoUrl);

    if (!sourceUrl) {
      throw new NotFoundException(
        `Source URL is missing for uniqueId: ${metadata.uniqueId}, requestType: ${requestType}`,
      );
    }

    return sourceUrl;
  }

  private async getCachedCdnUrls(
    uniqueId: string,
  ): Promise<CdnUrlCacheRecord | null> {
    try {
      return await this.workerRedisCacheService.get<CdnUrlCacheRecord>(
        `${REDIS_CDN_PREFIX}${uniqueId}`,
      );
    } catch (error) {
      this.logger.warn('download.cdn.cache_lookup_failed', {
        uniqueId,
        errorMessage: this.toErrorMessage(error),
      });
      return null;
    }
  }

  private normalizeStoredFilename(
    uniqueId: string,
    keyOrFilename: string,
    fallbackIndex: number,
  ): string {
    const trimmed = keyOrFilename.trim().replace(/^\/+/, '');
    if (!trimmed.includes('/')) {
      return trimmed;
    }

    const segments = trimmed.split('/').filter((segment) => segment.length > 0);
    if (
      segments[0] === 'metadata' &&
      segments.length >= 4 &&
      segments[1] === uniqueId &&
      segments[2] === 'images'
    ) {
      const rawFilename = segments[3];
      const ext = rawFilename.includes('.')
        ? rawFilename.slice(rawFilename.lastIndexOf('.'))
        : '.webp';
      const stem = rawFilename.replace(/\.[^.]*$/, '');
      const index = Number(stem);
      if (Number.isFinite(index)) {
        return `image-${Math.max(0, Math.floor(index))}${ext}`;
      }

      return `image-${fallbackIndex}.webp`;
    }

    if (segments[0] === uniqueId && segments.length >= 2) {
      return segments[segments.length - 1];
    }

    return segments[segments.length - 1];
  }

  private async withDownloadLock(
    uniqueId: string,
    requestType: DownloadRequestType,
    expectedFilename: string,
    createAsset: () => Promise<CreatedDownloadAsset>,
  ): Promise<CreatedDownloadAsset> {
    const lockTtlMs = this.readPositiveIntegerConfig(
      'DOWNLOAD_LOCK_TTL_MS',
      DEFAULT_DOWNLOAD_LOCK_TTL_MS,
    );
    const lockWaitMs = this.readPositiveIntegerConfig(
      'DOWNLOAD_LOCK_WAIT_MS',
      DEFAULT_DOWNLOAD_LOCK_WAIT_MS,
    );
    const lockWaitPollMs = this.readPositiveIntegerConfig(
      'DOWNLOAD_LOCK_WAIT_POLL_MS',
      DEFAULT_DOWNLOAD_LOCK_WAIT_POLL_MS,
    );
    const lockKey = `download:prepare:lock:${uniqueId}:${requestType}`;
    const lockToken = randomUUID();
    const hasLock = await this.workerRedisCacheService.acquireLock(
      lockKey,
      lockToken,
      lockTtlMs,
    );

    if (!hasLock) {
      const waitedAsset = await this.waitForExistingAsset(
        uniqueId,
        expectedFilename,
        lockWaitMs,
        lockWaitPollMs,
      );
      if (waitedAsset) {
        return waitedAsset;
      }

      throw new Error(
        `Another prepare request is already processing ${uniqueId}/${expectedFilename}`,
      );
    }

    try {
      return await createAsset();
    } finally {
      try {
        await this.workerRedisCacheService.releaseLock(lockKey, lockToken);
      } catch (error) {
        this.logger.warn('download.lock.release_failed', {
          uniqueId,
          requestType,
          lockKey,
          errorMessage: this.toErrorMessage(error),
        });
      }
    }
  }

  private async waitForExistingAsset(
    uniqueId: string,
    filename: string,
    waitMs: number,
    pollMs: number,
  ): Promise<CreatedDownloadAsset | null> {
    const deadlineAt = Date.now() + waitMs;
    while (Date.now() < deadlineAt) {
      const existingAsset = await this.getExistingAsset(uniqueId, filename);
      if (existingAsset) {
        return existingAsset;
      }

      await this.sleep(pollMs);
    }

    return null;
  }

  private getJobId(job: Job<PrepareDownloadJobData>): string {
    if (!job.id) {
      throw new Error('Queue job id is required');
    }

    return String(job.id);
  }

  private toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return 'Unknown worker error';
  }

  private getStorageExpirationDate(): Date {
    const retentionHours = this.readPositiveIntegerConfig(
      'STORAGE_RETENTION_HOURS',
      DEFAULT_STORAGE_RETENTION_HOURS,
    );
    const retentionMs = retentionHours * 60 * 60 * 1000;
    return new Date(Date.now() + retentionMs);
  }

  private async assertWithinMonthlyStorageCap(input: {
    jobId: string;
    uniqueId: string;
    requestType: DownloadRequestType;
    storageKey: string;
    storageBytes: number;
  }): Promise<void> {
    const storageCapBytes = this.readPositiveIntegerConfig(
      'STORAGE_MAX_MONTHLY_BYTES',
      DEFAULT_STORAGE_MAX_MONTHLY_BYTES,
    );
    const currentUsageBytes = await this.getCurrentMonthStorageUsageBytes();
    const projectedUsageBytes = currentUsageBytes + input.storageBytes;

    if (projectedUsageBytes <= storageCapBytes) {
      return;
    }

    this.logger.warn('download.storage_cap.exceeded', {
      jobId: input.jobId,
      uniqueId: input.uniqueId,
      requestType: input.requestType,
      storageKey: input.storageKey,
      currentUsageBytes,
      newAssetBytes: input.storageBytes,
      projectedUsageBytes,
      storageCapBytes,
    });

    try {
      await this.workerObjectStorageService.deleteObject(input.storageKey);
    } catch (rollbackError) {
      this.logger.error('download.storage_cap.rollback_failed', {
        jobId: input.jobId,
        uniqueId: input.uniqueId,
        requestType: input.requestType,
        storageKey: input.storageKey,
        errorMessage: this.toErrorMessage(rollbackError),
      });
    }

    throw new Error(
      `Monthly storage cap exceeded: projected usage ${projectedUsageBytes}/${storageCapBytes} bytes (current ${currentUsageBytes}, new asset ${input.storageBytes}). Increase STORAGE_MAX_MONTHLY_BYTES to resume processing.`,
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

  private readPositiveIntegerConfig(
    envKey: string,
    fallbackValue: number,
  ): number {
    const rawValue = this.configService.get<string>(envKey);
    if (rawValue === undefined || rawValue.trim().length === 0) {
      return fallbackValue;
    }

    const parsedValue = Number(rawValue);
    if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
      return fallbackValue;
    }

    return Math.floor(parsedValue);
  }

  private sleep(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    });
  }
}
