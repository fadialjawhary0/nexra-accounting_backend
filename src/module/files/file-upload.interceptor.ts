import { BadRequestException, type CallHandler, type ExecutionContext, Injectable, type NestInterceptor, PayloadTooLargeException } from '@nestjs/common';
import multer from 'multer';
import type { Observable } from 'rxjs';
import { SettingsService } from '../../lib/settings/settings.service.js';
import { SECURITY_NAMESPACE } from '../security-settings/security-settings.definitions.js';

/**
 * Reads one multipart `file` (plus the text fields) into memory — with the limit Ahmad set in Settings → Security at this very moment,
 * which is why this is not Nest's `FileInterceptor` (its limit is fixed when the app starts). Too-large files are refused while they
 * are still arriving.
 */
@Injectable()
export class FileUploadInterceptor implements NestInterceptor {
  constructor(private readonly settings: SettingsService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const maxMegabytes = this.settings.get<number>(`${SECURITY_NAMESPACE}.uploadMaxMegabytes`);
    const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxMegabytes * 1024 * 1024, files: 1, fields: 10, parts: 12 } }).single('file');
    const http = context.switchToHttp();

    await new Promise<void>((resolve, reject) => {
      upload(http.getRequest(), http.getResponse(), (error?: unknown) => {
        if (!error) return resolve();
        if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
          return reject(new PayloadTooLargeException({ code: 'file_too_large', message: `The file is larger than ${maxMegabytes} MB.`, details: { maxMegabytes } }));
        }
        return reject(new BadRequestException({ code: 'file_missing', message: 'The upload could not be read. Choose the file again.' }));
      });
    });
    return next.handle();
  }
}
