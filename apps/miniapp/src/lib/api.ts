import { getInitData } from './telegram';

const API_BASE = (
  (import.meta.env.PUBLIC_API_BASE_URL as string | undefined) ??
  'http://localhost:3000'
).replace(/\/+$/, '');

const API_PREFIX = '/api/v2';

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

export interface MetadataResponse {
  success: true;
  data: PreviewData;
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

function authHeaders(): Record<string, string> {
  const initData = getInitData();
  return initData ? { Authorization: `tma ${initData}` } : {};
}

async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${API_BASE}${API_PREFIX}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(options.headers ?? {}),
    },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    const detail = Array.isArray(body?.message)
      ? body?.message.join(', ')
      : body?.message;
    throw new Error(detail ?? `Request failed (${response.status})`);
  }

  return (await response.json()) as T;
}

export const api = {
  fetchMetadata(url: string): Promise<MetadataResponse> {
    return apiFetch<MetadataResponse>('/model/download/tiktok', {
      method: 'POST',
      body: JSON.stringify({ url }),
    });
  },

  prepare(uniqueId: string, requestType: string): Promise<JobStatusResponse> {
    return apiFetch<JobStatusResponse>('/model/download/tiktok/prepare', {
      method: 'POST',
      body: JSON.stringify({ uniqueId, requestType, adToken: '' }),
    });
  },

  status(jobId: string): Promise<JobStatusResponse> {
    return apiFetch<JobStatusResponse>(
      `/model/download/tiktok/status/${encodeURIComponent(jobId)}`,
    );
  },

  history(): Promise<HistoryEntry[]> {
    return apiFetch<HistoryEntry[]>('/model/download/tiktok/history?limit=50');
  },

  me(): Promise<{ user: MiniAppUser | null }> {
    return apiFetch<{ user: MiniAppUser | null }>('/auth/me');
  },

  updateSettings(
    settings: Record<string, unknown>,
  ): Promise<{ user: MiniAppUser | null }> {
    return apiFetch<{ user: MiniAppUser | null }>('/auth/me', {
      method: 'PATCH',
      body: JSON.stringify(settings),
    });
  },
};

export const REQUEST_TYPE_LABELS: Record<string, string> = {
  hd: 'HD Video',
  sd: 'SD Video',
  audio: 'Audio MP3',
  zip: 'Images ZIP',
};
