import { BadRequestException, type CallHandler, type ExecutionContext, Injectable, type NestInterceptor, PayloadTooLargeException } from '@nestjs/common';
import multer from 'multer';
import type { Observable } from 'rxjs';
import { SettingsService } from '../../lib/settings/settings.service.js';
import { SECURITY_NAMESPACE } from '../security-settings/security-settings.definitions.js';
import { IMPORTS_NAMESPACE, MAX_FILES_PER_REQUEST } from './imports.constants.js';

function failure(error: unknown, maxMegabytes: number): Error {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    return new PayloadTooLargeException({ code: 'file_too_large', message: `A file is larger than ${maxMegabytes} MB.`, details: { maxMegabytes } });
  }
  if (error instanceof multer.MulterError && (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE')) {
    return new BadRequestException({ code: 'too_many_files', message: `Send at most ${MAX_FILES_PER_REQUEST} files at a time.` });
  }
  return new BadRequestException({ code: 'file_missing', message: 'The upload could not be read. Choose the files again.' });
}

/**
 * Reads several files of an import (multipart `files`) into memory, with the upload limit of Settings → Security at this very moment. The path of
 * a file inside a chosen folder travels as its file name (`042- Bakkerij/Contracten/jan.pdf`), which is why the path is kept.
 */
@Injectable()
export class ImportFilesInterceptor implements NestInterceptor {
  constructor(private readonly settings: SettingsService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const maxMegabytes = this.settings.get<number>(`${SECURITY_NAMESPACE}.uploadMaxMegabytes`);
    const upload = multer({ storage: multer.memoryStorage(), preservePath: true, limits: { fileSize: maxMegabytes * 1024 * 1024, files: MAX_FILES_PER_REQUEST, fields: 5, parts: MAX_FILES_PER_REQUEST + 5 } }).array('files', MAX_FILES_PER_REQUEST);
    const http = context.switchToHttp();
    await new Promise<void>((resolve, reject) => {
      upload(http.getRequest(), http.getResponse(), (error?: unknown) => (error ? reject(failure(error, maxMegabytes)) : resolve()));
    });
    return next.handle();
  }
}

/** One ZIP file (multipart `file`) of an import: bigger than an ordinary upload, with its own limit (Settings → Import). */
@Injectable()
export class ImportZipInterceptor implements NestInterceptor {
  constructor(private readonly settings: SettingsService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const maxMegabytes = this.settings.get<number>(`${IMPORTS_NAMESPACE}.maxZipMegabytes`);
    const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxMegabytes * 1024 * 1024, files: 1, fields: 5, parts: 6 } }).single('file');
    const http = context.switchToHttp();
    await new Promise<void>((resolve, reject) => {
      upload(http.getRequest(), http.getResponse(), (error?: unknown) => (error ? reject(failure(error, maxMegabytes)) : resolve()));
    });
    return next.handle();
  }
}
