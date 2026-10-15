import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UrlSigningService } from '@shared';
import { PassThrough, Readable } from 'node:stream';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

@Injectable()
export class WorkerObjectStorageService {
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

  async putBuffer(
    uniqueId: string,
    filename: string,
    body: Buffer,
  ): Promise<number> {
    const filePath = this.getFilePath(uniqueId, filename);
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, body);
    return body.byteLength;
  }

  async putStream(
    uniqueId: string,
    filename: string,
    body: Readable,
  ): Promise<number> {
    const filePath = this.getFilePath(uniqueId, filename);
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    let uploadedBytes = 0;
    const countingStream = new PassThrough();
    body.on('data', (chunk: Buffer | Uint8Array | string) => {
      uploadedBytes += this.readChunkByteLength(chunk);
    });
    body.pipe(countingStream);

    const writeStream = (await import('node:fs')).createWriteStream(filePath);
    return new Promise((resolve, reject) => {
      countingStream.pipe(writeStream);
      writeStream.on('finish', () => resolve(uploadedBytes));
      writeStream.on('error', reject);
      countingStream.on('error', reject);
    });
  }

  async getBuffer(uniqueId: string, filename: string): Promise<Buffer> {
    const filePath = this.getFilePath(uniqueId, filename);
    try {
      return await fs.readFile(filePath);
    } catch {
      throw new Error(`Object not found in storage: ${uniqueId}/${filename}`);
    }
  }

  async fileExists(uniqueId: string, filename: string): Promise<boolean> {
    const filePath = this.getFilePath(uniqueId, filename);
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async getFileSize(uniqueId: string, filename: string): Promise<number> {
    const filePath = this.getFilePath(uniqueId, filename);
    const stats = await fs.stat(filePath);
    return stats.size;
  }

  getSignedUrl(
    uniqueIdOrStorageKey: string,
    filename?: string,
    expiresInSeconds?: number,
  ): string {
    if (filename) {
      return this.urlSigningService.generateSignedUrl(
        uniqueIdOrStorageKey,
        filename,
        expiresInSeconds,
      );
    }

    const parsed = this.parseStorageKey(uniqueIdOrStorageKey);
    return this.urlSigningService.generateSignedUrl(
      parsed.uniqueId,
      parsed.filename,
      expiresInSeconds,
    );
  }

  async deleteObject(storageKey: string): Promise<void> {
    const { uniqueId, filename } = this.parseStorageKey(storageKey);
    const filePath = this.getFilePath(uniqueId, filename);
    try {
      await fs.unlink(filePath);
    } catch {
      // Ignore error if file doesn't exist
    }
  }

  toStorageKey(uniqueId: string, filename: string): string {
    return `${uniqueId}/${filename}`;
  }

  parseStorageKey(storageKey: string): { uniqueId: string; filename: string } {
    const normalized = storageKey
      .trim()
      .replace(/^\/+/, '')
      .replace(/\/+$/, '');
    const segments = normalized
      .split('/')
      .filter((segment) => segment.length > 0);

    if (segments.length >= 2 && segments[0] === 'downloads') {
      return {
        uniqueId: segments[1],
        filename: segments[segments.length - 1],
      };
    }

    if (segments.length >= 2 && segments[0] === 'metadata') {
      const uniqueId = segments[1];
      if (segments[2] === 'images' && segments.length >= 4) {
        return {
          uniqueId,
          filename: this.mapLegacyImageFilename(segments[3]),
        };
      }

      return {
        uniqueId,
        filename: segments[segments.length - 1],
      };
    }

    if (segments.length >= 2) {
      return {
        uniqueId: segments[segments.length - 2],
        filename: segments[segments.length - 1],
      };
    }

    throw new Error(`Invalid storage key: ${storageKey}`);
  }

  private getFilePath(uniqueId: string, filename: string): string {
    return path.join(this.storagePath, uniqueId, filename);
  }

  private mapLegacyImageFilename(rawFilename: string): string {
    const normalized = path.basename(rawFilename);
    const ext = path.extname(normalized) || '.webp';
    const stem = path.basename(normalized, ext);
    const index = Number(stem);
    if (!Number.isFinite(index)) {
      return normalized;
    }

    return `image-${Math.max(0, Math.floor(index))}${ext}`;
  }

  private readChunkByteLength(chunk: Buffer | Uint8Array | string): number {
    if (typeof chunk === 'string') {
      return Buffer.byteLength(chunk);
    }

    return chunk.byteLength;
  }
}
