import { Job } from 'bullmq';
import { InjectModel } from '@nestjs/mongoose';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Model } from 'mongoose';
import {
  DEFAULT_TELEGRAM_MAX_UPLOAD_MB,
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
import { TelegramStorageService } from '../services/telegram-storage.service';
import { TelegramUploadType } from '../services/telegram-storage.service';
import { WorkerMediaService } from '../services/worker-media.service';
import { WorkerRedisCacheService } from '../services/worker-redis-cache.service';

const DEFAULT_DOWNLOAD_LOCK_TTL_MS = 15_000;
const DEFAULT_DOWNLOAD_LOCK_WAIT_MS = 7_000;
const DEFAULT_DOWNLOAD_LOCK_WAIT_POLL_MS = 250;
const CAPTION_MAX_LENGTH = 1_000;

/**
 * BullMQ worker concurrency. Evaluated from the real process environment
 * (Render injects env vars before boot). Defaults to 2 for the 512 MB RAM
 * Render free tier.
 */
function readWorkerConcurrency(): number {
  const raw = process.env.WORKER_CONCURRENCY;
  const parsed = Number(raw);
  if (raw && Number.isFinite(parsed) && parsed > 0) {
    return Math.min(Math.floor(parsed), 8);
  }

  return 2;
}

interface PreparedAsset {
  telegramFileId: string;
  storageBytes: number;
  uploadedToChatId: number;
}

@Injectable()
@Processor(DOWNLOAD_QUEUE_NAME, { concurrency: readWorkerConcurrency() })
export class DownloadPrepareProcessor extends WorkerHost {
  private readonly logger = getStructuredLogger('worker');

  constructor(
    @InjectModel(TikTokMetadata.name)
    private readonly tikTokMetadataModel: Model<TikTokMetadata>,
    @InjectModel(DownloadLog.name)
    private readonly downloadLogModel: Model<DownloadLog>,
    private readonly workerMediaService: WorkerMediaService,
    private readonly telegramStorageService: TelegramStorageService,
    private readonly workerRedisCacheService: WorkerRedisCacheService,
    private readonly configService: ConfigService,
  ) {
    super();
  }

  async process(job: Job<PrepareDownloadJobData>): Promise<void> {
    const jobId = this.getJobId(job);
    const { uniqueId, requestType, chatId } = job.data;
    this.logger.info('download.job.started', {
      jobId,
      uniqueId,
      requestType,
      chatId,
    });

    let tempDir: string | undefined;

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

      // 1. Telegram CDN (file_id) cache — instant re-delivery, no re-download.
      const cachedFileId = await this.telegramStorageService.getCachedFileId(
        uniqueId,
        requestType,
      );

      if (cachedFileId) {
        if (chatId) {
          await this.telegramStorageService.sendFileByFileId(
            chatId,
            cachedFileId,
            this.toTelegramType(requestType),
            this.buildCaption(metadata),
          );
        }

        await this.markCompleted(jobId, {
          telegramFileId: cachedFileId,
          storageBytes: 0,
          uploadedToChatId: chatId ?? 0,
        });
        this.logger.info('download.job.completed_from_cache', {
          jobId,
          uniqueId,
          requestType,
          chatId,
          status: DownloadStatus.COMPLETED,
          cache: 'hit',
        });
        return;
      }

      // 2. Download to /tmp, upload to Telegram, cache file_id, deliver.
      tempDir = await this.createTempDir(jobId);

      const asset = await this.withDownloadLock(
        uniqueId,
        requestType,
        async () =>
          this.createAndUploadAsset({
            jobId,
            metadata,
            requestType,
            chatId,
            tempDir: tempDir as string,
          }),
      );

      await this.markCompleted(jobId, {
        telegramFileId: asset.telegramFileId,
        storageBytes: asset.storageBytes,
        uploadedToChatId: asset.uploadedToChatId,
      });
      this.logger.info('download.job.completed', {
        jobId,
        uniqueId,
        requestType,
        chatId,
        status: DownloadStatus.COMPLETED,
        storageBytes: asset.storageBytes,
        cache: 'miss',
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

      if (chatId) {
        await this.telegramStorageService.sendError(
          chatId,
          this.toUserFriendlyError(error),
        );
      }

      this.logger.error('download.job.failed', {
        jobId,
        uniqueId,
        requestType,
        status: DownloadStatus.FAILED,
        errorMessage,
      });

      throw error;
    } finally {
      // Critical on ephemeral Render disks: never leave files behind.
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true }).catch(
          (cleanupError: unknown) => {
            this.logger.warn('download.temp.cleanup_failed', {
              jobId,
              tempDir,
              errorMessage: this.toErrorMessage(cleanupError),
            });
          },
        );
      }
    }
  }

  private async createAndUploadAsset(input: {
    jobId: string;
    metadata: TikTokMetadata;
    requestType: DownloadRequestType;
    chatId?: number;
    tempDir: string;
  }): Promise<PreparedAsset> {
    const { metadata, requestType, tempDir } = input;

    if (requestType === DownloadRequestType.ZIP) {
      return this.createZipAsset(input);
    }

    const filename =
      requestType === DownloadRequestType.HD
        ? 'video-hd.mp4'
        : requestType === DownloadRequestType.SD
          ? 'video-sd.mp4'
          : 'audio.mp3';

    const sourceUrl = await this.resolveSourceUrl(metadata, requestType);
    const filePath = join(tempDir, filename);
    const storageBytes = await this.workerMediaService.downloadToFile(
      sourceUrl,
      filePath,
    );
    this.assertWithinTelegramUploadLimit(storageBytes, filename);

    const destinationChatId = this.resolveUploadDestination(input.chatId);
    const caption = this.buildCaption(metadata);
    const upload =
      requestType === DownloadRequestType.AUDIO
        ? await this.telegramStorageService.uploadAudio(
            destinationChatId,
            filePath,
            caption,
          )
        : await this.telegramStorageService.uploadVideo(
            destinationChatId,
            filePath,
            caption,
          );

    await this.telegramStorageService.cacheFileId(
      metadata.uniqueId,
      requestType,
      upload.fileId,
    );

    return {
      telegramFileId: upload.fileId,
      storageBytes,
      uploadedToChatId: destinationChatId,
    };
  }

  private async createZipAsset(input: {
    metadata: TikTokMetadata;
    requestType: DownloadRequestType;
    chatId?: number;
    tempDir: string;
  }): Promise<PreparedAsset> {
    const { metadata, requestType, tempDir } = input;
    const imageUrls = (metadata.originalImageUrls ?? []).filter(
      (url): url is string => typeof url === 'string' && url.length > 0,
    );

    if (metadata.postType !== PostType.IMAGE || imageUrls.length === 0) {
      throw new NotFoundException(
        `Image URLs are missing for ZIP request. uniqueId: ${metadata.uniqueId}`,
      );
    }

    const imageBuffers = await Promise.all(
      imageUrls.map(async (url, index) => ({
        name: this.buildImageEntryName(url, index),
        body: await this.workerMediaService.downloadAsBuffer(url),
      })),
    );

    const zipBuffer = await this.workerMediaService.buildZip(imageBuffers);
    this.assertWithinTelegramUploadLimit(zipBuffer.byteLength, 'images.zip');

    const zipPath = join(tempDir, 'images.zip');
    await writeFile(zipPath, zipBuffer);

    const destinationChatId = this.resolveUploadDestination(input.chatId);
    const upload = await this.telegramStorageService.uploadDocument(
      destinationChatId,
      zipPath,
      this.buildCaption(metadata),
    );

    await this.telegramStorageService.cacheFileId(
      metadata.uniqueId,
      requestType,
      upload.fileId,
    );

    return {
      telegramFileId: upload.fileId,
      storageBytes: zipBuffer.byteLength,
      uploadedToChatId: destinationChatId,
    };
  }

  private resolveUploadDestination(requestChatId?: number): number {
    if (requestChatId) {
      return requestChatId;
    }

    const fallbackChatId = this.readIntegerConfig(
      'TELEGRAM_STORAGE_CHAT_ID',
      0,
    );
    if (fallbackChatId > 0) {
      return fallbackChatId;
    }

    throw new Error(
      'Job has no chatId and TELEGRAM_STORAGE_CHAT_ID is not configured – cannot upload to Telegram CDN',
    );
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

  private assertWithinTelegramUploadLimit(
    bytes: number,
    filename: string,
  ): void {
    const limitMb = this.readIntegerConfig(
      'TELEGRAM_MAX_UPLOAD_MB',
      DEFAULT_TELEGRAM_MAX_UPLOAD_MB,
    );
    const limitBytes = limitMb * 1024 * 1024;
    if (bytes <= limitBytes) {
      return;
    }

    throw new Error(
      `${filename} is ${(bytes / (1024 * 1024)).toFixed(1)} MB – larger than the ${limitMb} MB Telegram bot upload limit. Try a lower quality.`,
    );
  }

  private async withDownloadLock(
    uniqueId: string,
    requestType: DownloadRequestType,
    createAsset: () => Promise<PreparedAsset>,
  ): Promise<PreparedAsset> {
    const lockTtlMs = this.readIntegerConfig(
      'DOWNLOAD_LOCK_TTL_MS',
      DEFAULT_DOWNLOAD_LOCK_TTL_MS,
    );
    const lockWaitMs = this.readIntegerConfig(
      'DOWNLOAD_LOCK_WAIT_MS',
      DEFAULT_DOWNLOAD_LOCK_WAIT_MS,
    );
    const lockWaitPollMs = this.readIntegerConfig(
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
      // Another worker is preparing the same asset – wait for its file_id.
      const waitedFileId = await this.waitForCachedFileId(
        uniqueId,
        requestType,
        lockWaitMs,
        lockWaitPollMs,
      );
      if (waitedFileId) {
        return {
          telegramFileId: waitedFileId,
          storageBytes: 0,
          uploadedToChatId: 0,
        };
      }

      throw new Error(
        `Another prepare job is already processing ${uniqueId}:${requestType}`,
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

  private async waitForCachedFileId(
    uniqueId: string,
    requestType: DownloadRequestType,
    waitMs: number,
    pollMs: number,
  ): Promise<string | null> {
    const deadlineAt = Date.now() + waitMs;
    while (Date.now() < deadlineAt) {
      const fileId = await this.telegramStorageService.getCachedFileId(
        uniqueId,
        requestType,
      );
      if (fileId) {
        return fileId;
      }

      await this.sleep(pollMs);
    }

    return null;
  }

  private async markCompleted(
    jobId: string,
    asset: {
      telegramFileId: string;
      storageBytes: number;
      uploadedToChatId: number;
    },
  ): Promise<void> {
    await this.downloadLogModel
      .updateOne(
        { jobId },
        {
          status: DownloadStatus.COMPLETED,
          telegramFileId: asset.telegramFileId,
          storageBytes: asset.storageBytes,
          storageKey: undefined,
          storageExpiresAt: undefined,
          storageDeletedAt: undefined,
          downloadUrl: undefined,
          errorMessage: undefined,
        },
      )
      .exec();
  }

  private buildCaption(metadata: TikTokMetadata): string {
    const parts: string[] = [];
    if (metadata.title && metadata.title.trim().length > 0) {
      parts.push(this.truncate(metadata.title.trim(), 400));
    }
    if (metadata.authorName) {
      parts.push(`👤 ${metadata.authorName}`);
    }
    parts.push('');

    const caption = parts.join('\n');
    return caption.length > CAPTION_MAX_LENGTH
      ? caption.slice(0, CAPTION_MAX_LENGTH - 1)
      : caption;
  }

  private toTelegramType(requestType: DownloadRequestType): TelegramUploadType {
    if (requestType === DownloadRequestType.AUDIO) {
      return 'audio';
    }

    if (requestType === DownloadRequestType.ZIP) {
      return 'document';
    }

    return 'video';
  }

  private toUserFriendlyError(error: unknown): string {
    const message = this.toErrorMessage(error);
    if (message.includes('larger than the')) {
      return message;
    }

    if (error instanceof NotFoundException) {
      return 'This media is no longer available. Please send the link again.';
    }

    return 'The download failed. Please try again in a moment.';
  }

  /**
   * Creates a per-job temp directory under TEMP_DOWNLOAD_DIR (spec default
   * /tmp/eeetik-downloads). Render free tier disks are ephemeral – every
   * directory is removed again in the job's finally block.
   */
  private async createTempDir(jobId: string): Promise<string> {
    const configuredBase = this.configService
      .get<string>('TEMP_DOWNLOAD_DIR')
      ?.trim();
    const baseDir =
      configuredBase && configuredBase.length > 0
        ? configuredBase
        : join(tmpdir(), 'eeetik-downloads');

    await mkdir(baseDir, { recursive: true });
    return mkdtemp(join(baseDir, `job-${jobId.slice(0, 8)}-`));
  }

  private buildImageEntryName(url: string, index: number): string {
    let extension = '.jpg';
    try {
      const pathname = new URL(url).pathname;
      const match = /\.(jpe?g|png|webp|heic)$/i.exec(pathname);
      if (match) {
        extension = `.${match[1].toLowerCase()}`;
      }
    } catch {
      // keep default extension
    }

    return `image-${index}${extension}`;
  }

  private getJobId(job: Job<PrepareDownloadJobData>): string {
    if (!job.id) {
      throw new Error('Queue job id is required');
    }

    return String(job.id);
  }

  private readIntegerConfig(key: string, fallbackValue: number): number {
    const rawValue = this.configService.get<string>(key);
    if (rawValue === undefined || rawValue.trim().length === 0) {
      return fallbackValue;
    }

    const parsedValue = Number(rawValue);
    if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
      return fallbackValue;
    }

    return Math.floor(parsedValue);
  }

  private toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return 'Unknown worker error';
  }

  private truncate(value: string, maxLength: number): string {
    return value.length > maxLength
      ? `${value.slice(0, maxLength - 1)}…`
      : value;
  }

  private sleep(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    });
  }
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
