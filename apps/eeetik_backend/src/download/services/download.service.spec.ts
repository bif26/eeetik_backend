import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DownloadLog,
  DownloadRequestType,
  DownloadStatus,
  PostType,
  PrepareDownloadJobData,
  REDIS_METADATA_LOCK_PREFIX,
  REDIS_METADATA_PREFIX,
  REDIS_UNIQUE_PREFIX,
  TikTokMetadata,
} from '@shared';
import { createHash } from 'node:crypto';
import { Queue } from 'bullmq';
import { Model } from 'mongoose';
import { mapAvailableFormats } from '../helpers/available-formats.mapper';
import { DownloadService } from './download.service';
import { AdGateService } from './ad-gate.service';
import { MediaTransformService } from './media-transform.service';
import { ObjectStorageService } from './object-storage.service';
import { RedisCacheService } from './redis-cache.service';
import { TikTokScraperService } from './tiktok-scraper.service';

interface MetadataCacheRecordFixture {
  uniqueId: string;
  sourceUrl: string;
  postType: PostType;
  title?: string;
  authorName?: string;
  authorAvatarUrl?: string;
  authorAvatarKey?: string;
  stats?: {
    views?: number;
    likes?: number;
    shares?: number;
    comments?: number;
  };
  hashtags: string[];
  duration?: number;
  thumbnailKey?: string;
  imageKeys: string[];
  originalVideoUrl?: string;
  originalAudioUrl?: string;
  originalImageUrls?: string[];
  rawMetadata?: Record<string, unknown>;
}

function hashUrl(url: string): string {
  return createHash('sha256').update(url.trim()).digest('hex');
}

function mockSourceUrlLookup(
  tikTokMetadataFindOne: jest.Mock,
  metadata: Partial<TikTokMetadata> | null,
): void {
  const exec = jest.fn().mockResolvedValue(metadata);
  const lean = jest.fn().mockReturnValue({ exec });
  const sort = jest.fn().mockReturnValue({ lean });

  tikTokMetadataFindOne.mockReturnValue({ sort });
}

function mockUniqueIdLookup(
  tikTokMetadataFindOne: jest.Mock,
  metadata: Partial<TikTokMetadata> | null,
): void {
  const exec = jest.fn().mockResolvedValue(metadata);
  const lean = jest.fn().mockReturnValue({ exec });

  tikTokMetadataFindOne.mockReturnValue({ lean });
}

function createService(configValues: Record<string, string> = {}) {
  const tikTokMetadataFindOne = jest.fn();
  const downloadLogFindOne = jest.fn();
  const downloadLogCreate = jest.fn().mockResolvedValue(undefined);
  const downloadLogAggregateExec = jest
    .fn()
    .mockResolvedValue([{ _id: null, totalBytes: 0 }]);
  const downloadLogAggregate = jest.fn().mockReturnValue({
    exec: downloadLogAggregateExec,
  });
  const queueAdd = jest.fn().mockResolvedValue(undefined);
  const redisGet = jest.fn();
  const redisSet = jest.fn().mockResolvedValue(undefined);
  const redisExists = jest.fn().mockResolvedValue(true);
  const redisAcquireLock = jest.fn().mockResolvedValue(true);
  const redisReleaseLock = jest.fn().mockResolvedValue(undefined);
  const scraperScrape = jest.fn();
  const objectStorageGetSignedUrl = jest.fn();
  const adGateAssertAccess = jest.fn();

  const service = new DownloadService(
    { findOne: tikTokMetadataFindOne } as unknown as Model<TikTokMetadata>,
    {
      findOne: downloadLogFindOne,
      create: downloadLogCreate,
      aggregate: downloadLogAggregate,
    } as unknown as Model<DownloadLog>,
    { add: queueAdd } as unknown as Queue<PrepareDownloadJobData>,
    new ConfigService({
      METADATA_CACHE_TTL_SECONDS: '86400',
      METADATA_SINGLEFLIGHT_WAIT_RETRY_MS: '0',
      PREPARE_WAIT_TIMEOUT_MS: '0',
      ...configValues,
    }),
    {
      get: redisGet,
      set: redisSet,
      exists: redisExists,
      acquireLock: redisAcquireLock,
      releaseLock: redisReleaseLock,
    } as unknown as RedisCacheService,
    { scrape: scraperScrape } as unknown as TikTokScraperService,
    {
      downloadAndConvertToWebp: jest.fn(),
    } as unknown as MediaTransformService,
    {
      getSignedUrl: objectStorageGetSignedUrl,
    } as unknown as ObjectStorageService,
    { assertAccess: adGateAssertAccess } as unknown as AdGateService,
  );

  return {
    service,
    tikTokMetadataFindOne,
    downloadLogFindOne,
    downloadLogCreate,
    downloadLogAggregate,
    downloadLogAggregateExec,
    queueAdd,
    redisGet,
    redisSet,
    redisExists,
    redisAcquireLock,
    redisReleaseLock,
    scraperScrape,
    objectStorageGetSignedUrl,
    adGateAssertAccess,
  };
}

