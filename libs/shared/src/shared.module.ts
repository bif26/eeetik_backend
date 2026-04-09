import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SharedService } from './shared.service';
import { UrlSigningService } from './security';
import { FileCleanupService } from './storage';

@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [SharedService, UrlSigningService, FileCleanupService],
  exports: [SharedService, UrlSigningService, FileCleanupService],
})
export class SharedModule {}
