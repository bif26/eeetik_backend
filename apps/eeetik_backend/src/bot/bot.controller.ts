import {
  Body,
  Controller,
  ForbiddenException,
  Headers,
  Post,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Update } from 'grammy/types';
import { BotService } from './bot.service';

/**
 * Receives Telegram webhook updates. Only enabled when the bot runs in
 * webhook mode; the secret token check mirrors Telegram's
 * `X-Telegram-Bot-Api-Secret-Token` header.
 */
@Controller('bot')
export class BotController {
  constructor(
    private readonly botService: BotService,
    private readonly configService: ConfigService,
  ) {}

  @Post('webhook')
  async onWebhookUpdate(
    @Headers('x-telegram-bot-api-secret-token') secretToken: string | undefined,
    @Body() update: Update,
  ): Promise<{ ok: true }> {
    const expectedSecret = this.configService
      .get<string>('TELEGRAM_WEBHOOK_SECRET')
      ?.trim();

    if (expectedSecret && secretToken !== expectedSecret) {
      throw new ForbiddenException('Invalid webhook secret token');
    }

    await this.botService.handleUpdate(update);
    return { ok: true };
  }
}
