import { Injectable, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UrlSigningService } from '@shared';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';

@Injectable()
export class FilesService {
  private readonly storagePath: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly urlSigningService: UrlSigningService,
  ) {
    this.storagePath = this.configService.get<string>(
      'STORAGE_PATH',
      './data/uploads',
    );
  }

  getSignedFile(
    uniqueId: string,
    filename: string,
    expiresAt: number,
    signature: string,
  ): {
    stream: Readable;
    contentType: string;
    actualFilename: string;
  } {
    // Validate signature
    const urlPath = `/api/v2/files/${uniqueId}/${filename}`;
    const validation = this.urlSigningService.validateSignedUrl(
      urlPath,
      expiresAt,
      signature,
    );

    if (!validation.valid) {
      throw new ForbiddenException(validation.reason || 'Invalid signature');
    }

    // Construct file path
    const filePath = path.join(this.storagePath, uniqueId, filename);

    // Security: Prevent path traversal attacks
    const normalizedPath = path.normalize(filePath);
    const normalizedStoragePath = path.normalize(this.storagePath);
    if (!normalizedPath.startsWith(normalizedStoragePath)) {
      throw new Error('Invalid file path');
    }

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      throw new Error('File not found');
    }

    const stream = fs.createReadStream(filePath);
    const contentType = this.getContentType(filename);
    const actualFilename = path.basename(filename);

    return { stream, contentType, actualFilename };
  }

  private getContentType(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    const contentTypes: Record<string, string> = {
      '.mp4': 'video/mp4',
      '.mp3': 'audio/mpeg',
      '.webm': 'video/webm',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.zip': 'application/zip',
    };
    return contentTypes[ext] || 'application/octet-stream';
  }
}
