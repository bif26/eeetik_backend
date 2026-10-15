import { createHmac } from 'node:crypto';
import { buildSignedCdnUrl } from './signed-cdn-url';

describe('buildSignedCdnUrl', () => {
  it('creates a deterministic signed CDN URL', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const expiresAtSeconds = Math.floor(now.getTime() / 1000) + 600;
    const expectedPath = '/media/downloads/video-uuid/hd.mp4';
    const expectedSignature = createHmac('sha256', 'top-secret')
      .update(`${expectedPath}:${expiresAtSeconds}`)
      .digest('hex');

    const signedUrl = buildSignedCdnUrl({
      baseUrl: 'https://cdn.eeetik.app',
      signingSecret: 'top-secret',
      objectKey: 'downloads/video-uuid/hd.mp4',
      expiresInSeconds: 600,
      now,
    });

    expect(signedUrl).toBe(
      `https://cdn.eeetik.app${expectedPath}?exp=${expiresAtSeconds}&sig=${expectedSignature}`,
    );
  });

  it('preserves a base URL path and applies custom prefix normalization', () => {
    const signedUrl = buildSignedCdnUrl({
      baseUrl: 'https://cdn.eeetik.app/private',
      signingSecret: 'secret',
      objectKey: '/downloads/video uuid/audio.mp3/',
      expiresInSeconds: 120,
      pathPrefix: 'signed',
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(signedUrl).toContain(
      'https://cdn.eeetik.app/private/signed/downloads/video%20uuid/audio.mp3?',
    );
  });

  it('throws for invalid configuration', () => {
    expect(() =>
      buildSignedCdnUrl({
        baseUrl: '',
        signingSecret: 'secret',
        objectKey: 'downloads/video-uuid/hd.mp4',
        expiresInSeconds: 600,
      }),
    ).toThrow('CDN base URL is required');

    expect(() =>
      buildSignedCdnUrl({
        baseUrl: 'https://cdn.eeetik.app',
        signingSecret: '',
        objectKey: 'downloads/video-uuid/hd.mp4',
        expiresInSeconds: 600,
      }),
    ).toThrow('CDN signing secret is required');

    expect(() =>
      buildSignedCdnUrl({
        baseUrl: 'https://cdn.eeetik.app',
        signingSecret: 'secret',
        objectKey: '',
        expiresInSeconds: 600,
      }),
    ).toThrow('Object key is required');
  });
});
