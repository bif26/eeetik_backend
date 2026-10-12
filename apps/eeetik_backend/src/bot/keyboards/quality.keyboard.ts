import { InlineKeyboard } from 'grammy';
import { DownloadRequestType, PostType } from '@shared';

export const QUALITY_CALLBACK_PREFIX = 'quality';
export const BACK_CALLBACK = 'back:main';

export type QualityCallbackQuality =
  | DownloadRequestType.HD
  | DownloadRequestType.SD
  | DownloadRequestType.AUDIO
  | DownloadRequestType.ZIP;

export function buildQualityCallbackData(
  uniqueId: string,
  quality: QualityCallbackQuality,
): string {
  return `${QUALITY_CALLBACK_PREFIX}:${uniqueId}:${quality}`;
}

export function parseQualityCallbackData(
  data: string,
): { uniqueId: string; quality: QualityCallbackQuality } | null {
  const pattern = new RegExp(
    `^${QUALITY_CALLBACK_PREFIX}:([^:]+):(${Object.values(DownloadRequestType).join('|')})$`,
  );
  const match = pattern.exec(data);
  if (!match) {
    return null;
  }

  return { uniqueId: match[1], quality: match[2] as QualityCallbackQuality };
}

/**
 * Inline keyboard layout:
 *   video posts: [HD 1080p] [SD 720p] / [Audio MP3] [Images ZIP] / [Back]
 *   image posts: [Images ZIP] / [Audio MP3] / [Back]
 *
 * Callback data format: `quality:{uniqueId}:{quality}`
 */
export function buildQualityKeyboard(
  postType: PostType,
  uniqueId: string,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const qualityData = (quality: QualityCallbackQuality) =>
    buildQualityCallbackData(uniqueId, quality);

  if (postType === PostType.VIDEO) {
    keyboard
      .text('HD 1080p', qualityData(DownloadRequestType.HD))
      .text('SD 720p', qualityData(DownloadRequestType.SD));
    keyboard.row().text('Audio MP3', qualityData(DownloadRequestType.AUDIO));
  } else {
    keyboard.text('Images ZIP', qualityData(DownloadRequestType.ZIP));
    keyboard.row().text('Audio MP3', qualityData(DownloadRequestType.AUDIO));
  }

  keyboard.row().text('Back', BACK_CALLBACK);
  return keyboard;
}
