import { ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DownloadRequestType } from '@shared';
import { PrepareDownloadDto } from '../dto/prepare-download.dto';

@Injectable()
export class AdGateService {
  private readonly minimumAdDurations: Record<DownloadRequestType, number>;

  constructor(private readonly configService: ConfigService) {
    this.minimumAdDurations = {
      [DownloadRequestType.HD]: Number(
        this.configService.get<string>('AD_HD_MIN_SECONDS', '30'),
      ),
      [DownloadRequestType.SD]: Number(
        this.configService.get<string>('AD_SD_MIN_SECONDS', '15'),
      ),
      [DownloadRequestType.AUDIO]: Number(
        this.configService.get<string>('AD_AUDIO_MIN_SECONDS', '10'),
      ),
      [DownloadRequestType.ZIP]: Number(
        this.configService.get<string>('AD_ZIP_MIN_SECONDS', '20'),
      ),
    };
  }

  assertAccess(payload: PrepareDownloadDto): void {
    if (!payload.adToken.trim()) {
      throw new ForbiddenException('Missing ad verification token');
    }

    const minimumDuration = this.minimumAdDurations[payload.requestType];
    const watchedSeconds = payload.adDurationSeconds ?? 0;

    if (watchedSeconds < minimumDuration) {
      throw new ForbiddenException(
        `Ad watch time is below policy for ${payload.requestType}. Required: ${minimumDuration}s`,
      );
    }
  }
}
