import { Injectable } from '@nestjs/common';
import { Context } from 'grammy';
import { BotService } from '../bot.service';

@Injectable()
export class StartCommand {
  constructor(private readonly botService: BotService) {}

  async execute(ctx: Context): Promise<void> {
    await this.botService.sendWelcome(ctx);
  }
}
