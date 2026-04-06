import { PostType } from '@shared';
import {
  ImagePostAvailableFormats,
  VideoPostAvailableFormats,
} from '../helpers/available-formats.mapper';

export interface TikTokPreviewAuthor {
  nickname: string;
  avatar: string | null;
}

export interface TikTokPreviewStats {
  views: string;
  likes: string;
  shares: string;
  comments: string;
}

interface TikTokPreviewDataBase {
  uniqueId: string;
  type: PostType;
  title: string;
  author: TikTokPreviewAuthor;
  stats: TikTokPreviewStats;
  hashtags: string[];
}

export interface TikTokVideoPreviewData extends TikTokPreviewDataBase {
  type: PostType.VIDEO;
  availableFormats: VideoPostAvailableFormats;
  thumbnail: string | null;
  duration: number;
}

export interface TikTokImagePreviewData extends TikTokPreviewDataBase {
  type: PostType.IMAGE;
  availableFormats: ImagePostAvailableFormats;
  images: string[];
}

export type TikTokPreviewData = TikTokVideoPreviewData | TikTokImagePreviewData;

export interface TikTokPreviewResponse {
  success: true;
  data: TikTokPreviewData;
}
