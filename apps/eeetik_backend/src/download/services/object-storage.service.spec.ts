import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { UrlSigningService } from '@shared';
import { ObjectStorageService } from './object-storage.service';

describe('ObjectStorageService', () => {
  let tempStoragePath = '';
  let service: ObjectStorageService;
  let generateSignedUrl: jest.Mock;

  beforeEach(async () => {
    tempStoragePath = await fs.mkdtemp(
      path.join(os.tmpdir(), 'object-storage-service-'),
    );
    generateSignedUrl = jest.fn().mockReturnValue('/signed-url');

    service = new ObjectStorageService(
      new ConfigService({
        STORAGE_PATH: tempStoragePath,
      }),
      {
        generateSignedUrl,
      } as unknown as UrlSigningService,
    );
  });

  afterEach(async () => {
    await fs.rm(tempStoragePath, { recursive: true, force: true });
  });

  it('stores and reads files in uniqueId folders', async () => {
    await service.putBuffer('unique-1', 'thumbnail.webp', Buffer.from('abc'));

    expect(await service.fileExists('unique-1', 'thumbnail.webp')).toBe(true);
    await expect(
      service.getObjectBuffer('unique-1', 'thumbnail.webp'),
    ).resolves.toEqual(Buffer.from('abc'));
  });

  it('maps legacy image keys to image-{index}.webp for signed URLs', () => {
    const signedUrl = service.getSignedUrl('metadata/unique-2/images/2.webp');

    expect(signedUrl).toBe('/signed-url');
    expect(generateSignedUrl).toHaveBeenCalledWith(
      'unique-2',
      'image-2.webp',
      undefined,
    );
  });
});
