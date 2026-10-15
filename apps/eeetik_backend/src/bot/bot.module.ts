import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TikTokMetadata, TikTokMetadataSchema } from '@shared';
import { AuthModule } from '../auth/auth.module';
import { DownloadModule } from '../download/download.module';
import { BotController } from './bot.controller';
import { BotService } from './bot.service';
import { BotUpdate } from './bot.update';
import { DownloadCommand } from './commands/download.command';
import { HelpCommand } from './commands/help.command';
import { StartCommand } from './commands/start.command';
import { WebAppService } from './webapp/webapp.service';

@Module({
  imports: [
    AuthModule,
    DownloadModule,
    MongooseModule.forFeature([
      {
        name: TikTokMetadata.name,
        schema: TikTokMetadataSchema,
      },
    ]),
  ],
  controllers: [BotController],
  providers: [
    BotService,
    BotUpdate,
    StartCommand,
    HelpCommand,
    DownloadCommand,
    WebAppService,
  ],
  exports: [BotService],
})
export class BotModule {}