describe('DownloadService preview response mapping', () => {
  it('returns a video preview in the v2 envelope for cached metadata', async () => {
    const {
      service,
      tikTokMetadataFindOne,
      redisGet,
      redisSet,
      redisAcquireLock,
      objectStorageGetSignedUrl,
    } = createService();
    const cacheRecord: MetadataCacheRecordFixture = {
      uniqueId: 'video-uuid',
      sourceUrl: 'https://www.tiktok.com/@creator/video/1',
      postType: PostType.VIDEO,
      title: 'Video caption',
      authorName: 'creator_name',
      authorAvatarKey: 'metadata/video-uuid/avatar.webp',
      stats: {
        views: 297300,
        likes: 26100,
        shares: 1700,
        comments: 93,
      },
      hashtags: ['fyp', ' #travel '],
      duration: 17,
      thumbnailKey: 'metadata/video-uuid/thumbnail.webp',
      imageKeys: [],
    };
    redisGet.mockResolvedValue(cacheRecord);
    objectStorageGetSignedUrl.mockImplementation(
      (uniqueId: string, filename?: string) =>
        filename
          ? `https://cdn.eeetik.app/${uniqueId}/${filename}`
          : `https://cdn.eeetik.app/${uniqueId}`,
    );

    const result = await service.fetchMetadata({ url: cacheRecord.sourceUrl });

    expect(redisAcquireLock).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: true,
      data: {
        uniqueId: 'video-uuid',
        type: PostType.VIDEO,
        title: 'Video caption',
        author: {
          nickname: 'creator_name',
          avatar: 'https://cdn.eeetik.app/video-uuid/avatar.webp',
        },
        stats: {
          views: '297.3K',
          likes: '26.1K',
          shares: '1.7K',
          comments: '93',
        },
        hashtags: ['#fyp', '#travel'],
        availableFormats: mapAvailableFormats(PostType.VIDEO),
        thumbnail: 'https://cdn.eeetik.app/video-uuid/thumbnail.webp',
        duration: 17,
      },
    });
    expect(tikTokMetadataFindOne).not.toHaveBeenCalled();
    expect(objectStorageGetSignedUrl).toHaveBeenCalledTimes(2);
    expect(objectStorageGetSignedUrl).toHaveBeenNthCalledWith(
      1,
      'video-uuid',
      'avatar.webp',
    );
    expect(objectStorageGetSignedUrl).toHaveBeenNthCalledWith(
      2,
      'video-uuid',
      'thumbnail.webp',
    );
    expect(redisSet).toHaveBeenCalledWith(
      `${REDIS_UNIQUE_PREFIX}${cacheRecord.uniqueId}`,
      cacheRecord,
      86400,
    );
  });

  it('returns an image preview in the v2 envelope for cached metadata', async () => {
    const { service, redisGet, redisSet, objectStorageGetSignedUrl } =
      createService();
    const cacheRecord: MetadataCacheRecordFixture = {
      uniqueId: 'image-uuid',
      sourceUrl: 'https://www.tiktok.com/@creator/video/2',
      postType: PostType.IMAGE,
      title: 'Photo carousel',
      hashtags: ['summer', ' #travel ', '#already'],
      imageKeys: [
        'metadata/image-uuid/images/1.webp',
        'metadata/image-uuid/images/2.webp',
      ],
    };
    redisGet.mockResolvedValue(cacheRecord);
    objectStorageGetSignedUrl.mockImplementation(
      (uniqueId: string, filename?: string) =>
        filename
          ? `https://cdn.eeetik.app/${uniqueId}/${filename}`
          : `https://cdn.eeetik.app/${uniqueId}`,
    );

    const result = await service.fetchMetadata({ url: cacheRecord.sourceUrl });

    expect(result).toEqual({
      success: true,
      data: {
        uniqueId: 'image-uuid',
        type: PostType.IMAGE,
        title: 'Photo carousel',
        author: {
          nickname: '',
          avatar: null,
        },
        stats: {
          views: '0',
          likes: '0',
          shares: '0',
          comments: '0',
        },
        hashtags: ['#summer', '#travel', '#already'],
        availableFormats: mapAvailableFormats(PostType.IMAGE),
        images: [
          'https://cdn.eeetik.app/image-uuid/image-1.webp',
          'https://cdn.eeetik.app/image-uuid/image-2.webp',
        ],
      },
    });
    expect(objectStorageGetSignedUrl).toHaveBeenCalledTimes(2);
    expect(objectStorageGetSignedUrl).toHaveBeenNthCalledWith(
      1,
      'image-uuid',
      'image-1.webp',
    );
    expect(objectStorageGetSignedUrl).toHaveBeenNthCalledWith(
      2,
      'image-uuid',
      'image-2.webp',
    );
    expect(redisSet).toHaveBeenCalledWith(
      `${REDIS_UNIQUE_PREFIX}${cacheRecord.uniqueId}`,
      cacheRecord,
      86400,
    );
  });

  it('caches mongo metadata by URL and uniqueId with explicit TTLs', async () => {
    const {
      service,
      tikTokMetadataFindOne,
      redisGet,
      redisSet,
      redisAcquireLock,
      redisReleaseLock,
      scraperScrape,
      objectStorageGetSignedUrl,
    } = createService({
      METADATA_CACHE_URL_TTL_SECONDS: '120',
      METADATA_CACHE_UID_TTL_SECONDS: '300',
    });
    const mongoMetadata: MetadataCacheRecordFixture = {
      uniqueId: 'mongo-uuid',
      sourceUrl: 'https://www.tiktok.com/@creator/video/42',
      postType: PostType.VIDEO,
      title: 'Mongo metadata',
      authorName: 'creator',
      authorAvatarKey: 'metadata/mongo-uuid/avatar.webp',
      stats: {
        views: 1000,
        likes: 100,
        shares: 20,
        comments: 5,
      },
      hashtags: ['tag'],
      duration: 15,
      thumbnailKey: 'metadata/mongo-uuid/thumbnail.webp',
      imageKeys: [],
      originalVideoUrl: 'https://v16-cdn.tiktok.com/video.mp4',
      originalAudioUrl: 'https://v16-cdn.tiktok.com/audio.mp3',
      originalImageUrls: [],
      rawMetadata: { provider: 'tiktok-api-dl' },
    };
    redisGet.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    mockSourceUrlLookup(tikTokMetadataFindOne, mongoMetadata);
    objectStorageGetSignedUrl.mockImplementation(
      (uniqueId: string, filename?: string) =>
        filename
          ? `https://cdn.eeetik.app/${uniqueId}/${filename}`
          : `https://cdn.eeetik.app/${uniqueId}`,
    );

    const result = await service.fetchMetadata({
      url: mongoMetadata.sourceUrl,
    });

    expect(result.success).toBe(true);
    expect(scraperScrape).not.toHaveBeenCalled();
    expect(redisAcquireLock).toHaveBeenCalledWith(
      `${REDIS_METADATA_LOCK_PREFIX}${hashUrl(mongoMetadata.sourceUrl)}`,
      expect.any(String),
      15000,
    );
    expect(redisReleaseLock).toHaveBeenCalledWith(
      `${REDIS_METADATA_LOCK_PREFIX}${hashUrl(mongoMetadata.sourceUrl)}`,
      expect.any(String),
    );
    expect(redisSet).toHaveBeenCalledWith(
      `${REDIS_METADATA_PREFIX}${hashUrl(mongoMetadata.sourceUrl)}`,
      expect.objectContaining({
        uniqueId: mongoMetadata.uniqueId,
        originalVideoUrl: mongoMetadata.originalVideoUrl,
        originalAudioUrl: mongoMetadata.originalAudioUrl,
        originalImageUrls: mongoMetadata.originalImageUrls,
        rawMetadata: mongoMetadata.rawMetadata,
      }),
      120,
    );
    expect(redisSet).toHaveBeenCalledWith(
      `${REDIS_UNIQUE_PREFIX}${mongoMetadata.uniqueId}`,
      expect.objectContaining({
        uniqueId: mongoMetadata.uniqueId,
        originalVideoUrl: mongoMetadata.originalVideoUrl,
        originalAudioUrl: mongoMetadata.originalAudioUrl,
        originalImageUrls: mongoMetadata.originalImageUrls,
        rawMetadata: mongoMetadata.rawMetadata,
      }),
      300,
    );
  });

  it('waits for cache fill when another request owns the metadata lock', async () => {
    const {
      service,
      tikTokMetadataFindOne,
      redisGet,
      redisSet,
      redisExists,
      redisAcquireLock,
      redisReleaseLock,
      scraperScrape,
      objectStorageGetSignedUrl,
    } = createService({
      METADATA_SINGLEFLIGHT_MAX_RETRIES: '2',
    });
    const cacheRecord: MetadataCacheRecordFixture = {
      uniqueId: 'wait-uuid',
      sourceUrl: 'https://www.tiktok.com/@creator/video/88',
      postType: PostType.IMAGE,
      title: 'Waited image post',
      hashtags: ['wait'],
      imageKeys: ['metadata/wait-uuid/images/1.webp'],
    };
    redisGet.mockResolvedValueOnce(null).mockResolvedValueOnce(cacheRecord);
    redisAcquireLock.mockResolvedValue(false);
    objectStorageGetSignedUrl.mockImplementation(
      (uniqueId: string, filename?: string) =>
        filename
          ? `https://cdn.eeetik.app/${uniqueId}/${filename}`
          : `https://cdn.eeetik.app/${uniqueId}`,
    );

    const result = await service.fetchMetadata({ url: cacheRecord.sourceUrl });

    expect(result.success).toBe(true);
    expect(tikTokMetadataFindOne).not.toHaveBeenCalled();
    expect(scraperScrape).not.toHaveBeenCalled();
    expect(redisAcquireLock).toHaveBeenCalledTimes(1);
    expect(redisExists).not.toHaveBeenCalled();
    expect(redisReleaseLock).not.toHaveBeenCalled();
    expect(redisSet).toHaveBeenCalledWith(
      `${REDIS_UNIQUE_PREFIX}${cacheRecord.uniqueId}`,
      cacheRecord,
      86400,
    );
  });
});

