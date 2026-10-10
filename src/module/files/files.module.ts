import { Module } from '@nestjs/common';
import { FileUploadInterceptor } from './file-upload.interceptor.js';
import { FilesController } from './files.controller.js';
import { FilesService } from './files.service.js';

@Module({
  controllers: [FilesController],
  providers: [FilesService, FileUploadInterceptor],
  exports: [FilesService],
})
export class FilesModule {}
