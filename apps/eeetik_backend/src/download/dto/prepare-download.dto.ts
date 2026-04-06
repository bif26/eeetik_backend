import { DownloadRequestType } from '@shared';
import { IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class PrepareDownloadDto {
  @IsString()
  uniqueId!: string;

  @IsEnum(DownloadRequestType)
  requestType!: DownloadRequestType;

  @IsString()
  adToken!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  adDurationSeconds?: number;
}
