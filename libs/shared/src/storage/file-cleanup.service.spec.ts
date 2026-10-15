import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileCleanupService } from './file-cleanup.service';

describe('FileCleanupService', () => {
  let tempStoragePath = '';

  beforeEach(async () => {
    tempStoragePath = await fs.mkdtemp(
      path.join(os.tmpdir(), 'file-cleanup-service-'),
    );
  });

  afterEach(async () => {
    await fs.rm(tempStoragePath, { recursive: true, force: true });
  });

  function createService(ttlHours = 1): FileCleanupService {
    return new FileCleanupService(
      new ConfigService({
        STORAGE_PATH: tempStoragePath,
        FILE_CLEANUP_ENABLED: 'true',
        FILE_CLEANUP_TTL_HOURS: String(ttlHours),
      }),
    );
  }

  it('deletes folders older than ttl when manifest is missing', async () => {
    const oldFolderPath = path.join(tempStoragePath, 'old-unique-id');
    await fs.mkdir(oldFolderPath, { recursive: true });
    const oldFilePath = path.join(oldFolderPath, 'video-hd.mp4');
    await fs.writeFile(oldFilePath, Buffer.from('old-file'));

    const oldDate = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(oldFolderPath, oldDate, oldDate);

    const service = createService(1);
    const metrics = await service.runCleanup();

    await expect(fs.access(oldFolderPath)).rejects.toThrow();
    expect(metrics.foldersDeleted).toBe(1);
    expect(metrics.filesDeleted).toBe(1);
    expect(metrics.bytesReclaimed).toBeGreaterThan(0);
  });

  it('keeps folders that are still within ttl', async () => {
    const freshFolderPath = path.join(tempStoragePath, 'fresh-unique-id');
    await fs.mkdir(freshFolderPath, { recursive: true });
    await fs.writeFile(
      path.join(freshFolderPath, 'audio.mp3'),
      Buffer.from('x'),
    );

    const service = createService(1);
    const metrics = await service.runCleanup();

    await expect(fs.access(freshFolderPath)).resolves.toBeUndefined();
    expect(metrics.foldersDeleted).toBe(0);
  });
});
