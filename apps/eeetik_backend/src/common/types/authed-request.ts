import type { Request } from 'express';

export interface TelegramInitUser {
  id: number;
  isBot?: boolean;
  firstName?: string;
  lastName?: string;
  username?: string;
  languageCode?: string;
  isPremium?: boolean;
  photoUrl?: string;
}

export type AuthContextType = 'bot' | 'miniapp' | 'jwt';

export interface AuthContext {
  type: AuthContextType;
  telegramUserId?: number;
}

export type AuthedRequest = Request & {
  authContext?: AuthContext;
  telegramUser?: TelegramInitUser;
  skipAdGate?: boolean;
};

export type RequestWithAuth = AuthedRequest & { requestId?: string };
