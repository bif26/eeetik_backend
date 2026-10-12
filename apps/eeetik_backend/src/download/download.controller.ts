import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { RequestWithAuth } from '../common/types/authed-request';
import { BotOrMiniAppGuard } from '../auth/guards/bot-or-miniapp.guard';
import { PrepareDownloadDto } from './dto/prepare-download.dto';
import { TikTokMetadataRequestDto } from './dto/tiktok-metadata-request.dto';
import { DownloadService } from './services/download.service';

@Controller('model/download/tiktok')
@UseGuards(BotOrMiniAppGuard)
export class DownloadController {
  constructor(private readonly downloadService: DownloadService) {}

  @Post()
  async getMetadata(
    @Body() payload: TikTokMetadataRequestDto,
    @Req() request: RequestWithAuth,
  ) {
    return this.downloadService.fetchMetadata(payload, request.requestId);
  }

  @Post('prepare')
  async prepareDownload(
    @Body() payload: PrepareDownloadDto,
    @Req() request: RequestWithAuth,
  ) {
    return this.downloadService.prepareDownload(payload, request.requestId, {
      skipAdGate: request.skipAdGate === true,
    });
  }

  @Get('status/:jobId')
  async getStatus(
    @Param('jobId') jobId: string,
    @Req() request: RequestWithAuth,
  ) {
    return this.downloadService.getStatus(jobId, request.requestId);
  }

  @Get('history')
  async getHistory(
    @Query('limit') limit: string | undefined,
    @Req() request: RequestWithAuth,
  ) {
    const parsedLimit = Number(limit);
    return this.downloadService.getDownloadHistory(
      request.authContext ?? { type: 'bot' },
      Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(Math.floor(parsedLimit), 100)
        : 20,
      request.requestId,
    );
  }
}
