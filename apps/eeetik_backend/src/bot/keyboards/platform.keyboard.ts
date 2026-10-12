import { InlineKeyboard } from 'grammy';

export type SupportedPlatform = 'tiktok' | 'youtube';

export const PLATFORM_LABELS: Record<SupportedPlatform, string> = {
  tiktok: 'TikTok',
  youtube: 'YouTube',
};

const TIKTOK_HOST_SUFFIXES = ['tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'];

/**
 * Detects the media platform from a URL. TikTok is fully supported;
 * YouTube is recognized but not download-ready yet (reported honestly).
 */
export function detectPlatform(url: string): SupportedPlatform | null {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return null;
  }

  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    return null;
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  if (
    TIKTOK_HOST_SUFFIXES.some(
      (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
    )
  ) {
    return 'tiktok';
  }

  if (
    hostname === 'youtube.com' ||
    hostname.endsWith('.youtube.com') ||
    hostname === 'youtu.be'
  ) {
    return 'youtube';
  }

  return null;
}

/**
 * Informational keyboard shown next to the platform overview message.
 */
export function buildPlatformKeyboard(miniAppUrl?: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  if (miniAppUrl && miniAppUrl.trim().length > 0) {
    keyboard.webApp('🎵 Open Mini App', miniAppUrl.trim()).row();
  }

  return keyboard.text('❓ Help', 'help:main');
}
