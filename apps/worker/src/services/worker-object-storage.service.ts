import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassThrough, Readable } from 'node:stream';

const DEFAULT_SIGNED_URL_TTL_SECONDS = 600;

@Injectable()
export class WorkerObjectStorageService {
  private readonly s3Client: S3Client;
  private readonly bucketName: string;

  constructor(private readonly configService: ConfigService) {
    this.bucketName = this.configService.get<string>('S3_BUCKET', '');
    const endpoint = this.configService.get<string>('S3_ENDPOINT');
    const useSSL = this.configService.get<string>('S3_USE_SSL', 'false');
    
    this.s3Client = new S3Client({
      endpoint: endpoint,
      region: this.configService.get<string>('S3_REGION', 'us-east-1'),
      credentials: {
        accessKeyId: this.configService.get<string>('S3_ACCESS_KEY_ID', ''),
        secretAccessKey: this.configService.get<string>(
          'S3_SECRET_ACCESS_KEY',
          '',
        ),
      },
      forcePathStyle: true, // Required for MinIO
      tls: useSSL.toLowerCase() === 'true',
    });
  }

  async putBuffer(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<number> {
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );

    return body.byteLength;
  }

  async putStream(
    key: string,
    body: Readable,
    contentType: string,
  ): Promise<number> {
    let uploadedBytes = 0;
    const countingStream = new PassThrough();
    body.on('data', (chunk: Buffer | Uint8Array | string) => {
      uploadedBytes += this.readChunkByteLength(chunk);
    });
    body.pipe(countingStream);

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: countingStream,
        ContentType: contentType,
      }),
    );

    return uploadedBytes;
  }

  async getBuffer(key: string): Promise<Buffer> {
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

  async getSignedUrl(key: string, expiresInSeconds?: number): Promise<string> {
    const signedUrlTtl =
      expiresInSeconds ??
      this.readPositiveIntegerConfig(
        'SIGNED_URL_TTL_SECONDS',
        DEFAULT_SIGNED_URL_TTL_SECONDS,
      );

    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: key,
    });

    return getSignedUrl(this.s3Client, command, {
      expiresIn: signedUrlTtl,
    });
  }

  async deleteObject(key: string): Promise<void> {
    await this.s3Client.send(
      new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      }),
    );
  }

  private readChunkByteLength(chunk: Buffer | Uint8Array | string): number {
    if (typeof chunk === 'string') {
      return Buffer.byteLength(chunk);
    }

    return chunk.byteLength;
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
