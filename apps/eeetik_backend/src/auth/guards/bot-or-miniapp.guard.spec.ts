import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { BotOrMiniAppGuard } from './bot-or-miniapp.guard';

interface MockTelegramUser {
  id: number;
  username?: string;
}

const BOT_INTERNAL_SECRET = 'unit-test-bot-secret';
const JWT_SECRET = 'unit-test-jwt-secret';

function createContext(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

function createGuard(overrides?: {
  validate?: (data: string) => MockTelegramUser | null;
}): BotOrMiniAppGuard {
  const initDataService = {
    validate:
      overrides?.validate ??
      ((data: string) =>
        data.includes('good')
          ? ({ id: 111222333, username: 'eva' } as MockTelegramUser)
          : null),
  };

  return new BotOrMiniAppGuard(
    initDataService as never,
    new ConfigService({
      BOT_INTERNAL_SECRET,
      JWT_SECRET,
    }),
    new JwtService({ secret: JWT_SECRET }),
  );
}

describe('BotOrMiniAppGuard', () => {
  it('authorizes bot-internal calls via X-Bot-Secret', async () => {
    const guard = createGuard();
    const request: Record<string, unknown> = {
      headers: { 'x-bot-secret': BOT_INTERNAL_SECRET },
    };

    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
    expect(request.authContext).toEqual({ type: 'bot' });
    expect(request.skipAdGate).toBe(true);
  });

  it('rejects an invalid bot secret and falls through to 401', async () => {
    const guard = createGuard();
    const request: Record<string, unknown> = {
      headers: { 'x-bot-secret': 'wrong-secret' },
    };

    await expect(guard.canActivate(createContext(request))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('authorizes Mini App calls with valid tma initData', async () => {
    const guard = createGuard();
    const request: Record<string, unknown> = {
      headers: { authorization: 'tma good-init-data' },
    };

    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
    expect(request.authContext).toEqual({
      type: 'miniapp',
      telegramUserId: 111222333,
    });
    expect((request.telegramUser as MockTelegramUser).id).toBe(111222333);
    expect(request.skipAdGate).toBe(true);
  });

  it('rejects Mini App calls with invalid initData', async () => {
    const guard = createGuard();
    const request: Record<string, unknown> = {
      headers: { authorization: 'tma bad-init-data' },
    };

    await expect(guard.canActivate(createContext(request))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('authorizes Mini App JWT bearer tokens issued by /auth/telegram', async () => {
    const guard = createGuard();
    const jwtService = new JwtService({ secret: JWT_SECRET });
    const token = await jwtService.signAsync({
      sub: 111222333,
      telegramId: 111222333,
    });
    const request: Record<string, unknown> = {
      headers: { authorization: `Bearer ${token}` },
    };

    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
    expect(request.authContext).toEqual({
      type: 'jwt',
      telegramUserId: 111222333,
    });
  });

  it('rejects malformed bearer tokens', async () => {
    const guard = createGuard();
    const request: Record<string, unknown> = {
      headers: { authorization: 'Bearer not-a-real-token' },
    };

    await expect(guard.canActivate(createContext(request))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects requests without any credentials', async () => {
    const guard = createGuard();
    const request: Record<string, unknown> = { headers: {} };

    await expect(guard.canActivate(createContext(request))).rejects.toThrow(
      UnauthorizedException,
    );
  });
});
