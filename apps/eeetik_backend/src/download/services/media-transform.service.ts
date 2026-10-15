import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import sharp from 'sharp';

@Injectable()
export class MediaTransformService {
  constructor(private readonly httpService: HttpService) {}

  async downloadAsBuffer(url: string): Promise<Buffer> {
    const response = await firstValueFrom(
      this.httpService.get<ArrayBuffer>(url, {
        responseType: 'arraybuffer',
      }),
    );

    return Buffer.from(response.data);
  }

  async downloadAndConvertToWebp(url: string, width?: number): Promise<Buffer> {
    const sourceBuffer = await this.downloadAsBuffer(url);
    const transformer = sharp(sourceBuffer).webp({ quality: 82 });
    if (width) {
      transformer.resize({ width, withoutEnlargement: true });
    }

    return transformer.toBuffer();
  }
}
