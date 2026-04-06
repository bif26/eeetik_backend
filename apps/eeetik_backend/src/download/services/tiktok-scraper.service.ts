import { BadGatewayException, Injectable } from '@nestjs/common';
import TikTokApiDl from '@tobyg74/tiktok-api-dl';
import { TikTokScrapeResult, TikTokScrapeStats } from '@shared';

@Injectable()
export class TikTokScraperService {
  async scrape(url: string): Promise<TikTokScrapeResult> {
    const response = await TikTokApiDl.Downloader(url, { version: 'v1' });
    if (response.status !== 'success' || !response.result) {
      throw new BadGatewayException(
        response.message || 'Unable to fetch TikTok metadata',
      );
    }

    const content = response.result;
    const imageUrls = Array.isArray(content.images)
      ? content.images.filter(
          (item): item is string => typeof item === 'string',
        )
      : [];
    const videoCdnCandidates = [
      content.videoHD,
      content.videoSD,
      content.video?.playAddr?.[0],
      content.video?.downloadAddr?.[0],
      content.direct,
    ];
    const author = this.asRecord(content.author);
    const hashtags = Array.isArray(content.hashtag)
      ? content.hashtag.filter(
          (item): item is string => typeof item === 'string',
        )
      : [];

    return {
      title: content.desc,
      authorName: content.author?.nickname,
      authorAvatarUrl: this.firstString([
        author?.avatar,
        author?.avatarThumb,
        author?.avatarMedium,
        author?.avatarLarge,
        author?.avatarLarger,
      ]),
      thumbnailUrl:
        content.video?.originCover?.[0] ??
        content.video?.cover?.[0] ??
        undefined,
      videoUrl: videoCdnCandidates.find(
        (candidate): candidate is string => typeof candidate === 'string',
      ),
      audioUrl: content.music?.playUrl?.[0],
      imageUrls,
      stats: this.extractStats(content.statistics),
      hashtags,
      duration: this.toNumber(
        content.video?.duration ?? content.music?.duration,
      ),
      raw: response as unknown as Record<string, unknown>,
    };
  }

  private extractStats(statistics: unknown): TikTokScrapeStats | undefined {
    const statsRecord = this.asRecord(statistics);
    if (!statsRecord) {
      return undefined;
    }

    const stats: TikTokScrapeStats = {
      views: this.toNumber(statsRecord.playCount),
      likes: this.toNumber(statsRecord.likeCount),
      shares: this.toNumber(statsRecord.shareCount),
      comments: this.toNumber(statsRecord.commentCount),
    };

    if (Object.values(stats).every((value) => value === undefined)) {
      return undefined;
    }

    return stats;
  }

  private firstString(values: unknown[]): string | undefined {
    for (const value of values) {
      if (typeof value === 'string') {
        return value;
      }

      if (Array.isArray(value)) {
        const candidate = value.find(
          (entry): entry is string => typeof entry === 'string',
        );
        if (candidate) {
          return candidate;
        }
      }
    }

    return undefined;
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    if (typeof value === 'object' && value !== null) {
      return value as Record<string, unknown>;
    }

    return undefined;
  }

  private toNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value !== 'string') {
      return undefined;
    }

    const normalized = value.trim().replace(/,/g, '');
    if (!normalized) {
      return undefined;
    }

    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
}
