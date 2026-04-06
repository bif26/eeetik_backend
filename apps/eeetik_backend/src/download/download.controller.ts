import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { SiteDomainGuard } from '../common/guards/site-domain.guard';
import { PrepareDownloadDto } from './dto/prepare-download.dto';
import { TikTokMetadataRequestDto } from './dto/tiktok-metadata-request.dto';
import { DownloadService } from './services/download.service';

type RequestWithId = Request & { requestId?: string };

@Controller('model/download/tiktok')
@UseGuards(SiteDomainGuard)
export class DownloadController {
  constructor(private readonly downloadService: DownloadService) {}

  @Post()
  async getMetadata(
    @Body() payload: TikTokMetadataRequestDto,
    @Req() request: RequestWithId,
  ) {
    return this.downloadService.fetchMetadata(payload, request.requestId);
  }

  @Post('prepare')
  async prepareDownload(
    @Body() payload: PrepareDownloadDto,
    @Req() request: RequestWithId,
  ) {
    return this.downloadService.prepareDownload(payload, request.requestId);
  }

  @Get('status/:jobId')
  async getStatus(
    @Param('jobId') jobId: string,
    @Req() request: RequestWithId,
  ) {
    return this.downloadService.getStatus(jobId, request.requestId);
  }
}
