import { IsString, IsUrl } from 'class-validator';

export class TikTokMetadataRequestDto {
  @IsString()
  @IsUrl()
  url!: string;
}
