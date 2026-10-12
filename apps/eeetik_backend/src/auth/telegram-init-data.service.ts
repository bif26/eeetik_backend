import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { TelegramInitUser } from '../common/types/authed-request';

const WEB_APP_DATA_SALT = 'WebAppData';
const DEFAULT_MAX_AUTH_AGE_SECONDS = 86_400;

interface ValidateOptions {
  maxAgeSeconds?: number;
  now?: Date;
}

/**
 * Validates Telegram Mini App `initData` payloads using the official
 * HMAC-SHA256 verification scheme:
 *
 *   secretKey       = HMAC_SHA256(key='WebAppData', data=<bot token>)
 *   computedHash    = HMAC_SHA256(key=secretKey, data=dataCheckString)
 *   dataCheckString = sorted `key=value` lines (excluding `hash`/`signature`)
 *
 * See https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
@Injectable()
export class TelegramInitDataService {
  private readonly logger = new Logger(TelegramInitDataService.name);

  constructor(private readonly configService: ConfigService) {}

  validate(
    initDataRaw: string,
    options?: ValidateOptions,
  ): TelegramInitUser | null {
    const botToken = this.configService.get<string>('TELEGRAM_BOT_TOKEN');
    if (!botToken || !initDataRaw || initDataRaw.trim().length === 0) {
      return null;
    }

    let params: URLSearchParams;
    try {
      params = new URLSearchParams(initDataRaw);
    } catch {
      return null;
    }

    const hash = params.get('hash');
    if (!hash) {
      return null;
    }

    params.delete('hash');
    params.delete('signature');

    const dataCheckString = [...params.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

    const secretKey = createHmac('sha256', WEB_APP_DATA_SALT)
      .update(botToken)
      .digest();
    const computedHash = createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    if (!timingSafeEquals(computedHash, hash.toLowerCase())) {
      this.logger.warn('telegram.init_data.hash_mismatch');
      return null;
    }

    const maxAgeSeconds =
      options?.maxAgeSeconds ??
      this.readMaxAuthAgeSeconds(DEFAULT_MAX_AUTH_AGE_SECONDS);
    const authDate = Number(params.get('auth_date'));
    const nowSeconds = Math.floor(
      (options?.now?.getTime() ?? Date.now()) / 1000,
    );
    if (!Number.isFinite(authDate) || nowSeconds - authDate > maxAgeSeconds) {
      this.logger.warn('telegram.init_data.auth_date_expired');
      return null;
    }

    const userRaw = params.get('user');
    if (!userRaw) {
      return null;
    }

    try {
      const parsed = JSON.parse(userRaw) as Record<string, unknown>;
      const id = Number(parsed.id);
      if (!Number.isFinite(id) || id <= 0) {
        return null;
      }

      const user: TelegramInitUser = { id };
      if (typeof parsed.first_name === 'string') {
        user.firstName = parsed.first_name;
      }
      if (typeof parsed.last_name === 'string') {
        user.lastName = parsed.last_name;
      }
      if (typeof parsed.username === 'string') {
        user.username = parsed.username;
      }
      if (typeof parsed.language_code === 'string') {
        user.languageCode = parsed.language_code;
      }
      if (typeof parsed.photo_url === 'string') {
        user.photoUrl = parsed.photo_url;
      }
      if (parsed.is_premium === true) {
        user.isPremium = true;
      }

      return user;
    } catch {
      this.logger.warn('telegram.init_data.user_parse_failed');
      return null;
    }
  }

  private readMaxAuthAgeSeconds(fallbackValue: number): number {
    const raw = this.configService.get<string>(
      'TELEGRAM_INIT_DATA_MAX_AGE_SECONDS',
    );
    if (raw === undefined || raw.trim().length === 0) {
      return fallbackValue;
    }

    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return fallbackValue;
    }

    return Math.floor(parsed);
  }
}

function timingSafeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}
