import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ModuleRef } from '@nestjs/core';
import {
  DownloadRequestType,
  getStructuredLogger,
  TikTokMetadata,
} from '@shared';
import { Bot, Context } from 'grammy';
import type { Model } from 'mongoose';
import { DownloadService } from '../download/services/download.service';
import { DownloadCommand } from './commands/download.command';
import { HelpCommand } from './commands/help.command';
import { StartCommand } from './commands/start.command';
import { BotService } from './bot.service';
import {
  BACK_CALLBACK,
  parseQualityCallbackData,
} from './keyboards/quality.keyboard';
import {
  HELP_MAIN_CALLBACK,
  HELP_PLATFORMS_CALLBACK,
} from './keyboards/main.keyboard';
import { detectPlatform } from './keyboards/platform.keyboard';
import { WebAppService } from './webapp/webapp.service';

const URL_PATTERN = /(https?:\/\/[^\s<>"']+)/i;

@Injectable()
export class BotUpdate {
  private readonly logger = getStructuredLogger('bot');
  private startCommand!: StartCommand;
  private helpCommand!: HelpCommand;
  private downloadCommand!: DownloadCommand;

  constructor(
    private readonly botService: BotService,
    private readonly downloadService: DownloadService,
    private readonly webAppService: WebAppService,
    private readonly moduleRef: ModuleRef,
    @InjectModel(TikTokMetadata.name)
    private readonly tikTokMetadataModel: Model<TikTokMetadata>,
  ) {}

  /** Registers every grammY handler on the bot instance. */
  registerHandlers(bot: Bot): void {
    this.startCommand = this.moduleRef.get(StartCommand, { strict: false });
    this.helpCommand = this.moduleRef.get(HelpCommand, { strict: false });
    this.downloadCommand = this.moduleRef.get(DownloadCommand, {
      strict: false,
    });

    bot.command(
      'start',
      (ctx) => void this.safeHandle(ctx, () => this.startCommand.execute(ctx)),
    );
    bot.command(
      'help',
      (ctx) => void this.safeHandle(ctx, () => this.helpCommand.execute(ctx)),
    );
    bot.command(
      'download',
      (ctx) =>
        void this.safeHandle(ctx, () =>
          this.downloadCommand.execute(
            ctx,
            this.extractUrl(ctx.message?.text ?? '') ?? undefined,
          ),
        ),
    );

    bot.on(
      'callback_query:data',
      (ctx) => void this.safeHandle(ctx, () => this.onCallbackQuery(ctx)),
    );

    bot.on(
      'message:web_app_data',
      (ctx) => void this.safeHandle(ctx, () => this.onWebAppData(ctx)),
    );

    bot.on('message:text', (ctx) => {
      const text = ctx.message?.text ?? '';
      if (text.trim().startsWith('/')) {
        return;
      }

      void this.safeHandle(ctx, () => this.onTextMessage(ctx));
    });

    bot.on('message', (ctx) => {
      // Fallback for non-text messages (photos, stickers, voice…)
      if (ctx.message?.text || ctx.message?.web_app_data) {
        return;
      }

      void this.safeHandle(ctx, async () => {
        await ctx.reply(
          '🤖 I understand TikTok links and commands. Send /help to see what I can do.',
        );
      });
    });
  }

  private async onTextMessage(ctx: Context): Promise<void> {
    const url = this.extractUrl(ctx.message?.text ?? '');
    await this.botService.handleDownloadRequest(ctx, url ?? undefined);
  }

  private async onCallbackQuery(ctx: Context): Promise<void> {
    const data = ctx.callbackQuery?.data ?? '';

    if (data === HELP_MAIN_CALLBACK) {
      await ctx.answerCallbackQuery();
      await this.helpCommand.execute(ctx);
      return;
    }

    if (data === HELP_PLATFORMS_CALLBACK) {
      await ctx.answerCallbackQuery();
      await this.botService.sendPlatformOverview(ctx);
      return;
    }

    if (data === BACK_CALLBACK) {
      await ctx.answerCallbackQuery();
      await this.botService.sendWelcome(ctx);
      return;
    }

    const qualitySelection = parseQualityCallbackData(data);
    if (qualitySelection) {
      await ctx.answerCallbackQuery({ text: 'Queued ⏳' });
      await this.enqueueDownload(
        ctx,
        qualitySelection.uniqueId,
        qualitySelection.quality,
      );
      return;
    }

    await ctx.answerCallbackQuery({ text: 'Unknown action' });
  }

  private async onWebAppData(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    const senderId = ctx.from?.id;
    const rawData = ctx.message?.web_app_data?.data;
    if (!chatId || !senderId) {
      return;
    }

    const payload = this.webAppService.parsePayload(rawData ?? '');
    if (!payload) {
      await this.botService.sendError(
        chatId,
        'I received an empty Mini App payload. Please try again from the Mini App.',
      );
      return;
    }

    const webAppUser = this.webAppService.resolveWebAppUser(payload, senderId);
    if (!webAppUser) {
      await this.botService.sendError(
        chatId,
        'Mini App verification failed. Please reopen the Mini App and try again.',
      );
      return;
    }

    if (payload.uniqueId && payload.requestType) {
      const requestType = this.toRequestType(payload.requestType);
      if (requestType) {
        await this.enqueueDownload(
          ctx,
          payload.uniqueId,
          requestType,
          webAppUser.id,
        );
        return;
      }
    }

    if (payload.url) {
      const platform = detectPlatform(payload.url);
      if (platform === 'tiktok') {
        await this.botService.sendMediaPreviewForUrl(chatId, payload.url);
        return;
      }

      await this.botService.sendError(
        chatId,
        'Only TikTok links are supported right now.',
      );
      return;
    }

    await this.botService.sendMessage(
      chatId,
      '🤖 Unknown Mini App action. Please reopen the Mini App and try again.',
    );
  }

  private async enqueueDownload(
    ctx: Context,
    uniqueId: string,
    requestType: DownloadRequestType,
    telegramUserIdOverride?: number,
  ): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const telegramUserId = telegramUserIdOverride ?? ctx.from?.id;

    try {
      const { jobId } = await this.downloadService.enqueueBotDownload({
        uniqueId,
        requestType,
        chatId,
        telegramUserId,
      });

      await this.botService.sendProcessingMessage(chatId, jobId, requestType);
      this.logger.debug?.('bot.download.enqueued', {
        jobId,
        uniqueId,
        requestType,
        chatId,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown enqueue error';
      await this.botService.sendError(
        chatId,
        `Could not queue the download: ${message}`,
      );
    }
  }

  private toRequestType(raw: string): DownloadRequestType | null {
    const normalized = raw.trim().toLowerCase();
    return Object.values(DownloadRequestType).includes(
      normalized as DownloadRequestType,
    )
      ? (normalized as DownloadRequestType)
      : null;
  }

  private extractUrl(text: string): string | null {
    const match = URL_PATTERN.exec(text.trim());
    return match ? match[1] : null;
  }

  private async safeHandle(
    ctx: Context,
    handler: () => Promise<void>,
  ): Promise<void> {
    try {
      await handler();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('bot.handler.failed', { errorMessage: message });

      // Best-effort user feedback for unexpected failures.
      try {
        if (ctx.chat?.id) {
          await this.botService.sendError(
            ctx.chat.id,
            'Something went wrong while handling your request. Please try again.',
          );
        }
      } catch {
        // ignore – feedback is best effort
      }
    }
  }
}
