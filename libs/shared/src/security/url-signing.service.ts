import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'node:crypto';

const DEFAULT_EXPIRY_SECONDS = 600; // 10 minutes

@Injectable()
export class UrlSigningService {
  private readonly secret: string;
  private readonly defaultExpiry: number;

  constructor(private readonly configService: ConfigService) {
    const secret = this.configService.get<string>('URL_SIGNING_SECRET');
    if (!secret || secret.length < 32) {
      throw new Error(
        'URL_SIGNING_SECRET must be set and at least 32 characters long',
      );
    }
    this.secret = secret;
    this.defaultExpiry = this.readPositiveIntegerConfig(
      'SIGNED_URL_EXPIRY_SECONDS',
      DEFAULT_EXPIRY_SECONDS,
    );
  }

  /**
   * Generate a signed URL for a file
   */
  generateSignedUrl(
    uniqueId: string,
    filename: string,
    expiresInSeconds?: number,
  ): string {
    const expiry = expiresInSeconds ?? this.defaultExpiry;
    const expiresAt = Math.floor(Date.now() / 1000) + expiry;

    const path = `/api/v2/files/${uniqueId}/${filename}`;
    const signature = this.generateSignature(path, expiresAt);

    return `${path}?expires=${expiresAt}&sig=${signature}`;
  }

  /**
   * Validate a signed URL
   */
  validateSignedUrl(
    path: string,
    expiresAt: number,
    signature: string,
  ): { valid: boolean; reason?: string } {
    const now = Math.floor(Date.now() / 1000);
    if (expiresAt < now) {
      return { valid: false, reason: 'URL has expired' };
    }

    const expectedSignature = this.generateSignature(path, expiresAt);
    if (signature !== expectedSignature) {
      return { valid: false, reason: 'Invalid signature' };
    }

    return { valid: true };
  }

  private generateSignature(path: string, expiresAt: number): string {
    const message = `${path}:${expiresAt}`;
    return crypto
      .createHmac('sha256', this.secret)
      .update(message)
      .digest('hex');
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
