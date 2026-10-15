import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { ModuleRef } from '@nestjs/core';
import { Model } from 'mongoose';
import {
  DownloadRequestType,
  getStructuredLogger,
  PostType,
  TikTokMetadata,
} from '@shared';
import { Bot, Context, InlineKeyboard, InputFile } from 'grammy';
import type { Update } from 'grammy/types';
import { TikTokPreviewData } from '../download/interfaces/tiktok-preview-response.interface';
import { DownloadService } from '../download/services/download.service';
import { BotUpdate } from './bot.update';
import { buildMainKeyboard } from './keyboards/main.keyboard';
import {
  buildPlatformKeyboard,
  detectPlatform,
} from './keyboards/platform.keyboard';
import { buildQualityKeyboard } from './keyboards/quality.keyboard';

export type BotMediaType = 'video' | 'audio' | 'document';

export interface BotMediaSource {
  fileId?: string;
  filePath?: string;
  caption?: string;
}

export interface BotMediaPreviewPayload {
  uniqueId: string;
  postType: PostType;
  title?: string;
  authorName?: string;
  authorAvatarUrl?: string;
  thumbnailUrl?: string;
  imageUrls?: string[];
  statsLine?: string;
  hashtagsLine?: string;
  duration?: number;
  sourceUrl?: string;
}

const BOT_COMMANDS_TEXT = [
  '/start – open the downloader and the Mini App',
  '/help – show supported platforms and commands',
  '/download &lt;url&gt; – fetch a TikTok link directly',
  '',
  'Or simply paste any TikTok link and pick a quality.',
].join('\n');

@Injectable()
export class BotService implements OnModuleInit, OnModuleDestroy {
  private bot?: Bot;
  private webhookMode = false;
  private readonly consoleLogger = new Logger(BotService.name);
  private readonly logger = getStructuredLogger('bot');

  constructor(
    private readonly configService: ConfigService,
    private readonly moduleRef: ModuleRef,
    private readonly downloadService: DownloadService,
    @InjectModel(TikTokMetadata.name)
    private readonly tikTokMetadataModel: Model<TikTokMetadata>,
  ) {}

