import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { DownloadLog, DownloadStatus, getStructuredLogger } from '@shared';
import { Model } from 'mongoose';
import { WorkerObjectStorageService } from './worker-object-storage.service';

const DEFAULT_STORAGE_CLEANUP_INTERVAL_MINUTES = 30;
const CLEANUP_BATCH_SIZE = 100;
const EXPIRED_DOWNLOAD_MESSAGE =
  'Download asset expired after retention window';

interface ExpiredDownloadCandidate {
  _id: string;
  jobId: string;
  uniqueId: string;
  storageKey: string;
}

@Injectable()
export class StorageRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = getStructuredLogger('worker');
  private cleanupInterval?: NodeJS.Timeout;

  constructor(
    @InjectModel(DownloadLog.name)
    private readonly downloadLogModel: Model<DownloadLog>,
    private readonly workerObjectStorageService: WorkerObjectStorageService,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit(): void {
    const intervalMinutes = this.readPositiveIntegerConfig(
      'STORAGE_CLEANUP_INTERVAL_MINUTES',
      DEFAULT_STORAGE_CLEANUP_INTERVAL_MINUTES,
    );
    const intervalMs = intervalMinutes * 60 * 1000;
    this.cleanupInterval = setInterval(() => {
      void this.cleanupExpiredDownloads();
    }, intervalMs);
    this.cleanupInterval.unref();

    void this.cleanupExpiredDownloads();
  }

  onModuleDestroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }

  async cleanupExpiredDownloads(): Promise<void> {
    const now = new Date();
    const expiredCandidates = (await this.downloadLogModel
      .find({
        status: DownloadStatus.COMPLETED,
        storageKey: { $exists: true, $ne: null },
        storageExpiresAt: { $lte: now },
      })
      .select({ _id: 1, jobId: 1, uniqueId: 1, storageKey: 1 })
      .limit(CLEANUP_BATCH_SIZE)
      .lean()
      .exec()) as ExpiredDownloadCandidate[];

    if (expiredCandidates.length === 0) {
      return;
    }

    this.logger.info('storage.cleanup.batch_started', {
      candidateCount: expiredCandidates.length,
    });

    for (const candidate of expiredCandidates) {
      try {
        await this.workerObjectStorageService.deleteObject(
          candidate.storageKey,
        );
        await this.downloadLogModel
          .updateOne(
            { _id: candidate._id },
            {
              $set: {
                status: DownloadStatus.EXPIRED,
                errorMessage: EXPIRED_DOWNLOAD_MESSAGE,
                storageDeletedAt: now,
              },
              $unset: {
                downloadUrl: '',
              },
            },
          )
          .exec();
        this.logger.info('storage.cleanup.deleted', {
          jobId: candidate.jobId,
          uniqueId: candidate.uniqueId,
          storageKey: candidate.storageKey,
        });
      } catch (error) {
        this.logger.error('storage.cleanup.delete_failed', {
          jobId: candidate.jobId,
          uniqueId: candidate.uniqueId,
          storageKey: candidate.storageKey,
          errorMessage: this.toErrorMessage(error),
        });
      }
    }
  }

  private readPositiveIntegerConfig(
    envKey: string,
    fallbackValue: number,
  ): number {
    const value = this.configService.get<string>(envKey);
    if (value === undefined || value.trim().length === 0) {
      return fallbackValue;
    }

    const parsedValue = Number(value);
    if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
      return fallbackValue;
    }

    return Math.floor(parsedValue);
  }

  private toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return 'Unknown storage cleanup error';
  }
}
