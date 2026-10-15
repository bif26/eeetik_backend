import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { TelegramInitUser } from '../../common/types/authed-request';
import { TelegramInitDataService } from '../telegram-init-data.service';

/**
 * Guard for endpoints that require a Telegram Mini App identity.
 * Expects header `Authorization: tma <initData>` where `<initData>` is the
 * raw query-string payload provided by the Telegram WebApp environment.
 */
@Injectable()
export class TelegramAuthGuard implements CanActivate {
  constructor(
    private readonly telegramInitDataService: TelegramInitDataService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<Request & { telegramUser?: TelegramInitUser }>();
    const header = request.headers.authorization ?? '';
    const match = /^tma\s+(.+)$/i.exec(header);
    if (!match) {
      throw new UnauthorizedException(
        'Missing `Authorization: tma <initData>` header',
      );
    }

    const user = this.telegramInitDataService.validate(match[1].trim());
    if (!user) {
      throw new UnauthorizedException('Invalid Telegram initData');
    }

    request.telegramUser = user;
    return true;
  }
}
