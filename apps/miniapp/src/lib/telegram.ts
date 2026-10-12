/**
 * Thin helpers around the Telegram WebApp runtime.
 *
 * Primary integration uses `@telegram-apps/sdk`; the official
 * `telegram-web-app.js` script (loaded in app.html) provides the trusted
 * `initData` fallback used for the `tma` authorization header.
 */

export interface TelegramWebApp {
  initData: string;
  initDataUnsafe?: {
    user?: {
      id: number;
      first_name?: string;
      last_name?: string;
      username?: string;
      photo_url?: string;
      is_premium?: boolean;
    };
  };
  colorScheme: 'light' | 'dark';
  themeParams?: Record<string, string>;
  expand(): void;
  ready?(): void;
  HapticFeedback?: {
    impactOccurred?(style: string): void;
    notificationOccurred?(type: string): void;
  };
  CloudStorage?: {
    setItem(
      key: string,
      value: string,
      cb?: (err: unknown, ok: boolean) => void,
    ): void;
    getItem(key: string, cb?: (err: unknown, value: string) => void): void;
  };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

export function getWebApp(): TelegramWebApp | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }

  return window.Telegram?.WebApp;
}

/** Raw initData string used for `Authorization: tma <initData>` headers. */
export function getInitData(): string {
  return getWebApp()?.initData ?? '';
}

export function hapticFeedback(type: 'success' | 'error' | 'warning'): void {
  try {
    getWebApp()?.HapticFeedback?.notificationOccurred?.(type);
  } catch {
    // Haptics are best-effort
  }
}

/** Initializes the Telegram WebApp runtime + @telegram-apps/sdk bindings. */
export function initTelegram(): void {
  const webApp = getWebApp();
  if (webApp) {
    try {
      webApp.ready?.();
      webApp.expand();
    } catch {
      // ignore – runtime quirks must never break the app shell
    }
  }
}

/**
 * Binds the daisyUI `data-theme` attribute to Telegram's color scheme
 * (`light --default`, `dark --prefersdark`).
 */
export function applyTelegramTheme(): void {
  const webApp = getWebApp();
  const theme = webApp?.colorScheme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', theme);
}
