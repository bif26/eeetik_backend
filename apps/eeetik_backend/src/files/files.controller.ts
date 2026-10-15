import {
  Controller,
  Get,
  Param,
  Query,
  Res,
  NotFoundException,
  ForbiddenException,
  StreamableFile,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { FilesService } from './files.service';

@Controller('api/v2/files')
export class FilesController {
  private readonly logger = new Logger(FilesController.name);

  constructor(private readonly filesService: FilesService) {}

  @Get(':uniqueId/:filename')
  serveFile(
    @Param('uniqueId') uniqueId: string,
    @Param('filename') filename: string,
    @Query('expires') expires: string,
    @Query('sig') signature: string,
    @Res({ passthrough: true }) res: Response,
  ): StreamableFile {
    if (!expires || !signature) {
      this.logger.warn(
        `Missing signature or expiry for ${uniqueId}/${filename}`,
      );
      throw new ForbiddenException('Invalid or missing signature');
    }

    const expiresAt = parseInt(expires, 10);
    if (isNaN(expiresAt)) {
      this.logger.warn(`Invalid expiry timestamp: ${expires}`);
      throw new ForbiddenException('Invalid expiry timestamp');
    }

    try {
      const { stream, contentType, actualFilename } =
        this.filesService.getSignedFile(
          uniqueId,
          filename,
          expiresAt,
          signature,
        );

      res.set({
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${actualFilename}"`,
        'Cache-Control': 'private, max-age=600',
      });

      return new StreamableFile(stream);
    } catch (error) {
      if (error instanceof ForbiddenException) {
        this.logger.warn(
          `Unauthorized access attempt: ${uniqueId}/${filename} - ${(error as Error).message}`,
        );
        throw error;
      }
      this.logger.error(`Error serving file: ${(error as Error).message}`);
      throw new NotFoundException('File not found');
    }
  }
}
