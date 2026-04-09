import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UrlSigningService } from '@shared';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

@Injectable()
export class ObjectStorageService {
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

  /**
   * Generate a new unique ID for a download request
   */
  generateUniqueId(): string {
    return randomUUID();
  }

  /**
   * Save buffer to uniqueId-based folder structure
   */
  async putBuffer(
    uniqueId: string,
    filename: string,
    body: Buffer,
  ): Promise<void> {
    const filePath = path.join(this.storagePath, uniqueId, filename);
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, body);
  }

  /**
   * Save stream to uniqueId-based folder structure
   */
  async putStream(
    uniqueId: string,
    filename: string,
    stream: Readable,
  ): Promise<void> {
    const filePath = path.join(this.storagePath, uniqueId, filename);
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    const writeStream = (await import('node:fs')).createWriteStream(filePath);
    return new Promise((resolve, reject) => {
      stream.pipe(writeStream);
      writeStream.on('finish', () => resolve());
      writeStream.on('error', reject);
      stream.on('error', reject);
    });
  }

  /**
   * Generate signed URL for a file
   */
  getSignedUrl(
    uniqueIdOrKey: string,
    filename?: string,
    expiresInSeconds?: number,
  ): string {
    const parts = filename
      ? { uniqueId: uniqueIdOrKey, filename }
      : this.resolveSignedUrlParts(uniqueIdOrKey);
    return this.urlSigningService.generateSignedUrl(
      parts.uniqueId,
      parts.filename,
      expiresInSeconds,
    );
  }

  /**
   * Check if a file exists
   */
  async fileExists(uniqueId: string, filename: string): Promise<boolean> {
    const filePath = path.join(this.storagePath, uniqueId, filename);
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get file buffer
   */
  async getObjectBuffer(uniqueId: string, filename: string): Promise<Buffer> {
    const filePath = path.join(this.storagePath, uniqueId, filename);
    try {
      return await fs.readFile(filePath);
    } catch {
      throw new Error(`Object not found in storage: ${uniqueId}/${filename}`);
    }
  }

  /**
   * Get folder path for a uniqueId
   */
  getFolderPath(uniqueId: string): string {
    return path.join(this.storagePath, uniqueId);
  }

  /**
   * Create manifest file for tracking
   */
  async createManifest(
    uniqueId: string,
    metadata: {
      type: string;
      url: string;
      createdAt: number;
      files: string[];
    },
  ): Promise<void> {
    const manifestPath = path.join(this.storagePath, uniqueId, 'manifest.json');
    await fs.writeFile(manifestPath, JSON.stringify(metadata, null, 2));
  }

  /**
   * Read manifest file
   */
  async readManifest(uniqueId: string): Promise<any> {
    const manifestPath = path.join(this.storagePath, uniqueId, 'manifest.json');
    try {
      const content = await fs.readFile(manifestPath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  private resolveSignedUrlParts(key: string): {
    uniqueId: string;
    filename: string;
  } {
    const trimmed = key.trim().replace(/^\/+/, '').replace(/\/+$/, '');
    if (!trimmed) {
      return { uniqueId: 'unknown', filename: 'unknown' };
    }

    const segments = trimmed.split('/').filter((segment) => segment.length > 0);
    if (segments.length < 2) {
      return { uniqueId: 'unknown', filename: path.basename(trimmed) };
    }

    if (
      segments[0] === 'metadata' &&
      segments.length >= 3 &&
      segments[1].length > 0
    ) {
      const uniqueId = segments[1];
      if (segments[2] === 'images' && segments.length >= 4) {
        return {
          uniqueId,
          filename: this.mapLegacyImageFilename(segments[3]),
        };
      }

      return { uniqueId, filename: segments[segments.length - 1] };
    }

    if (
      segments[0] === 'downloads' &&
      segments.length >= 3 &&
      segments[1].length > 0
    ) {
      return {
        uniqueId: segments[1],
        filename: segments[segments.length - 1],
      };
    }

    if (segments.length >= 2) {
      return {
        uniqueId: segments[segments.length - 2],
        filename: segments[segments.length - 1],
      };
    }

    return { uniqueId: 'unknown', filename: path.basename(trimmed) };
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
}
