import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DEFAULT_TG_FILE_ID_CACHE_TTL_SECONDS,
  REDIS_TG_FILE_PREFIX,
  readRedisCoreOptions,
} from '@shared';
import { Bot, InputFile } from 'grammy';
import Redis from 'ioredis';

export type TelegramUploadType = 'video' | 'audio' | 'document';

export interface TelegramUploadResult {
  fileId: string;
  messageId?: number;
}

interface FileIdCacheRecord {
  fileId: string;
  cachedAt: number;
}

/**
 * Telegram-CDN storage layer (worker side).
 *
 * Replaces the local-disk/signed-URL storage: media is downloaded to a
 * temporary directory, uploaded to the requesting Telegram chat, and only
 * the resulting `file_id` is cached (Upstash Redis) for instant re-delivery.
 */
@Injectable()
export class TelegramStorageService implements OnModuleInit, OnModuleDestroy {
  private readonly consoleLogger = new Logger(TelegramStorageService.name);
  private bot?: Bot;
  private readonly fileCacheTtlSeconds: number;
  private readonly redisClient: Redis;

  constructor(private readonly configService: ConfigService) {
    this.fileCacheTtlSeconds = this.readPositiveIntegerConfig(
      'TELEGRAM_FILE_ID_CACHE_TTL',
      DEFAULT_TG_FILE_ID_CACHE_TTL_SECONDS,
    );

    const connection = readRedisCoreOptions(this.configService);
    this.redisClient = new Redis({
      host: connection.host,
      port: connection.port,
      password: connection.password,
      tls: connection.tls,
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
    });
  }

  onModuleInit(): void {
    const token = this.configService.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) {
      this.consoleLogger.warn(
        'TELEGRAM_BOT_TOKEN is not configured – Telegram uploads are disabled.',
      );
      return;
    }

    this.bot = new Bot(token);
  }

  isConfigured(): boolean {
    return this.bot !== undefined;
  }

  async uploadVideo(
    chatId: number,
    filePath: string,
    caption?: string,
  ): Promise<TelegramUploadResult> {
    return this.upload(chatId, filePath, 'video', caption);
  }

  async uploadAudio(
    chatId: number,
    filePath: string,
    caption?: string,
  ): Promise<TelegramUploadResult> {
    return this.upload(chatId, filePath, 'audio', caption);
  }

  async uploadDocument(
    chatId: number,
    filePath: string,
    caption?: string,
  ): Promise<TelegramUploadResult> {
    return this.upload(chatId, filePath, 'document', caption);
  }

  async sendFileByFileId(
    chatId: number,
    fileId: string,
    type: TelegramUploadType,
    caption?: string,
  ): Promise<TelegramUploadResult | null> {
    if (!this.bot) {
      this.consoleLogger.warn('sendFileByFileId skipped – bot not configured.');
      return null;
    }

    const options = { caption };
    if (type === 'video') {
      const message = await this.bot.api.sendVideo(chatId, fileId, {
        ...options,
        supports_streaming: true,
      });
      return {
        fileId: message.video?.file_id ?? fileId,
        messageId: message.message_id,
      };
    }

    if (type === 'audio') {
      const message = await this.bot.api.sendAudio(chatId, fileId, options);
      return {
        fileId: message.audio?.file_id ?? fileId,
        messageId: message.message_id,
      };
    }

    const message = await this.bot.api.sendDocument(chatId, fileId, options);
    return {
      fileId: message.document?.file_id ?? fileId,
      messageId: message.message_id,
    };
  }

  async cacheFileId(
    uniqueId: string,
    quality: string,
    fileId: string,
  ): Promise<void> {
    const record: FileIdCacheRecord = { fileId, cachedAt: Date.now() };
    try {
      await this.redisClient.set(
        this.getCacheKey(uniqueId, quality),
        JSON.stringify(record),
        'EX',
        this.fileCacheTtlSeconds,
      );
    } catch (error) {
      this.consoleLogger.warn(
        `file_id cache write failed for ${uniqueId}:${quality}: ${this.toErrorMessage(error)}`,
      );
    }
  }

  async getCachedFileId(
    uniqueId: string,
    quality: string,
  ): Promise<string | null> {
    try {
      const raw = await this.redisClient.get(
        this.getCacheKey(uniqueId, quality),
      );
      if (!raw) {
        return null;
      }

      const record = JSON.parse(raw) as Partial<FileIdCacheRecord>;
      return typeof record.fileId === 'string' ? record.fileId : null;
    } catch {
      return null;
    }
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    if (!this.bot) {
      return;
    }

    try {
      await this.bot.api.sendMessage(chatId, text);
    } catch (error) {
      this.consoleLogger.warn(
        `Failed to send Telegram message to ${chatId}: ${this.toErrorMessage(error)}`,
      );
    }
  }

  async sendError(chatId: number, message: string): Promise<void> {
    await this.sendMessage(chatId, `⚠️ ${message}`);
  }

  private async upload(
    chatId: number,
    filePath: string,
    type: TelegramUploadType,
    caption?: string,
  ): Promise<TelegramUploadResult> {
    if (!this.bot) {
      throw new Error(
        'TelegramStorageService is not configured (TELEGRAM_BOT_TOKEN missing)',
      );
    }

    const input = new InputFile(filePath);
    const options = { caption };

    if (type === 'video') {
      const message = await this.bot.api.sendVideo(chatId, input, {
        ...options,
        supports_streaming: true,
      });
      return this.extractResult(message, 'video', filePath);
    }

    if (type === 'audio') {
      const message = await this.bot.api.sendAudio(chatId, input, options);
      return this.extractResult(message, 'audio', filePath);
    }

    const message = await this.bot.api.sendDocument(chatId, input, options);
    return this.extractResult(message, 'document', filePath);
  }

  private extractResult(
    message: { message_id: number } & object,
    type: TelegramUploadType,
    filePath: string,
  ): TelegramUploadResult {
    const raw = message as Record<string, unknown>;
    let fileId: string | undefined;
    if (type === 'video') {
      fileId = (raw.video as { file_id?: string } | undefined)?.file_id;
    } else if (type === 'audio') {
      fileId = (raw.audio as { file_id?: string } | undefined)?.file_id;
    } else {
      fileId = (raw.document as { file_id?: string } | undefined)?.file_id;
    }

    if (!fileId) {
      throw new Error(
        `Telegram upload for ${filePath} did not return a file_id (${type})`,
      );
    }

    return { fileId, messageId: message.message_id };
  }

  private getCacheKey(uniqueId: string, quality: string): string {
    return `${REDIS_TG_FILE_PREFIX}${uniqueId}:${quality}`;
  }

  private readPositiveIntegerConfig(
    key: string,
    fallbackValue: number,
  ): number {
    const raw = this.configService.get<string>(key);
    if (raw === undefined || raw.trim().length === 0) {
      return fallbackValue;
    }

    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return fallbackValue;
    }

    return Math.floor(parsed);
  }

  private toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redisClient.status !== 'end') {
      try {
        await this.redisClient.quit();
      } catch {
        this.redisClient.disconnect();
      }
    }
  }
}
