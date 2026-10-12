import { Injectable } from '@nestjs/common';
import { Context } from 'grammy';
import { BotService } from '../bot.service';

@Injectable()
export class DownloadCommand {
  constructor(private readonly botService: BotService) {}

  async execute(ctx: Context, url?: string): Promise<void> {
    await this.botService.handleDownloadRequest(ctx, url);
  }
}
