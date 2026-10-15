import { DownloadRequestType } from '@shared';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class UpdateUserSettingsDto {
  @IsOptional()
  @IsEnum(DownloadRequestType)
  defaultQuality?: DownloadRequestType;

  @IsOptional()
  @IsBoolean()
  notifications?: boolean;

  @IsOptional()
  @IsBoolean()
  autoSendToChat?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  language?: string;
}
