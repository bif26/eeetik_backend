import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import {
  AuthContext,
  TelegramInitUser,
} from '../../common/types/authed-request';
import { TelegramInitDataService } from '../telegram-init-data.service';

interface JwtPayload {
  sub?: number;
  telegramId?: number;
  username?: string;
}

/**
 * Accepts requests authenticated by either:
 * 1. Bot-internal calls: `X-Bot-Secret` header matching BOT_INTERNAL_SECRET
 * 2. Mini App calls: `Authorization: tma <initData>` (Telegram-signed)
 * 3. Mini App JWT issued by `POST /auth/telegram`: `Authorization: Bearer <jwt>`
 *
 * On success attaches `request.authContext` and skips the ad gate
 * (`request.skipAdGate = true`) since the caller is verified.
 */
@Injectable()
export class BotOrMiniAppGuard implements CanActivate {
  constructor(
    private readonly telegramInitDataService: TelegramInitDataService,
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<
      Request & {
        authContext?: AuthContext;
        telegramUser?: TelegramInitUser;
        skipAdGate?: boolean;
      }
    >();

    const botContext = this.tryBotSecret(request);
    if (botContext) {
      request.authContext = botContext;
      request.skipAdGate = true;
      return true;
    }

    const miniAppContext = this.tryMiniAppInitData(request);
    if (miniAppContext) {
      request.authContext = miniAppContext.context;
      request.telegramUser = miniAppContext.user;
      request.skipAdGate = true;
      return true;
    }

    const jwtContext = await this.tryBearerJwt(request);
    if (jwtContext) {
      request.authContext = jwtContext;
      request.skipAdGate = true;
      return true;
    }

    throw new UnauthorizedException(
      'Provide X-Bot-Secret, `Authorization: tma <initData>` or a bearer token issued by POST /auth/telegram',
    );
  }

  private tryBotSecret(request: Request): AuthContext | null {
    const headerValue = request.headers['x-bot-secret'];
    if (typeof headerValue !== 'string' || headerValue.length === 0) {
      return null;
    }

    const expected = this.configService.get<string>('BOT_INTERNAL_SECRET');
    if (!expected || !timingSafeStringsEqual(headerValue, expected)) {
      return null;
    }

    return { type: 'bot' };
  }

  private tryMiniAppInitData(request: Request): {
    context: AuthContext;
    user: TelegramInitUser;
  } | null {
    const header = request.headers.authorization ?? '';
    const match = /^tma\s+(.+)$/i.exec(header);
    if (!match) {
      return null;
    }

    const user = this.telegramInitDataService.validate(match[1].trim());
    if (!user) {
      return null;
    }

    return { context: { type: 'miniapp', telegramUserId: user.id }, user };
  }

  private async tryBearerJwt(request: Request): Promise<AuthContext | null> {
    const header = request.headers.authorization ?? '';
    const match = /^bearer\s+(.+)$/i.exec(header);
    if (!match) {
      return null;
    }

    const jwtSecret = this.configService.get<string>('JWT_SECRET');
    if (!jwtSecret) {
      return null;
    }

    try {
      const payload = await this.jwtService.verifyAsync<JwtPayload>(
        match[1].trim(),
        { secret: jwtSecret },
      );
      const telegramUserId = Number(payload.telegramId ?? payload.sub);
      if (!Number.isFinite(telegramUserId) || telegramUserId <= 0) {
        return null;
      }

      return { type: 'jwt', telegramUserId };
    } catch {
      return null;
    }
  }
}

function timingSafeStringsEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}
