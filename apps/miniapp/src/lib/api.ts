/**
 * Appwrite-backed API layer.
 *
 * Every request goes through the `tg-bot` Appwrite Function. Metadata is
 * public; prepare / jobs / download / history / settings require the
 * Telegram-initiated Appwrite session (created in lib/appwrite.ts).
 */
import { callBotFunction, ensureTelegramSession } from './appwrite';
import { getInitData } from './telegram';

export interface PreviewAuthor {
  nickname: string;
  avatar: string | null;
}

export interface PreviewStats {
  views: string;
  likes: string;
  shares: string;
  comments: string;
}

export interface FormatOption {
  id: string;
  label: string;
}

export interface PreviewData {
  uniqueId: string;
  url: string;
  type: 'video' | 'image';
  title: string;
  author: PreviewAuthor;
  stats: PreviewStats;
  hashtags: string[];
  availableFormats: {
    video?: FormatOption[];
    audio?: FormatOption[];
    images?: FormatOption[];
  };
  thumbnail?: string | null;
  images?: string[];
  duration?: number;
}

interface RawPreview {
  uniqueId: string;
  url?: string;
  title?: string;
  authorName?: string;
  authorAvatarUrl?: string;
  thumbnailUrl?: string;
  videoUrl?: string;
  videoHdUrl?: string;
  videoSdUrl?: string;
  videoWatermarkUrl?: string;
  audioUrl?: string;
  imageUrls?: string[];
  stats?: { views?: number; likes?: number; shares?: number; comments?: number };
  hashtags?: string[];
  duration?: number;
}

export type JobStatus = 'processing' | 'completed' | 'expired' | 'failed';

export interface JobStatusResponse {
  jobId: string;
  status: JobStatus;
  downloadUrl?: string;
  errorMessage?: string;
}

export interface HistoryEntry {
  jobId: string;
  uniqueId: string;
  requestType: string;
  status: JobStatus;
  createdAt?: string;
}

export interface MiniAppUser {
  telegramId: number;
  username?: string;
  firstName?: string;
  settings?: Record<string, unknown>;
}

export const REQUEST_TYPE_LABELS: Record<string, string> = {
  hd: 'HD 1080p',
  hd720: 'HD 720p',
  sd: 'SD 480p',
  sd360: 'SD 360p',
  audio: 'Audio MP3',
  zip: 'Images ZIP',
};

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function mapPreview(raw: RawPreview): PreviewData {
  const imageUrls = raw.imageUrls ?? [];
  const videoUrl = raw.videoUrl ?? '';
  const hdUrl = raw.videoHdUrl || videoUrl;
  const sdUrl = raw.videoSdUrl || videoUrl;
  const stats = raw.stats ?? {};

  const video: FormatOption[] = [];
  if (hdUrl) video.push({ id: 'hd', label: REQUEST_TYPE_LABELS.hd });
  if (hdUrl) video.push({ id: 'hd720', label: REQUEST_TYPE_LABELS.hd720 });
  if (sdUrl) video.push({ id: 'sd', label: REQUEST_TYPE_LABELS.sd });
  if (sdUrl) video.push({ id: 'sd360', label: REQUEST_TYPE_LABELS.sd360 });

  return {
    uniqueId: raw.uniqueId,
    url: raw.url ?? '',
    type: imageUrls.length ? 'image' : 'video',
    title: raw.title ?? '',
    author: {
      nickname: raw.authorName || raw.uniqueId,
      avatar: raw.authorAvatarUrl || null,
    },
    stats: {
      views: stats.views != null ? formatCompact(stats.views) : '—',
      likes: stats.likes != null ? formatCompact(stats.likes) : '—',
      shares: stats.shares != null ? formatCompact(stats.shares) : '—',
      comments: stats.comments != null ? formatCompact(stats.comments) : '—',
    },
    hashtags: raw.hashtags ?? [],
    availableFormats: {
      video: video.length ? video : undefined,
      audio: raw.audioUrl
        ? [{ id: 'audio', label: REQUEST_TYPE_LABELS.audio }]
        : undefined,
      images: imageUrls.length
        ? [{ id: 'zip', label: REQUEST_TYPE_LABELS.zip }]
        : undefined,
    },
    thumbnail: raw.thumbnailUrl || null,
    images: imageUrls,
    duration: raw.duration,
  };
}

/** Must run before any authenticated call. */
async function withSession(): Promise<void> {
  await ensureTelegramSession();
}

export const api = {
  async fetchMetadata(url: string): Promise<{ success: true; data: PreviewData }> {
    const response = await callBotFunction<{ preview: RawPreview }>('metadata', { url });
    return { success: true, data: mapPreview(response.preview) };
  },

  async prepare(url: string, quality: string): Promise<JobStatusResponse> {
    await withSession();
    const response = await callBotFunction<{ jobId: string }>('prepare', { url, quality });
    return { jobId: response.jobId, status: 'processing' };
  },

  async status(jobId: string): Promise<JobStatusResponse> {
    await withSession();
    const response = await callBotFunction<{
      jobs: Array<{
        id: string;
        status: string;
        error?: string;
        quality: string;
      }>;
    }>('jobs');
    const job = response.jobs.find((entry) => entry.id === jobId);
    if (!job) {
      return { jobId, status: 'processing' };
    }
    const mapped: JobStatusResponse = {
      jobId,
      status:
        job.status === 'completed'
          ? 'completed'
          : job.status === 'failed'
            ? 'failed'
            : 'processing',
      errorMessage: job.error,
    };
    if (job.status === 'completed') {
      try {
        const download = await callBotFunction<{ url: string }>('download', { jobId });
        mapped.downloadUrl = download.url;
      } catch {
        /* playback link unavailable – chat delivery still works */
      }
    }
    return mapped;
  },

  async history(): Promise<HistoryEntry[]> {
    await withSession();
    const response = await callBotFunction<{
      history: Array<{
        id: string;
        uniqueId: string;
        quality: string;
        status: string;
        createdAt: string;
      }>;
    }>('history');
    return response.history.map((row) => ({
      jobId: row.id,
      uniqueId: row.uniqueId,
      requestType: row.quality,
      status: (row.status === 'completed' ? 'completed' : row.status === 'failed' ? 'failed' : 'processing') as JobStatus,
      createdAt: row.createdAt,
    }));
  },

  async me(): Promise<{ user: MiniAppUser | null }> {
    await withSession();
    const response = await callBotFunction<{
      user: { telegramId: string; username?: string; firstName?: string };
      settings?: string;
    }>('settings');
    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(response.settings ?? '{}');
    } catch {
      settings = {};
    }
    return {
      user: {
        telegramId: Number(response.user?.telegramId ?? 0),
        username: response.user?.username,
        firstName: response.user?.firstName,
        settings,
      },
    };
  },

  async updateSettings(
    settings: Record<string, unknown>,
  ): Promise<{ user: MiniAppUser | null }> {
    await withSession();
    const response = await callBotFunction<{
      user: { telegramId: string; username?: string; firstName?: string };
      settings?: string;
    }>('settings', { settings });
    return {
      user: {
        telegramId: Number(response.user?.telegramId ?? 0),
        username: response.user?.username,
        firstName: response.user?.firstName,
        settings,
      },
    };
  },
};

/** True when running inside Telegram with usable initData. */
export function hasTelegramAuth(): boolean {
  return Boolean(getInitData());
}
