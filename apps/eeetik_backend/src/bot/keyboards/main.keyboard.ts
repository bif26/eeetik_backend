import { InlineKeyboard } from 'grammy';

export const HELP_MAIN_CALLBACK = 'help:main';
export const HELP_PLATFORMS_CALLBACK = 'help:platforms';

/**
 * Main navigation keyboard. The Mini App button requires a configured
 * `TELEGRAM_MINI_APP_URL`; the secondary buttons answer with help texts.
 */
export function buildMainKeyboard(miniAppUrl?: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  if (miniAppUrl && miniAppUrl.trim().length > 0) {
    keyboard.webApp('🎵 Open Mini App', miniAppUrl.trim());
  }

  keyboard
    .text('🌍 Supported platforms', HELP_PLATFORMS_CALLBACK)
    .text('❓ Help', HELP_MAIN_CALLBACK);

  return keyboard;
}
