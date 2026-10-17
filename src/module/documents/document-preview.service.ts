import { Injectable, NotFoundException, UnsupportedMediaTypeException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { DocumentsService as OfficeDocumentsService } from '../../lib/documents/documents.service.js';
import { StorageService } from '../../lib/storage/storage.service.js';
import { extensionOf } from '../files/files.constants.js';
import { FilesService } from '../files/files.service.js';
import { DocumentsService, previewKind } from './documents.service.js';

/** A text file larger than this is downloaded, not shown. */
const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;

export interface Preview {
  stream: Readable | Buffer;
  /** The type the browser shows it as; a Word file is shown as the PDF made of it. */
  mime: string;
  /** The name for the download button of the viewer. */
  name: string;
  length?: number;
}

/**
 * Looking at a document without downloading it: a PDF or an image as it is, plain text as text, a Word / Excel / PowerPoint / OpenDocument file through the
 * PDF LibreOffice makes of it (made the first time, kept next to the file). Everything else can only be downloaded.
 */
@Injectable()
export class DocumentPreviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly files: FilesService,
    private readonly documents: DocumentsService,
    private readonly office: OfficeDocumentsService,
  ) {}

  async open(id: string, user: AuthenticatedUser): Promise<Preview> {
    const file = await this.documents.readable(id, user);
    const kind = previewKind(file.name);
    if (kind === 'pdf' || kind === 'image') {
      if (!(await this.storage.exists(file.storageKey))) throw new NotFoundException({ code: 'not_found', message: 'The file is no longer available.' });
      return { stream: await this.storage.get(file.storageKey), mime: file.mimeType, name: file.name, length: file.size };
    }
    if (kind === 'text') {
      if (file.size > MAX_TEXT_PREVIEW_BYTES) throw this.unavailable();
      const { buffer } = await this.files.bytes(id);
      return { stream: buffer, mime: 'text/plain; charset=utf-8', name: file.name, length: buffer.length };
    }
    if (kind !== 'convert') throw this.unavailable();

    if (file.previewKey && (await this.storage.exists(file.previewKey))) {
      return { stream: await this.storage.get(file.previewKey), mime: 'application/pdf', name: `${file.name.replace(/\.[^.]+$/, '')}.pdf` };
    }
    const { buffer } = await this.files.bytes(id);
    const pdf = await this.office.anyToPdf(buffer, extensionOf(file.name));
    const key = `previews/${randomUUID()}`;
    await this.storage.put(key, pdf);
    await this.prisma.storedFile.update({ where: { id }, data: { previewKey: key } });
    return { stream: pdf, mime: 'application/pdf', name: `${file.name.replace(/\.[^.]+$/, '')}.pdf`, length: pdf.length };
  }

  private unavailable(): UnsupportedMediaTypeException {
    return new UnsupportedMediaTypeException({ code: 'preview_unavailable', message: 'This kind of file cannot be shown here. Download it to open it.' });
  }
}
