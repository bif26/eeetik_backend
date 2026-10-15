/**
 * Appwrite client + Telegram Mini App authentication bridge.
 *
 * Flow: the Mini App sends its Telegram `initData` to the `tg-bot` function,
 * which validates the HMAC signature server-side, creates/updates the
 * matching Appwrite user (`tg_<telegramId>`) and creates a session. The
 * session secret is handed to the Appwrite Web SDK, after which every
 * function execution is authenticated (`x-appwrite-user-id` is injected by
 * Appwrite automatically).
 */
import { Account, Client, Functions } from 'appwrite';
import { getInitData } from './telegram';

const ENDPOINT =
  (import.meta.env.PUBLIC_APPWRITE_ENDPOINT as string | undefined) ??
  'https://fra.cloud.appwrite.io/v1';
const PROJECT_ID =
  (import.meta.env.PUBLIC_APPWRITE_PROJECT_ID as string | undefined) ?? '';

export const TG_BOT_FUNCTION_ID =
  (import.meta.env.PUBLIC_FN_TG_BOT as string | undefined) ?? 'tg-bot';

export const client = new Client().setEndpoint(ENDPOINT).setProject(PROJECT_ID);
export const account = new Account(client);
export const functions = new Functions(client);

export interface AuthPayload {
  ok: boolean;
  userId?: string;
  secret?: string;
  error?: string;
}

/**
 * Ensures an Appwrite session exists for the current Telegram user.
 * Returns true when the visitor is inside Telegram and authenticated.
 */
export async function ensureTelegramSession(): Promise<boolean> {
  try {
    await account.get();
    return true;
  } catch {
    /* not logged in yet */
  }

  const initData = getInitData();
  if (!initData) {
    return false;
  }

  const execution = await functions.createExecution(
    TG_BOT_FUNCTION_ID,
    JSON.stringify({ action: 'auth', initData }),
    false,
  );
  const payload = JSON.parse(execution.responseBody || '{}') as AuthPayload;
  if (!payload.ok || !payload.userId || !payload.secret) {
    throw new Error(payload.error ?? 'Telegram authentication failed');
  }

  await account.createSession({ userId: payload.userId, secret: payload.secret });
  return true;
}

/** Executes a tg-bot action and parses the JSON response body. */
export async function callBotFunction<T>(
  action: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const execution = await functions.createExecution(
    TG_BOT_FUNCTION_ID,
    JSON.stringify({ action, ...body }),
    false,
  );
  let payload: unknown;
  try {
    payload = JSON.parse(execution.responseBody || '{}');
  } catch {
    payload = { ok: false, error: 'Invalid function response' };
  }
  const typed = payload as { ok?: boolean; error?: string };
  if (typed.ok === false) {
    throw new Error(typed.error ?? 'Function request failed');
  }
  return payload as T;
}
