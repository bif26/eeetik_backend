import { DownloadRequestType, PostType } from '@shared';

export interface FormatOption<TId extends DownloadRequestType> {
  id: TId;
  label: string;
}

type VideoFormatOptionId = DownloadRequestType.HD | DownloadRequestType.SD;
type ImageFormatOptionId = DownloadRequestType.ZIP;
type AudioFormatOptionId = DownloadRequestType.AUDIO;

export interface VideoPostAvailableFormats {
  video: FormatOption<VideoFormatOptionId>[];
  audio: FormatOption<AudioFormatOptionId>[];
}

export interface ImagePostAvailableFormats {
  images: FormatOption<ImageFormatOptionId>[];
  audio: FormatOption<AudioFormatOptionId>[];
}

export type AvailableFormats =
  | VideoPostAvailableFormats
  | ImagePostAvailableFormats;

const VIDEO_FORMAT_OPTIONS = [
  {
    id: DownloadRequestType.HD,
    label: 'HD Video (1080p - No Watermark)',
  },
  {
    id: DownloadRequestType.SD,
    label: 'SD Video (720p - No Watermark)',
  },
] as const satisfies readonly FormatOption<VideoFormatOptionId>[];

const VIDEO_AUDIO_FORMAT_OPTIONS = [
  {
    id: DownloadRequestType.AUDIO,
    label: 'Audio Only (MP3)',
  },
] as const satisfies readonly FormatOption<AudioFormatOptionId>[];

const IMAGE_FORMAT_OPTIONS = [
  {
    id: DownloadRequestType.ZIP,
    label: 'Download All (ZIP)',
  },
] as const satisfies readonly FormatOption<ImageFormatOptionId>[];

const IMAGE_AUDIO_FORMAT_OPTIONS = [
  {
    id: DownloadRequestType.AUDIO,
    label: 'Background Music (MP3)',
  },
] as const satisfies readonly FormatOption<AudioFormatOptionId>[];

function cloneFormatOptions<TId extends DownloadRequestType>(
  formatOptions: readonly FormatOption<TId>[],
): FormatOption<TId>[] {
  return formatOptions.map((formatOption) => ({ ...formatOption }));
}

function assertNever(value: never): never {
  throw new Error(`Unsupported post type: ${String(value)}`);
}

export function mapAvailableFormats(
  postType: PostType.VIDEO,
): VideoPostAvailableFormats;
export function mapAvailableFormats(
  postType: PostType.IMAGE,
): ImagePostAvailableFormats;
export function mapAvailableFormats(postType: PostType): AvailableFormats {
  switch (postType) {
    case PostType.VIDEO:
      return {
        video: cloneFormatOptions(VIDEO_FORMAT_OPTIONS),
        audio: cloneFormatOptions(VIDEO_AUDIO_FORMAT_OPTIONS),
      };
    case PostType.IMAGE:
      return {
        images: cloneFormatOptions(IMAGE_FORMAT_OPTIONS),
        audio: cloneFormatOptions(IMAGE_AUDIO_FORMAT_OPTIONS),
      };
    default:
      return assertNever(postType);
  }
}
