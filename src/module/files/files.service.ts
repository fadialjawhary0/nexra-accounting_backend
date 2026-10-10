import { BadRequestException, ForbiddenException, Injectable, NotFoundException, PayloadTooLargeException, UnprocessableEntityException, UnsupportedMediaTypeException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { StoredFile } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { StorageService } from '../../lib/storage/storage.service.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { PERMISSION_AREAS, matrixAllows } from '../roles/permission-catalog.js';
import { FILE_PURPOSES, FILE_TYPES, extensionOf } from './files.constants.js';

const AREA_KEYS = new Set(PERMISSION_AREAS.map(area => area.key));
/** How much of a file is read to check that it really is what its name says. */
const SNIFF_BYTES = 4096;

/** A file name people can see everywhere: no path separators, no control characters, not endless. */
const safeName = (value: string): string =>
  [...value]
    .map(character => (character.charCodeAt(0) < 32 || character === '/' || character === '\\' ? '_' : character))
    .join('')
    .trim()
    .slice(0, 180);

export interface UploadInput {
  purpose: string;
  /** Attachments: the permission area the file belongs to (`companies`, `employees` …). */
  area?: string;
  entityType?: string;
  entityId?: string;
}

/** What the API shows of a file. The bytes are fetched separately (`GET /files/:id/download`). */
export const serializeFile = (file: StoredFile) => ({
  id: file.id,
  name: file.name,
  mimeType: file.mimeType,
  size: file.size,
  purpose: file.purpose,
  area: file.area,
  entityType: file.entityType,
  entityId: file.entityId,
  active: file.isActive,
  uploadedById: file.uploadedById,
  createdAt: file.createdAt.toISOString(),
});

/**
 * Uploaded files: type and size are checked, the bytes go to the storage driver, the metadata to the database. Opening a file needs the
 * `view` permission of the area it belongs to; files are deactivated, never deleted (they stay for history and inspections).
 */
@Injectable()
export class FilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  async upload(file: Express.Multer.File | undefined, input: UploadInput, user: AuthenticatedUser) {
    if (!file) throw new BadRequestException({ code: 'file_missing', message: 'Choose a file to upload.' });
    const purpose = FILE_PURPOSES[input.purpose];
    if (!purpose) throw new UnprocessableEntityException({ code: 'validation_failed', message: 'Validation failed', fields: { purpose: 'validation.selectOption' } });

    const area = purpose.area === 'request' ? (input.area ?? null) : null;
    if (purpose.area === 'request') {
      if (!area || !AREA_KEYS.has(area)) throw new UnprocessableEntityException({ code: 'validation_failed', message: 'Validation failed', fields: { area: 'validation.selectOption' } });
      if (!matrixAllows(user.matrix, `${area}.create`) && !matrixAllows(user.matrix, `${area}.edit`)) this.forbidden();
    } else if (!matrixAllows(user.matrix, purpose.upload)) {
      this.forbidden();
    }

    // The browser sends the name as latin1 bytes; turn it back into the text the person saw.
    const name = safeName(Buffer.from(file.originalname, 'latin1').toString('utf8'));
    const extension = extensionOf(name);
    const type = FILE_TYPES[extension];
    if (!name || !type || !purpose.extensions.includes(extension)) {
      throw new UnsupportedMediaTypeException({ code: 'file_type_not_allowed', message: 'This type of file is not allowed.', details: { allowed: purpose.extensions } });
    }
    if (file.size === 0) throw new BadRequestException({ code: 'file_empty', message: 'The file is empty.' });
    if (purpose.maxMegabytes && file.size > purpose.maxMegabytes * 1024 * 1024) {
      throw new PayloadTooLargeException({ code: 'file_too_large', message: `The file is larger than ${purpose.maxMegabytes} MB.`, details: { maxMegabytes: purpose.maxMegabytes } });
    }
    if (!type.matches(file.buffer.subarray(0, SNIFF_BYTES))) {
      throw new UnsupportedMediaTypeException({ code: 'file_content_mismatch', message: 'The content of the file does not match its type.' });
    }

    const storageKey = `files/${randomUUID()}`;
    await this.storage.put(storageKey, file.buffer);
    const row = await this.prisma.storedFile.create({
      data: {
        name,
        mimeType: type.mime,
        size: file.size,
        sha256: createHash('sha256').update(file.buffer).digest('hex'),
        storageKey,
        purpose: input.purpose,
        area,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        uploadedById: user.id,
      },
    });
    await this.audit.log({ action: 'created', entityType: 'file', entityId: row.id, entityLabel: row.name, after: { purpose: row.purpose, area: row.area, size: row.size } });
    return serializeFile(row);
  }

  async metadata(id: string, user: AuthenticatedUser) {
    return serializeFile(await this.readable(id, user));
  }

  /** The file and its bytes, for someone who may view it. */
  async open(id: string, user: AuthenticatedUser): Promise<{ file: StoredFile; stream: Readable }> {
    const file = await this.readable(id, user);
    if (!(await this.storage.exists(file.storageKey))) throw new NotFoundException({ code: 'not_found', message: 'The file is no longer available.' });
    return { file, stream: await this.storage.get(file.storageKey) };
  }

  async deactivate(id: string, user: AuthenticatedUser) {
    const file = await this.prisma.storedFile.findUnique({ where: { id } });
    if (!file) throw new NotFoundException({ code: 'not_found', message: 'File not found' });
    if (!matrixAllows(user.matrix, file.area ? `${file.area}.edit` : (FILE_PURPOSES[file.purpose]?.upload ?? 'settings.edit'))) this.forbidden();
    if (file.isActive) await this.deactivateRow(file);
    return { id };
  }

  /** Switches a file off without checking who asks (used when a record replaces its file, e.g. a new office logo). Unknown ids are ignored. */
  async retire(id: string | null | undefined): Promise<void> {
    if (!id) return;
    const file = await this.prisma.storedFile.findUnique({ where: { id } });
    if (file?.isActive) await this.deactivateRow(file);
  }

  /** The file must exist, be active and have been uploaded for `purpose` — for settings that point at a file. */
  async assertUsable(id: string, purpose: string): Promise<void> {
    const file = await this.prisma.storedFile.findUnique({ where: { id } });
    if (!file || !file.isActive || file.purpose !== purpose) {
      throw new UnprocessableEntityException({ code: 'validation_failed', message: 'Validation failed', fields: { logoFileId: 'validation.invalid' } });
    }
  }

  /** Ties uploaded files to the record they ended up on (called by the feature that saves the record). */
  async link(ids: string[], entityType: string, entityId: string): Promise<void> {
    if (!ids.length) return;
    await this.prisma.storedFile.updateMany({ where: { id: { in: ids } }, data: { entityType, entityId } });
  }

  private async readable(id: string, user: AuthenticatedUser): Promise<StoredFile> {
    const file = await this.prisma.storedFile.findUnique({ where: { id } });
    if (!file) throw new NotFoundException({ code: 'not_found', message: 'File not found' });
    if (file.area && !matrixAllows(user.matrix, `${file.area}.view`)) this.forbidden();
    return file;
  }

  private async deactivateRow(file: StoredFile): Promise<void> {
    await this.prisma.storedFile.update({ where: { id: file.id }, data: { isActive: false, deactivatedAt: new Date() } });
    await this.audit.log({ action: 'deactivated', entityType: 'file', entityId: file.id, entityLabel: file.name });
  }

  private forbidden(): never {
    throw new ForbiddenException({ code: 'forbidden', message: 'You do not have access to this.' });
  }
}
