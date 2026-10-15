import type { PreviewData } from './api';

/**
 * In-memory app state (Svelte 5 runes). Persistence intentionally goes
 * through Telegram CloudStorage — never localStorage.
 */
export const appState = $state({
  preview: null as PreviewData | null,
  jobId: null as string | null,
  sourceUrl: '',
});
