import { PostType } from '@shared';
import { mapAvailableFormats } from './available-formats.mapper';

describe('mapAvailableFormats', () => {
  it('returns the required format options for video posts', () => {
    expect(mapAvailableFormats(PostType.VIDEO)).toEqual({
      video: [
        {
          id: 'hd',
          label: 'HD Video (1080p - No Watermark)',
        },
        {
          id: 'sd',
          label: 'SD Video (720p - No Watermark)',
        },
      ],
      audio: [
        {
          id: 'audio',
          label: 'Audio Only (MP3)',
        },
      ],
    });
  });

  it('returns the required format options for image posts', () => {
    expect(mapAvailableFormats(PostType.IMAGE)).toEqual({
      images: [
        {
          id: 'zip',
          label: 'Download All (ZIP)',
        },
      ],
      audio: [
        {
          id: 'audio',
          label: 'Background Music (MP3)',
        },
      ],
    });
  });
});
