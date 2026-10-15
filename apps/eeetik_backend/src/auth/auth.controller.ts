import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { Model } from 'mongoose';
import { User } from '@shared';
import type {
  RequestWithAuth,
  TelegramInitUser,
} from '../common/types/authed-request';
import { parseJwtExpiresInSeconds } from './jwt-duration';
import { BotOrMiniAppGuard } from './guards/bot-or-miniapp.guard';
import { TelegramAuthGuard } from './guards/telegram-auth.guard';
import { UpdateUserSettingsDto } from './dto/update-user-settings.dto';

interface PublicUserView {
  telegramId: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  photoUrl?: string;
  isPremium?: boolean;
  settings?: Record<string, unknown>;
}

@Controller('auth')
export class AuthController {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<User>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Exchanges a valid Telegram Mini App initData for a platform JWT.
   * Creates the user record on first login.
   */
  @Post('telegram')
  @UseGuards(TelegramAuthGuard)
  async login(@Req() request: RequestWithAuth) {
    const telegramUser = request.telegramUser as TelegramInitUser;
    const user = await this.upsertUser(telegramUser);
    const accessToken = await this.signAccessToken(user);

    return {
      accessToken,
      tokenType: 'Bearer',
      user: this.toPublicView(user),
    };
  }

  @Get('me')
  @UseGuards(BotOrMiniAppGuard)
  async me(@Req() request: RequestWithAuth) {
    const telegramId = this.requireTelegramUserId(request);
    const user = await this.userModel.findOne({ telegramId }).lean().exec();

    return { user: user ? this.toPublicView(user) : null };
  }

  @Patch('me')
  @UseGuards(BotOrMiniAppGuard)
  async updateMe(
    @Body() payload: UpdateUserSettingsDto,
    @Req() request: RequestWithAuth,
  ) {
    const telegramId = this.requireTelegramUserId(request);
    const telegramUser = request.telegramUser;
    const baseUser =
      (telegramUser && telegramUser.id === telegramId
        ? await this.upsertUser(telegramUser)
        : null) ?? (await this.userModel.findOne({ telegramId }).exec());

    if (!baseUser) {
      throw new NotFoundException('User was not found');
    }

    const mergedSettings: Record<string, unknown> = {
      ...(baseUser.settings ?? {}),
      ...Object.fromEntries(
        Object.entries(payload).filter(([, value]) => value !== undefined),
      ),
    };

    const updated = await this.userModel
      .findOneAndUpdate(
        { telegramId },
        { $set: { settings: mergedSettings } },
        { new: true },
      )
      .lean()
      .exec();

    return { user: updated ? this.toPublicView(updated) : null };
  }

  private requireTelegramUserId(request: RequestWithAuth): number {
    const telegramUserId = request.authContext?.telegramUserId;
    if (typeof telegramUserId !== 'number') {
      throw new NotFoundException('Telegram user context is missing');
    }

    return telegramUserId;
  }

  private async upsertUser(telegramUser: TelegramInitUser): Promise<User> {
    const existing = await this.userModel
      .findOne({ telegramId: telegramUser.id })
      .exec();

    if (existing) {
      existing.username = telegramUser.username ?? existing.username;
      existing.firstName = telegramUser.firstName ?? existing.firstName;
      existing.lastName = telegramUser.lastName ?? existing.lastName;
      existing.photoUrl = telegramUser.photoUrl ?? existing.photoUrl;
      existing.isPremium = telegramUser.isPremium ?? existing.isPremium;
      existing.languageCode =
        telegramUser.languageCode ?? existing.languageCode;
      return existing.save();
    }

    return this.userModel.create({
      telegramId: telegramUser.id,
      username: telegramUser.username,
      firstName: telegramUser.firstName,
      lastName: telegramUser.lastName,
      photoUrl: telegramUser.photoUrl,
      isPremium: telegramUser.isPremium,
      languageCode: telegramUser.languageCode,
      settings: {},
    });
  }

  private async signAccessToken(user: User): Promise<string> {
    const secret =
      this.configService.get<string>('JWT_SECRET') ?? 'insecure-dev-secret';
    const expiresIn = parseJwtExpiresInSeconds(
      this.configService.get<string>('JWT_EXPIRES_IN'),
      parseJwtExpiresInSeconds('7d', 604_800),
    );

    return this.jwtService.signAsync(
      {
        sub: user.telegramId,
        telegramId: user.telegramId,
        username: user.username ?? '',
      },
      { secret, expiresIn },
    );
  }

  private toPublicView(user: User | Record<string, unknown>): PublicUserView {
    const record = user as Record<string, unknown>;
    return {
      telegramId: Number(record.telegramId),
      username: record.username as string | undefined,
      firstName: record.firstName as string | undefined,
      lastName: record.lastName as string | undefined,
      photoUrl: record.photoUrl as string | undefined,
      isPremium: record.isPremium as boolean | undefined,
      settings: (record.settings ?? {}) as Record<string, unknown>,
    };
  }
}
