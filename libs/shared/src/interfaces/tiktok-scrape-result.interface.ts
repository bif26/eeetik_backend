export interface TikTokScrapeStats {
  views?: number;
  likes?: number;
  shares?: number;
  comments?: number;
}

export interface TikTokScrapeResult {
  title?: string;
  authorName?: string;
  authorAvatarUrl?: string;
  thumbnailUrl?: string;
  videoUrl?: string;
  videoHdUrl?: string;
  videoSdUrl?: string;
  videoWatermarkUrl?: string;
  audioUrl?: string;
  imageUrls: string[];
  stats?: TikTokScrapeStats;
  hashtags: string[];
  duration?: number;
  raw: Record<string, unknown>;
}