  async onModuleInit(): Promise<void> {
    const token = this.configService.get<string>('TELEGRAM_BOT_TOKEN');
    const enabled = this.readBooleanFlag('ENABLE_TELEGRAM_BOT', true);

    if (!token) {
      this.consoleLogger.warn(
        'TELEGRAM_BOT_TOKEN is not configured – Telegram bot is disabled.',
      );
      return;
    }

    if (!enabled) {
      this.consoleLogger.log(
        'ENABLE_TELEGRAM_BOT=false – Telegram bot is disabled.',
      );
      return;
    }

    if (!this.shouldRunBotOnThisDyno()) {
      this.consoleLogger.log(
        `Heroku dyno ${String(process.env.DYNO)} – Telegram bot runs on the web dyno only.`,
      );
      return;
    }

    this.bot = new Bot(token);
    this.bot.catch((botError) => {
      const error = botError?.error;
      const message =
        error instanceof Error ? error.message : 'unknown bot error';
      this.logger.error('bot.update.failed', { errorMessage: message });
    });

    // Resolve lazily to keep BotService <-> BotUpdate free of constructor cycles.
    const botUpdate = this.moduleRef.get(BotUpdate, { strict: false });
    botUpdate.registerHandlers(this.bot);

    const webhookUrl = this.resolveWebhookUrl();
    if (webhookUrl) {
      const secretToken =
        this.configService.get<string>('TELEGRAM_WEBHOOK_SECRET') ?? undefined;
      await this.bot.init();
      await this.bot.api.setWebhook(webhookUrl, {
        secret_token: secretToken,
        allowed_updates: ['message', 'callback_query'],
        drop_pending_updates: false,
      });
      this.webhookMode = true;
      this.consoleLogger.log(
        `Telegram bot running in webhook mode: ${webhookUrl}`,
      );
      return;
    }

    void this.bot
      .start({
        drop_pending_updates: true,
        onStart: (me) => {
          this.consoleLogger.log(
            `Telegram bot polling started as @${me.username}`,
          );
        },
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error('bot.polling.failed', { errorMessage: message });
      });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.bot && !this.webhookMode) {
      await this.bot.stop().catch(() => undefined);
    }
  }

  isConfigured(): boolean {
    return this.bot !== undefined;
  }

  /** Entry point for webhook updates routed by BotController. */
  async handleUpdate(update: Update): Promise<void> {
    if (!this.bot) {
      throw new ServiceUnavailableException('Telegram bot is not configured');
    }

    await this.bot.handleUpdate(update);
  }

  async sendWelcome(ctx: Context): Promise<void> {
    const name = ctx.from?.first_name ?? 'there';
    const miniAppUrl = this.readMiniAppUrl();
    const text = [
      `👋 Hi ${name}!`,
      '',
      'I download TikTok videos, audio and image galleries in original quality — no watermark.',
      '',
      '👉 Paste a TikTok link to get started, or open the Mini App:',
    ].join('\n');

    await ctx.reply(text, {
      reply_markup: buildMainKeyboard(miniAppUrl),
    });
  }

  async sendHelp(ctx: Context): Promise<void> {
    const text = [
      '📖 <b>eeetik downloader bot</b>',
      '',
      BOT_COMMANDS_TEXT,
    ].join('\n');

    await ctx
      .reply(text, { parse_mode: 'HTML' })
      .catch(() =>
        ctx.reply('📖 Send me any TikTok link and I will fetch it for you.'),
      );
  }

  async sendPlatformOverview(ctx: Context): Promise<void> {
    const miniAppUrl = this.readMiniAppUrl();
    const text = [
      '🌍 Supported platforms',
      '',
      '✅ TikTok – videos (HD/SD, no watermark), audio and image galleries',
      '🔜 YouTube – coming soon',
    ].join('\n');

    await ctx.reply(text, { reply_markup: buildPlatformKeyboard(miniAppUrl) });
  }

  /** Shared handler for `/download <url>` and plain-text URL messages. */
  async handleDownloadRequest(ctx: Context, url?: string): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    if (!url) {
      await ctx.reply(
        'Send me a link like:\n/download https://www.tiktok.com/@user/video/123',
      );
      return;
    }

    const platform = detectPlatform(url.trim());
    if (platform === 'youtube') {
      await ctx.reply(
        '🔜 YouTube support is coming soon. For now I can only process TikTok links.',
      );
      return;
    }

    if (platform !== 'tiktok') {
      await ctx.reply(
        '🤔 That does not look like a TikTok link. Please send a tiktok.com URL.',
      );
      return;
    }

    await this.sendMediaPreviewForUrl(chatId, url.trim());
  }

  /** Fetches metadata for a TikTok URL and posts the preview + quality keyboard. */
  async sendMediaPreviewForUrl(chatId: number, url: string): Promise<void> {
    const statusMessage = await this.sendMessage(
      chatId,
      '🔍 Fetching metadata…',
    );

    try {
      const previewResponse = await this.downloadService.fetchMetadata({ url });
      if (!previewResponse?.success || !previewResponse.data) {
        throw new Error('Metadata response was not successful');
      }

      const payload = await this.toPreviewPayload(previewResponse.data);
      await this.sendMediaPreview(chatId, payload);
      await this.sendQualityKeyboard(
        chatId,
        payload.uniqueId,
        payload.postType,
      );

      if (statusMessage) {
        await this.editMessage(
          chatId,
          statusMessage.message_id,
          '✅ Choose what you want to download:',
        );
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown metadata error';
      this.logger.warn('bot.metadata.failed', {
        chatId,
        errorMessage: message,
      });
      await this.sendError(
        chatId,
        'I could not read that TikTok link. It may be private, deleted, or region-locked. Please try another link.',
      );
    }
  }

  /** Enriches API preview data with the persisted original TikTok CDN URLs. */
  async toPreviewPayload(
    preview: TikTokPreviewData,
  ): Promise<BotMediaPreviewPayload> {
    const metadata = await this.tikTokMetadataModel
      .findOne({ uniqueId: preview.uniqueId })
      .lean()
      .exec();

    const statsLine = this.buildStatsLine(preview);
    const hashtagsLine = preview.hashtags?.length
      ? preview.hashtags.slice(0, 8).join(' ')
      : undefined;

    return {
      uniqueId: preview.uniqueId,
      postType: preview.type,
      title: preview.title || metadata?.title,
      authorName: preview.author?.nickname || metadata?.authorName,
      authorAvatarUrl: metadata?.authorAvatarUrl,
      thumbnailUrl:
        metadata?.thumbnailUrl ??
        (preview.type === PostType.VIDEO
          ? (preview.thumbnail ?? undefined)
          : undefined),
      imageUrls:
        preview.type === PostType.IMAGE
          ? metadata?.originalImageUrls?.length
            ? metadata.originalImageUrls
            : preview.images
          : undefined,
      statsLine,
      hashtagsLine,
      duration: preview.type === PostType.VIDEO ? preview.duration : undefined,
      sourceUrl: metadata?.sourceUrl,
    };
  }

  async sendMediaPreview(
    chatId: number,
    payload: BotMediaPreviewPayload,
  ): Promise<void> {
    const caption = this.buildPreviewCaption(payload);
    const photoUrl =
      payload.thumbnailUrl ?? payload.imageUrls?.[0] ?? payload.authorAvatarUrl;

    try {
      if (photoUrl) {
        await this.bot?.api.sendPhoto(chatId, photoUrl, { caption });
        return;
      }
    } catch (error) {
      this.logger.warn('bot.preview.photo_failed', {
        chatId,
        uniqueId: payload.uniqueId,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }

    await this.sendMessage(chatId, caption);
  }

  async sendQualityKeyboard(
    chatId: number,
    uniqueId: string,
    postType: PostType,
  ): Promise<void> {
    const keyboard = buildQualityKeyboard(postType, uniqueId);
    await this.bot?.api.sendMessage(chatId, '👇 Choose what to download:', {
      reply_markup: keyboard,
    });
  }

  async sendProcessingMessage(
    chatId: number,
    jobId: string,
    requestType?: DownloadRequestType,
  ): Promise<void> {
    const label = this.requestTypeLabel(requestType);
    await this.sendMessage(
      chatId,
      [
        `⏳ Preparing ${label}…`,
        '',
        `Job: ${jobId}`,
        'I will send the file here as soon as it is ready.',
      ].join('\n'),
    );
  }

  async sendMediaFile(
    chatId: number,
    source: BotMediaSource,
    type: BotMediaType,
  ): Promise<void> {
    if (!this.bot) {
      this.consoleLogger.warn('sendMediaFile skipped – bot is not configured.');
      return;
    }

    const input =
      source.fileId ??
      (source.filePath ? new InputFile(source.filePath) : undefined);
    if (!input) {
      throw new Error('sendMediaFile requires fileId or filePath');
    }

    const options = { caption: source.caption };
    if (type === 'video') {
      await this.bot.api.sendVideo(chatId, input, {
        ...options,
        supports_streaming: true,
      });
      return;
    }

    if (type === 'audio') {
      await this.bot.api.sendAudio(chatId, input, options);
      return;
    }

    await this.bot.api.sendDocument(chatId, input, options);
  }

  async sendError(chatId: number, message: string): Promise<void> {
    await this.sendMessage(chatId, `⚠️ ${message}`);
  }

  async editMessage(
    chatId: number,
    messageId: number,
    text: string,
  ): Promise<void> {
    try {
      await this.bot?.api.editMessageText(chatId, messageId, text);
    } catch {
      // Ignore "message is not modified" and similar benign failures
    }
  }

  async sendMessage(
    chatId: number,
    text: string,
    replyMarkup?: InlineKeyboard,
  ): Promise<{ message_id: number } | null> {
    if (!this.bot) {
      this.consoleLogger.warn('sendMessage skipped – bot is not configured.');
      return null;
    }

    try {
      return await this.bot.api.sendMessage(chatId, text, {
        reply_markup: replyMarkup,
      });
    } catch (error) {
      this.logger.warn('bot.send_message_failed', {
        chatId,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private buildStatsLine(preview: TikTokPreviewData): string | undefined {
    const stats = preview.stats;
    if (!stats) {
      return undefined;
    }

    const parts: string[] = [];
    if (stats.views && stats.views !== '0') {
      parts.push(`👁 ${stats.views}`);
    }
    if (stats.likes && stats.likes !== '0') {
      parts.push(`❤️ ${stats.likes}`);
    }
    if (stats.comments && stats.comments !== '0') {
      parts.push(`💬 ${stats.comments}`);
    }
    if (stats.shares && stats.shares !== '0') {
      parts.push(`🔁 ${stats.shares}`);
    }

    return parts.length > 0 ? parts.join('  ') : undefined;
  }

  private buildPreviewCaption(payload: BotMediaPreviewPayload): string {
    const lines: string[] = [];

    if (payload.title && payload.title.trim().length > 0) {
      lines.push(this.truncate(payload.title.trim(), 350));
      lines.push('');
    }

    if (payload.authorName) {
      lines.push(`👤 ${payload.authorName}`);
    }

    if (payload.statsLine) {
      lines.push(payload.statsLine);
    }

    if (payload.duration) {
      lines.push(`⏱ ${Math.round(payload.duration)}s`);
    }

    if (payload.hashtagsLine) {
      lines.push(this.truncate(payload.hashtagsLine, 120));
    }

    lines.push('');
    lines.push('Select a format below 👇');

    return lines.join('\n');
  }

  private requestTypeLabel(requestType?: DownloadRequestType): string {
    switch (requestType) {
      case DownloadRequestType.HD:
        return 'HD video';
      case DownloadRequestType.SD:
        return 'SD video';
      case DownloadRequestType.AUDIO:
        return 'audio (MP3)';
      case DownloadRequestType.ZIP:
        return 'image gallery (ZIP)';
      default:
        return 'media file';
    }
  }

  private truncate(value: string, maxLength: number): string {
    return value.length > maxLength
      ? `${value.slice(0, maxLength - 1)}…`
      : value;
  }

  private readMiniAppUrl(): string | undefined {
    const miniAppUrl = this.configService
      .get<string>('TELEGRAM_MINI_APP_URL')
      ?.trim();
    return miniAppUrl || undefined;
  }

  /**
   * Heroku exposes shared config vars to every dyno of the app. The bot must
   * only run on the `web` dyno, otherwise a `worker` dyno would join the same
   * polling loop / overwrite the webhook (Telegram answers 409 conflicts).
   * Outside Heroku (Render, local dev) there is no DYNO variable and the
   * ENABLE_TELEGRAM_BOT flag alone stays in control.
   */
  private shouldRunBotOnThisDyno(): boolean {
    const dyno = process.env.DYNO?.trim();
    if (!dyno) {
      return true;
    }
    return dyno.startsWith('web');
  }

  private readBooleanFlag(key: string, fallbackValue: boolean): boolean {
    const raw = this.configService.get<string>(key);
    if (raw === undefined || raw.trim().length === 0) {
      return fallbackValue;
    }

    return !['false', '0', 'off', 'no'].includes(raw.trim().toLowerCase());
  }

  private resolveWebhookUrl(): string | undefined {
    const explicit = this.configService
      .get<string>('TELEGRAM_WEBHOOK_URL')
      ?.trim();
    if (explicit) {
      return explicit;
    }

    const renderExternalUrl = this.configService
      .get<string>('RENDER_EXTERNAL_URL')
      ?.trim();
    if (renderExternalUrl) {
      const base = renderExternalUrl.replace(/\/+$/, '');
      const prefix = this.configService.get<string>('API_PREFIX', 'api/v2');
      return `${base}/${prefix}/bot/webhook`;
    }

    return undefined;
  }
}
