import { Job } from 'bullmq';
import { InjectModel } from '@nestjs/mongoose';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Injectable, NotFoundException } from '@nestjs/common';
import { Model } from 'mongoose';
import {
  DOWNLOAD_QUEUE_NAME,
  DownloadLog,
  DownloadRequestType,
  DownloadStatus,
  getStructuredLogger,
  PostType,
  PrepareDownloadJobData,
  TikTokMetadata,
} from '@shared';
import { WorkerMediaService } from '../services/worker-media.service';
import { WorkerObjectStorageService } from '../services/worker-object-storage.service';

const DEFAULT_SIGNED_URL_TTL_SECONDS = 600;
const DEFAULT_STORAGE_RETENTION_HOURS = 72;
const DEFAULT_STORAGE_MAX_MONTHLY_BYTES = 10 * 1024 * 1024 * 1024;

interface CreatedDownloadAsset {
  storageKey: string;
  storageBytes: number;
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
      const downloadUrl = await this.workerObjectStorageService.getSignedUrl(
        storageKey,
        this.readPositiveIntegerConfig(
          'SIGNED_URL_TTL_SECONDS',
          DEFAULT_SIGNED_URL_TTL_SECONDS,
        ),
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
      return this.createZipAsset(metadata);
    }

    if (requestType === DownloadRequestType.AUDIO) {
      if (!metadata.originalAudioUrl) {
        throw new NotFoundException(
          `Audio source URL is missing for uniqueId: ${metadata.uniqueId}`,
        );
      }

      const audioKey = `downloads/${metadata.uniqueId}/audio.mp3`;
      const stream = await this.workerMediaService.downloadAsStream(
        metadata.originalAudioUrl,
      );
      const storageBytes = await this.workerObjectStorageService.putStream(
        audioKey,
        stream,
        'audio/mpeg',
      );
      return {
        storageKey: audioKey,
        storageBytes,
      };
    }

    if (!metadata.originalVideoUrl) {
      throw new NotFoundException(
        `Video source URL is missing for uniqueId: ${metadata.uniqueId}`,
      );
    }

    const qualityFile = requestType === DownloadRequestType.HD ? 'hd' : 'sd';
    const videoKey = `downloads/${metadata.uniqueId}/${qualityFile}.mp4`;
    const stream = await this.workerMediaService.downloadAsStream(
      metadata.originalVideoUrl,
    );
    const storageBytes = await this.workerObjectStorageService.putStream(
      videoKey,
      stream,
      'video/mp4',
    );
    return {
      storageKey: videoKey,
      storageBytes,
    };
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

    const imageBuffers = await Promise.all(
      metadata.imageKeys.map(async (key, index) => ({
        name: `image-${index + 1}.webp`,
        body: await this.workerObjectStorageService.getBuffer(key),
      })),
    );

    const zipBuffer = await this.workerMediaService.buildZip(imageBuffers);
    const zipKey = `downloads/${metadata.uniqueId}/images.zip`;
    const storageBytes = await this.workerObjectStorageService.putBuffer(
      zipKey,
      zipBuffer,
      'application/zip',
    );
    return {
      storageKey: zipKey,
      storageBytes,
    };
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
}