describe('DownloadService prepare storage cap gate', () => {
  it('blocks prepare requests when current monthly usage reached the storage cap', async () => {
    const {
      service,
      adGateAssertAccess,
      tikTokMetadataFindOne,
      downloadLogCreate,
      downloadLogAggregateExec,
      queueAdd,
    } = createService({
      STORAGE_MAX_MONTHLY_BYTES: '1000',
    });
    const payload = {
      uniqueId: 'blocked-uuid',
      requestType: DownloadRequestType.HD,
    };
    downloadLogAggregateExec.mockResolvedValue([
      { _id: null, totalBytes: 1000 },
    ]);

    let thrownError: unknown;
    try {
      await service.prepareDownload(payload);
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(ServiceUnavailableException);
    expect((thrownError as ServiceUnavailableException).message).toContain(
      'Monthly storage cap reached (1000/1000 bytes).',
    );
    expect(adGateAssertAccess).toHaveBeenCalledWith(payload);
    expect(tikTokMetadataFindOne).not.toHaveBeenCalled();
    expect(downloadLogCreate).not.toHaveBeenCalled();
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('continues prepare flow when current monthly usage is below the storage cap', async () => {
    const {
      service,
      adGateAssertAccess,
      tikTokMetadataFindOne,
      downloadLogAggregateExec,
      downloadLogCreate,
      queueAdd,
    } = createService({
      STORAGE_MAX_MONTHLY_BYTES: '1000',
    });
    const payload = {
      uniqueId: 'allowed-uuid',
      requestType: DownloadRequestType.SD,
    };
    downloadLogAggregateExec.mockResolvedValue([
      { _id: null, totalBytes: 999 },
    ]);
    mockUniqueIdLookup(tikTokMetadataFindOne, { uniqueId: payload.uniqueId });

    const result = await service.prepareDownload(payload);

    expect(adGateAssertAccess).toHaveBeenCalledWith(payload);
    expect(tikTokMetadataFindOne).toHaveBeenCalledWith({
      uniqueId: payload.uniqueId,
    });
    expect(queueAdd).toHaveBeenCalledWith(
      expect.any(String),
      {
        uniqueId: payload.uniqueId,
        requestType: payload.requestType,
      },
      expect.objectContaining({
        removeOnComplete: 500,
        removeOnFail: 1000,
      }),
    );
    expect(downloadLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        uniqueId: payload.uniqueId,
        requestType: payload.requestType,
        status: DownloadStatus.PROCESSING,
      }),
    );
    expect(typeof result.jobId).toBe('string');
    expect(result.status).toBe(DownloadStatus.PROCESSING);
  });
});
