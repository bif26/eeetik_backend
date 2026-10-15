import { assertSignedUrlRuntimeConfig } from './signed-url-runtime-config';

describe('assertSignedUrlRuntimeConfig', () => {
  it('accepts valid CDN signed URL runtime config', () => {
    expect(() =>
      assertSignedUrlRuntimeConfig({
        serviceName: 'api',
        env: {
          SIGNED_URL_MODE: 'cdn',
          CDN_SIGNED_BASE_URL: 'https://cdn.eeetik.app',
          CDN_PUBLIC_HOST: 'cdn.eeetik.app',
          CDN_SIGNING_SECRET: 'secret',
          CDN_SIGNED_PATH_PREFIX: '/media',
        },
      }),
    ).not.toThrow();
  });

  it('rejects non-cdn mode', () => {
    expect(() =>
      assertSignedUrlRuntimeConfig({
        serviceName: 'worker',
        env: {
          SIGNED_URL_MODE: 'r2',
          CDN_SIGNED_BASE_URL: 'https://cdn.eeetik.app',
          CDN_SIGNING_SECRET: 'secret',
        },
      }),
    ).toThrow('SIGNED_URL_MODE must be "cdn"');
  });

  it('rejects missing signing secret', () => {
    expect(() =>
      assertSignedUrlRuntimeConfig({
        serviceName: 'api',
        env: {
          SIGNED_URL_MODE: 'cdn',
          CDN_SIGNED_BASE_URL: 'https://cdn.eeetik.app',
        },
      }),
    ).toThrow('CDN_SIGNING_SECRET is required');
  });

  it('rejects host mismatch when CDN_PUBLIC_HOST is set', () => {
    expect(() =>
      assertSignedUrlRuntimeConfig({
        serviceName: 'api',
        env: {
          SIGNED_URL_MODE: 'cdn',
          CDN_SIGNED_BASE_URL: 'https://wrong.eeetik.app',
          CDN_PUBLIC_HOST: 'cdn.eeetik.app',
          CDN_SIGNING_SECRET: 'secret',
        },
      }),
    ).toThrow('CDN_SIGNED_BASE_URL host must match CDN_PUBLIC_HOST');
  });
});
