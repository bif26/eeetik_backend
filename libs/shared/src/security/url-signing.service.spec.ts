import { ConfigService } from '@nestjs/config';
import { UrlSigningService } from './url-signing.service';

describe('UrlSigningService', () => {
  const validSecret = '12345678901234567890123456789012';

  it('generates and validates signed URLs', () => {
    const service = new UrlSigningService(
      new ConfigService({
        URL_SIGNING_SECRET: validSecret,
        SIGNED_URL_EXPIRY_SECONDS: '600',
      }),
    );

    const signedUrl = service.generateSignedUrl('abc123', 'video-hd.mp4');
    const [path, queryString = ''] = signedUrl.split('?');
    const query = new URLSearchParams(queryString);

    expect(path).toBe('/api/v2/files/abc123/video-hd.mp4');
    expect(query.get('expires')).toBeTruthy();
    expect(query.get('sig')).toBeTruthy();

    const expiresAt = Number(query.get('expires'));
    const signature = query.get('sig') as string;
    expect(service.validateSignedUrl(path, expiresAt, signature)).toEqual({
      valid: true,
    });
  });

  it('rejects expired signatures', () => {
    const service = new UrlSigningService(
      new ConfigService({
        URL_SIGNING_SECRET: validSecret,
      }),
    );

    const result = service.validateSignedUrl(
      '/api/v2/files/abc123/audio.mp3',
      Math.floor(Date.now() / 1000) - 1,
      'invalid',
    );

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('URL has expired');
  });

  it('requires a minimum secret length', () => {
    expect(
      () =>
        new UrlSigningService(
          new ConfigService({
            URL_SIGNING_SECRET: 'short-secret',
          }),
        ),
    ).toThrow('URL_SIGNING_SECRET must be set and at least 32 characters long');
  });
});
