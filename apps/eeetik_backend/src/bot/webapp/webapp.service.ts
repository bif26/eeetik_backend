import { Injectable } from '@nestjs/common';
import { TelegramInitDataService } from '../../auth/telegram-init-data.service';
import { TelegramInitUser } from '../../common/types/authed-request';

export interface WebAppPayload {
  action?: string;
  url?: string;
  uniqueId?: string;
  requestType?: string;
  initData?: string;
}

/**
 * Parses and verifies payloads the Mini App forwards through Telegram's
 * `web_app_data` channel. When the payload embeds `initData` it is validated
 * against the bot token and must match the sending Telegram user.
 */
@Injectable()
export class WebAppService {
  constructor(
    private readonly telegramInitDataService: TelegramInitDataService,
  ) {}

  parsePayload(rawData: string): WebAppPayload | null {
    if (!rawData || rawData.length === 0) {
      return null;
    }

    try {
      const parsed = JSON.parse(rawData) as Record<string, unknown>;
      return {
        action: typeof parsed.action === 'string' ? parsed.action : undefined,
        url: typeof parsed.url === 'string' ? parsed.url : undefined,
        uniqueId:
          typeof parsed.uniqueId === 'string' ? parsed.uniqueId : undefined,
        requestType:
          typeof parsed.requestType === 'string'
            ? parsed.requestType
            : undefined,
        initData:
          typeof parsed.initData === 'string' ? parsed.initData : undefined,
      };
    } catch {
      // Mini App may send a plain URL instead of JSON
      const trimmed = rawData.trim();
      if (/^https?:\/\//i.test(trimmed)) {
        return { action: 'download', url: trimmed };
      }

      return null;
    }
  }

  /**
   * Returns the verified Telegram user for the payload, or null when the
   * embedded initData is present but invalid or belongs to another user.
   * When no initData is embedded the (Telegram-authenticated) message
   * sender is trusted.
   */
  resolveWebAppUser(
    payload: WebAppPayload,
    senderId: number,
  ): TelegramInitUser | null {
    if (!payload.initData) {
      return { id: senderId };
    }

    const verified = this.telegramInitDataService.validate(payload.initData);
    if (!verified || verified.id !== senderId) {
      return null;
    }

    return verified;
  }
}
