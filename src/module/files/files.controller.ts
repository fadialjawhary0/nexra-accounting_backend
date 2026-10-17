import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Response } from 'express';
import { contentDisposition } from '../../common/content-disposition.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { FileUploadInterceptor } from './file-upload.interceptor.js';
import { FILE_PURPOSE_KEYS, FILE_TYPES, extensionOf } from './files.constants.js';
import { FilesService } from './files.service.js';

class UploadFileDto {
  @IsIn(FILE_PURPOSE_KEYS) purpose!: string;
  @IsOptional() @IsString() @MaxLength(40) area?: string;
  @IsOptional() @IsString() @MaxLength(40) entityType?: string;
  @IsOptional() @IsString() @MaxLength(60) entityId?: string;
  /** The folder of the client's documents it goes into. */
  @IsOptional() @IsString() @MaxLength(60) folderId?: string;
}

class UpdateFileDto {
  @IsOptional() @IsString() @MaxLength(180) name?: string;
  /** Another folder of the same client; `null` takes the file out of its folder. */
  @IsOptional() @IsString() @MaxLength(60) folderId?: string | null;
}

class DownloadQuery {
  /** Show it in the browser (only PDFs and images ever are); otherwise it is downloaded. */
  @IsOptional() @IsString() inline?: string;
}

/**
 * Upload and open files. What is allowed to be uploaded and who may open a file is decided in FilesService; any signed-in person
 * reaches these routes, the service checks the permission of the file's area.
 */
@Controller('files')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  /** multipart/form-data: `file` + `purpose` (+ `area` for attachments, `entityType`, `entityId`). */
  @UseInterceptors(FileUploadInterceptor)
  @Post()
  upload(@UploadedFile() file: Express.Multer.File | undefined, @Body() dto: UploadFileDto, @CurrentUser() user: AuthenticatedUser) {
    return this.files.upload(file, dto, user);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateFileDto, @CurrentUser() user: AuthenticatedUser) {
    return this.files.update(id, dto, user);
  }

  @Get(':id')
  metadata(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.files.metadata(id, user);
  }

  @Get(':id/download')
  async download(@Param('id') id: string, @Query() query: DownloadQuery, @CurrentUser() user: AuthenticatedUser, @Res({ passthrough: true }) response: Response) {
    const { file, stream } = await this.files.open(id, user);
    const inline = query.inline !== undefined && FILE_TYPES[extensionOf(file.name)]?.inline === true;
    // Nothing a file contains may ever run in the app's origin: no sniffing, no scripts. (The browser's PDF viewer does not work inside a CSP sandbox.)
    const policy = file.mimeType === 'application/pdf' ? "frame-ancestors 'self'" : "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";
    response.set({ 'Cache-Control': 'private, max-age=300', 'Content-Security-Policy': policy, 'X-Content-Type-Options': 'nosniff' });
    return new StreamableFile(stream, { type: file.mimeType, disposition: contentDisposition(inline ? 'inline' : 'attachment', file.name), length: file.size });
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.files.deactivate(id, user);
  }
}
