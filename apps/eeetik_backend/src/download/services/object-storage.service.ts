import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { buildSignedCdnUrl } from '@shared';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'node:stream';

const DEFAULT_SIGNED_URL_TTL_SECONDS = 600;
const SIGNED_URL_MODE_CDN = 'cdn';

@Injectable()
export class ObjectStorageService {
  private readonly s3Client: S3Client;
  private readonly bucketName: string;

  constructor(private readonly configService: ConfigService) {
    this.bucketName = this.configService.get<string>('R2_BUCKET', '');
    this.s3Client = new S3Client({
      endpoint: this.configService.get<string>('R2_ENDPOINT'),
      region: this.configService.get<string>('R2_REGION', 'auto'),
      credentials: {
        accessKeyId: this.configService.get<string>('R2_ACCESS_KEY_ID', ''),
        secretAccessKey: this.configService.get<string>(
          'R2_SECRET_ACCESS_KEY',
          '',
        ),
      },
      forcePathStyle: false,
    });
  }

  async putBuffer(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async putStream(
    key: string,
    stream: Readable,
    contentType: string,
  ): Promise<void> {
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: stream,
        ContentType: contentType,
      }),
    );
  }

  getSignedUrl(key: string, expiresInSeconds?: number): Promise<string> {
    const signedUrlTtl =
      expiresInSeconds ??
      this.readPositiveIntegerConfig(
        'SIGNED_URL_TTL_SECONDS',
        DEFAULT_SIGNED_URL_TTL_SECONDS,
      );
    const signedUrlMode = this.configService
      .get<string>('SIGNED_URL_MODE', SIGNED_URL_MODE_CDN)
      .toLowerCase()
      .trim();

    if (signedUrlMode !== SIGNED_URL_MODE_CDN) {
      throw new Error(
        'SIGNED_URL_MODE must be "cdn". Direct R2 signed URLs are disabled.',
      );
    }

    const cdnBaseUrl = this.configService.get<string>(
      'CDN_SIGNED_BASE_URL',
      '',
    );
    const cdnSigningSecret = this.configService.get<string>(
      'CDN_SIGNING_SECRET',
      '',
    );
    if (!cdnBaseUrl.trim() || !cdnSigningSecret.trim()) {
      throw new Error(
        'CDN_SIGNED_BASE_URL and CDN_SIGNING_SECRET are required when SIGNED_URL_MODE=cdn',
      );
    }

    return Promise.resolve(
      buildSignedCdnUrl({
        baseUrl: cdnBaseUrl,
        signingSecret: cdnSigningSecret,
        objectKey: key,
        expiresInSeconds: signedUrlTtl,
        pathPrefix: this.configService.get<string>(
          'CDN_SIGNED_PATH_PREFIX',
          '/media',
        ),
      }),
    );
  }

  async getObjectBuffer(key: string): Promise<Buffer> {
    const response = await this.s3Client.send(
      new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      }),
    );

    if (!response.Body) {
      throw new Error(`Object not found in storage: ${key}`);
    }

    if ('transformToByteArray' in response.Body) {
      const bytes = await response.Body.transformToByteArray();
      return Buffer.from(bytes);
    }

    const chunks: Buffer[] = [];
    for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }

    return Buffer.concat(chunks);
  }

  private readPositiveIntegerConfig(
    envKey: string,
    fallbackValue: number,
  ): number {
    const value = this.configService.get<string>(envKey);
    if (value === undefined || value.trim().length === 0) {
      return fallbackValue;
    }

    const parsedValue = Number(value);
    if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
      return fallbackValue;
    }

    return Math.floor(parsedValue);
  }
}
