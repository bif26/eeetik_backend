import { Module } from '@nestjs/common';
import { SharedModule } from '@shared';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';

@Module({
  imports: [SharedModule],
  controllers: [FilesController],
  providers: [FilesService],
  exports: [FilesService],
})
export class FilesModule {}
