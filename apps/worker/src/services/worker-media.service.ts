import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import archiver from 'archiver';
import { PassThrough, Readable } from 'node:stream';
import { createWriteStream } from 'node:fs';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class WorkerMediaService {
  constructor(private readonly httpService: HttpService) {}

  async downloadAsBuffer(url: string): Promise<Buffer> {
    const response = await firstValueFrom(
      this.httpService.get<ArrayBuffer>(url, {
        responseType: 'arraybuffer',
      }),
    );

    return Buffer.from(response.data);
  }

  async downloadAsStream(url: string): Promise<Readable> {
    const response = await firstValueFrom(
      this.httpService.get<Readable>(url, {
        responseType: 'stream',
      }),
    );

    return response.data;
  }

  /**
   * Streams a remote file to a local temp path and returns the number of
   * bytes written. Used by the Telegram upload pipeline.
   */
  async downloadToFile(url: string, filePath: string): Promise<number> {
    const response = await firstValueFrom(
      this.httpService.get<Readable>(url, {
        responseType: 'stream',
        maxContentLength: undefined,
      }),
    );

    let downloadedBytes = 0;
    const countingStream = new PassThrough();
    response.data.on('data', (chunk: Buffer | Uint8Array | string) => {
      downloadedBytes += this.readChunkByteLength(chunk);
    });
    response.data.pipe(countingStream);

    const writeStream = createWriteStream(filePath);
    return new Promise<number>((resolve, reject) => {
      countingStream.pipe(writeStream);
      writeStream.on('finish', () => resolve(downloadedBytes));
      writeStream.on('error', reject);
      countingStream.on('error', reject);
      response.data.on('error', reject);
    });
  }

  private readChunkByteLength(chunk: Buffer | Uint8Array | string): number {
    if (typeof chunk === 'string') {
      return Buffer.byteLength(chunk);
    }

    return chunk.byteLength;
  }

  async buildZip(
    files: Array<{ name: string; body: Buffer }>,
  ): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const archive = archiver('zip', { zlib: { level: 9 } });
      const output = new PassThrough();
      const chunks: Buffer[] = [];

      output.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      output.on('end', () => {
        resolve(Buffer.concat(chunks));
      });
      output.on('error', (error) => reject(error));
      archive.on('error', (error) => reject(error));

      archive.pipe(output);
      for (const file of files) {
        archive.append(file.body, { name: file.name });
      }

      void archive.finalize();
    });
  }
}
