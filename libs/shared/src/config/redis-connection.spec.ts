import { parseRedisUrl, readRedisCoreOptions } from './redis-connection';

describe('redis-connection', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.REDIS_URL;
    delete process.env.UPSTASH_REDIS_HOST;
    delete process.env.UPSTASH_REDIS_PASSWORD;
    delete process.env.UPSTASH_REDIS_PORT;
    delete process.env.UPSTASH_REDIS_TLS;
    delete process.env.REDIS_HOST;
    delete process.env.REDIS_PORT;
    delete process.env.REDIS_PASSWORD;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  describe('parseRedisUrl', () => {
    it('parses a rediss:// URL with password, port and TLS', () => {
      const options = parseRedisUrl(
        'rediss://:s3cr3t@redis-12345.do.amazonaws.com:24829',
      );

      expect(options).toEqual({
        host: 'redis-12345.do.amazonaws.com',
        port: 24829,
        password: 's3cr3t',
        tls: { rejectUnauthorized: false },
      });
    });

    it('defaults the port to 6379 and disables TLS for redis://', () => {
      const options = parseRedisUrl('redis://:pw@internal-host');

      expect(options).toEqual({
        host: 'internal-host',
        port: 6379,
        password: 'pw',
        tls: undefined,
      });
    });

    it('reads the password from the username slot for default-user providers', () => {
      const options = parseRedisUrl('redis://default:topsecret@cache.io:6380');

      expect(options?.password).toBe('topsecret');
      expect(options?.port).toBe(6380);
    });

    it('decodes percent-encoded passwords', () => {
      const options = parseRedisUrl('redis://:p%40ss%3Aword@host:6379');

      expect(options?.password).toBe('p@ss:word');
    });

    it('returns null for malformed URLs and foreign schemes', () => {
      expect(parseRedisUrl('not-a-url')).toBeNull();
      expect(parseRedisUrl('postgres://user:pw@db:5432')).toBeNull();
    });
  });

  describe('readRedisCoreOptions', () => {
    it('prefers REDIS_URL over the discrete variables', () => {
      process.env.REDIS_URL = 'rediss://:urlpw@url-host:6399';
      process.env.UPSTASH_REDIS_HOST = 'upstash-host';
      process.env.UPSTASH_REDIS_PASSWORD = 'upstash-pw';
      process.env.REDIS_HOST = 'legacy-host';

      const options = readRedisCoreOptions();

      expect(options).toEqual({
        host: 'url-host',
        port: 6399,
        password: 'urlpw',
        tls: { rejectUnauthorized: false },
      });
    });

    it('falls back to Upstash variables with implicit TLS', () => {
      process.env.UPSTASH_REDIS_HOST = 'cache.upstash.io';
      process.env.UPSTASH_REDIS_PASSWORD = 'upstash-pw';

      const options = readRedisCoreOptions();

      expect(options).toMatchObject({
        host: 'cache.upstash.io',
        port: 6379,
        password: 'upstash-pw',
      });
      expect(options.tls).toEqual({ rejectUnauthorized: false });
    });

    it('falls back to localhost defaults when nothing is configured', () => {
      const options = readRedisCoreOptions();

      expect(options).toEqual({
        host: '127.0.0.1',
        port: 6379,
        password: undefined,
        tls: undefined,
      });
    });

    it('ignores a malformed REDIS_URL and uses the next source', () => {
      process.env.REDIS_URL = '::not a url::';
      process.env.UPSTASH_REDIS_HOST = 'cache.upstash.io';
      process.env.UPSTASH_REDIS_PASSWORD = 'upstash-pw';

      const options = readRedisCoreOptions();

      expect(options.host).toBe('cache.upstash.io');
    });
  });
});
