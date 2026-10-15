import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { User, UserSchema } from '@shared';
import { AuthController } from './auth.controller';
import { parseJwtExpiresInSeconds } from './jwt-duration';
import { BotOrMiniAppGuard } from './guards/bot-or-miniapp.guard';
import { TelegramAuthGuard } from './guards/telegram-auth.guard';
import { TelegramInitDataService } from './telegram-init-data.service';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET') ?? undefined,
        signOptions: {
          expiresIn: parseJwtExpiresInSeconds(
            configService.get<string>('JWT_EXPIRES_IN'),
            604_800,
          ),
        },
      }),
    }),
    MongooseModule.forFeature([
      {
        name: User.name,
        schema: UserSchema,
      },
    ]),
  ],
  controllers: [AuthController],
  providers: [TelegramInitDataService, TelegramAuthGuard, BotOrMiniAppGuard],
  exports: [
    TelegramInitDataService,
    TelegramAuthGuard,
    BotOrMiniAppGuard,
    JwtModule,
  ],
})
export class AuthModule {}
