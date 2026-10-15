import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const DEFAULT_TTL_HOURS = 1;

interface CleanupMetrics {
  filesDeleted: number;
  foldersDeleted: number;
  bytesReclaimed: number;
  lastRunAt: Date;
  errors: number;
}

@Injectable()
export class FileCleanupService implements OnModuleInit {
  private readonly logger = new Logger(FileCleanupService.name);
  private readonly storagePath: string;
  private readonly ttlHours: number;
  private readonly enabled: boolean;
  private metrics: CleanupMetrics = {
    filesDeleted: 0,
    foldersDeleted: 0,
    bytesReclaimed: 0,
    lastRunAt: new Date(),
    errors: 0,
  };

  constructor(private readonly configService: ConfigService) {
    this.storagePath = this.configService.get<string>(
      'STORAGE_PATH',
      './data/uploads',
    );
    this.ttlHours = this.readPositiveIntegerConfig(
      'FILE_CLEANUP_TTL_HOURS',
      DEFAULT_TTL_HOURS,
    );
    this.enabled =
      this.configService.get<string>('FILE_CLEANUP_ENABLED', 'true') === 'true';
  }

  async onModuleInit() {
    if (!this.enabled) {
      this.logger.warn('File cleanup service is disabled');
      return;
    }

    this.logger.log(
      `File cleanup service initialized (TTL: ${this.ttlHours}h)`,
    );

    await this.runCleanup();
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async scheduledCleanup() {
    if (!this.enabled) {
      return;
    }
    await this.runCleanup();
  }

  async runCleanup(): Promise<CleanupMetrics> {
    const startTime = Date.now();
    this.logger.log('Starting file cleanup...');

    try {
      const ttlMs = this.ttlHours * 60 * 60 * 1000;
      const now = Date.now();
      const cutoffTime = now - ttlMs;

      const folders = await this.getStorageFolders();
      let filesDeleted = 0;
      let foldersDeleted = 0;
      let bytesReclaimed = 0;
      let errors = 0;

      for (const folder of folders) {
        try {
          const folderPath = path.join(this.storagePath, folder);
          const manifestPath = path.join(folderPath, 'manifest.json');

          let createdAt = 0;
          try {
            const manifestContent = await fs.readFile(manifestPath, 'utf-8');
            const manifest = JSON.parse(manifestContent) as {
              createdAt?: number;
            };
            createdAt = manifest.createdAt ?? 0;
          } catch {
            const stats = await fs.stat(folderPath);
            createdAt = stats.mtimeMs;
          }

          if (createdAt < cutoffTime) {
            const { files, bytes } =
              await this.deleteFolderRecursive(folderPath);
            filesDeleted += files;
            bytesReclaimed += bytes;
            foldersDeleted++;

            this.logger.debug(
              `Deleted expired folder: ${folder} (${files} files, ${this.formatBytes(bytes)})`,
            );
          }
        } catch (error) {
          this.logger.error(
            `Error processing folder ${folder}: ${(error as Error).message}`,
          );
          errors++;
        }
      }

      this.metrics = {
        filesDeleted,
        foldersDeleted,
        bytesReclaimed,
        lastRunAt: new Date(),
        errors,
      };

      const duration = Date.now() - startTime;
      this.logger.log(
        `Cleanup completed in ${duration}ms: ${foldersDeleted} folders, ${filesDeleted} files, ${this.formatBytes(bytesReclaimed)} reclaimed`,
      );

      return this.metrics;
    } catch (error) {
      this.logger.error(`Cleanup failed: ${(error as Error).message}`);
      throw error;
    }
  }

  private async getStorageFolders(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.storagePath, {
        withFileTypes: true,
      });
      return entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.logger.warn(`Storage path does not exist: ${this.storagePath}`);
        return [];
      }
      throw error;
    }
  }

  private async deleteFolderRecursive(
    folderPath: string,
  ): Promise<{ files: number; bytes: number }> {
    let files = 0;
    let bytes = 0;

    try {
      const entries = await fs.readdir(folderPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(folderPath, entry.name);

        if (entry.isDirectory()) {
          const result = await this.deleteFolderRecursive(fullPath);
          files += result.files;
          bytes += result.bytes;
        } else {
          const stats = await fs.stat(fullPath);
          bytes += stats.size;
          await fs.unlink(fullPath);
          files++;
        }
      }

      await fs.rmdir(folderPath);
    } catch (error) {
      this.logger.error(
        `Error deleting folder ${folderPath}: ${(error as Error).message}`,
      );
    }

    return { files, bytes };
  }

  getMetrics(): CleanupMetrics {
    return { ...this.metrics };
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
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
}
