import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import archiver from 'archiver';
import { PassThrough, Readable } from 'node:stream';
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
