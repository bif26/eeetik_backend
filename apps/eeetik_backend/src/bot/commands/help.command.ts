import { Injectable } from '@nestjs/common';
import { Context } from 'grammy';
import { BotService } from '../bot.service';

@Injectable()
export class HelpCommand {
  constructor(private readonly botService: BotService) {}

  async execute(ctx: Context): Promise<void> {
    await this.botService.sendHelp(ctx);
  }
}
