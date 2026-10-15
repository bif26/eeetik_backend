import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { TelegramInitDataService } from './telegram-init-data.service';

const TEST_BOT_TOKEN = '7000000001:AAExampleTestTokenForUnitTests123';

interface TestUserFixture {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  is_premium?: boolean;
}

function signInitData(
  fields: Record<string, string>,
  botToken: string = TEST_BOT_TOKEN,
): string {
  const params = new URLSearchParams(fields);
  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();
  const hash = createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');
  params.set('hash', hash);
  return params.toString();
}

function buildInitData(
  user: TestUserFixture,
  authDateSeconds: number,
  botToken: string = TEST_BOT_TOKEN,
): string {
  return signInitData(
    {
      auth_date: String(authDateSeconds),
      query_id: 'AAF_test_query',
      user: JSON.stringify(user),
    },
    botToken,
  );
}

function createService(configValues: Record<string, string> = {}) {
  return new TelegramInitDataService(
    new ConfigService({
      TELEGRAM_BOT_TOKEN: TEST_BOT_TOKEN,
      ...configValues,
    }),
  );
}

describe('TelegramInitDataService', () => {
  const user: TestUserFixture = {
    id: 987654321,
    first_name: 'Eva',
    username: 'eva_test',
    is_premium: true,
  };

  it('accepts a valid initData payload', () => {
    const service = createService();
    const authDate = Math.floor(Date.now() / 1000);
    const initData = buildInitData(user, authDate);

    const result = service.validate(initData);

    expect(result).not.toBeNull();
    expect(result?.id).toBe(987654321);
    expect(result?.username).toBe('eva_test');
    expect(result?.firstName).toBe('Eva');
    expect(result?.isPremium).toBe(true);
  });

  it('rejects a payload signed with a different bot token', () => {
    const service = createService();
    const authDate = Math.floor(Date.now() / 1000);
    const initData = buildInitData(user, authDate, '7000000002:AWrongToken');

    expect(service.validate(initData)).toBeNull();
  });

  it('rejects a tampered payload', () => {
    const service = createService();
    const authDate = Math.floor(Date.now() / 1000);
    const initData = buildInitData(user, authDate);
    const tampered = initData.replace('eva_test', 'hacker');

    expect(service.validate(tampered)).toBeNull();
  });

  it('rejects payloads older than the configured max age', () => {
    const service = createService({
      TELEGRAM_INIT_DATA_MAX_AGE_SECONDS: '60',
    });
    const staleAuthDate = Math.floor(Date.now() / 1000) - 3600;
    const initData = buildInitData(user, staleAuthDate);

    expect(service.validate(initData)).toBeNull();
  });

  it('accepts payloads inside the max age window', () => {
    const service = createService({
      TELEGRAM_INIT_DATA_MAX_AGE_SECONDS: '3600',
    });
    const authDate = Math.floor(Date.now() / 1000) - 1200;
    const initData = buildInitData(user, authDate);

    expect(service.validate(initData)).not.toBeNull();
  });

  it('rejects payloads without a hash', () => {
    const service = createService();
    const initData = `auth_date=${Math.floor(Date.now() / 1000)}&user=${encodeURIComponent(JSON.stringify(user))}`;

    expect(service.validate(initData)).toBeNull();
  });

  it('rejects payloads without a user field', () => {
    const service = createService();
    const initData = signInitData({
      auth_date: String(Math.floor(Date.now() / 1000)),
    });

    expect(service.validate(initData)).toBeNull();
  });

  it('rejects empty input and missing bot token', () => {
    const service = createService();
    const noTokenService = new TelegramInitDataService(new ConfigService({}));

    expect(service.validate('')).toBeNull();
    expect(noTokenService.validate('anything')).toBeNull();
  });
});
