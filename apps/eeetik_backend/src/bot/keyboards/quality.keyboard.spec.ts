import { DownloadRequestType, PostType } from '@shared';
import type { InlineKeyboardButton } from 'grammy/types';
import {
  BACK_CALLBACK,
  buildQualityCallbackData,
  buildQualityKeyboard,
  parseQualityCallbackData,
} from './quality.keyboard';

function getRows(
  keyboard: ReturnType<typeof buildQualityKeyboard>,
): InlineKeyboardButton[][] {
  return (keyboard as unknown as { inline_keyboard: InlineKeyboardButton[][] })
    .inline_keyboard;
}

function getLabels(
  keyboard: ReturnType<typeof buildQualityKeyboard>,
): string[] {
  return getRows(keyboard)
    .flat()
    .map((button) => ('text' in button ? button.text : ''));
}

describe('quality keyboard', () => {
  it('builds the video layout with HD/SD/Audio and a Back button', () => {
    const keyboard = buildQualityKeyboard(PostType.VIDEO, 'uid-video-1');
    const labels = getLabels(keyboard);

    // ZIP is an image-gallery format – hidden for video posts.
    expect(labels).toEqual(['HD 1080p', 'SD 720p', 'Audio MP3', 'Back']);

    const rows = getRows(keyboard);
    expect(rows[0][0]).toMatchObject({
      text: 'HD 1080p',
      callback_data: 'quality:uid-video-1:hd',
    });
    expect(rows[0][1]).toMatchObject({
      text: 'SD 720p',
      callback_data: 'quality:uid-video-1:sd',
    });
    expect(rows[1][0]).toMatchObject({
      text: 'Audio MP3',
      callback_data: 'quality:uid-video-1:audio',
    });
    expect(rows[2][0]).toMatchObject({
      text: 'Back',
      callback_data: BACK_CALLBACK,
    });
  });

  it('builds the image-post layout without video quality options', () => {
    const keyboard = buildQualityKeyboard(PostType.IMAGE, 'uid-image-1');
    const labels = getLabels(keyboard);

    expect(labels).toEqual(['Images ZIP', 'Audio MP3', 'Back']);
    expect(labels).not.toContain('HD 1080p');
  });

  it('round-trips callback data through the parser', () => {
    expect(
      parseQualityCallbackData(
        buildQualityCallbackData('uid-abc', DownloadRequestType.HD),
      ),
    ).toEqual({ uniqueId: 'uid-abc', quality: DownloadRequestType.HD });

    expect(parseQualityCallbackData('quality:uid-abc:audio')).toEqual({
      uniqueId: 'uid-abc',
      quality: DownloadRequestType.AUDIO,
    });
  });

  it('rejects malformed callback payloads', () => {
    expect(parseQualityCallbackData('quality:uid-abc:4k')).toBeNull();
    expect(parseQualityCallbackData('quality:uid-abc')).toBeNull();
    expect(parseQualityCallbackData('help:main')).toBeNull();
    expect(parseQualityCallbackData('')).toBeNull();
  });
});
