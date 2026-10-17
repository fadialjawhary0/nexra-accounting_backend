import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable, Logger, NotFoundException, PayloadTooLargeException, UnprocessableEntityException, UnsupportedMediaTypeException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { Prisma, StoredFile } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { QueueService } from '../../lib/queue/queue.service.js';
import { SettingsService } from '../../lib/settings/settings.service.js';
import { StorageService } from '../../lib/storage/storage.service.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { PERMISSION_AREAS, matrixAllows } from '../roles/permission-catalog.js';
import { SECURITY_NAMESPACE } from '../security-settings/security-settings.definitions.js';
import { DOCUMENT_INDEX_QUEUE, DOCUMENT_PURPOSES, FILE_KIND_SETTINGS, FILE_PURPOSES, FILE_TYPES, extensionOf } from './files.constants.js';

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

const day = (value: string | null | undefined): Date | null => (value ? new Date(`${value}T00:00:00.000Z`) : null);

/** What a document is, when the file is a document of the office (the Documents page sets these; the generators and the import too). */
export interface DocumentMeta {
  /** The name to keep instead of the one the browser sent (a name made from a pattern; the extension must be the file's own). */
  name?: string;
  docType?: string | null;
  /** The date on the document, `YYYY-MM-DD`. */
  docDate?: string | null;
  /** The last day it is valid, `YYYY-MM-DD`, for types that carry their own end date. */
  validUntil?: string | null;
  /** The stretch of time the document is about (a VAT return of one quarter, a statement of one month), `YYYY-MM-DD`; inspections ask for documents by period. */
  periodFrom?: string | null;
  periodTo?: string | null;
  /** A new version of an earlier document: the id of the first version, and this file's number. */
  rootId?: string | null;
  version?: number;
}

export interface UploadInput {
  purpose: string;
  /** Attachments: the permission area the file belongs to (`clients`, `employees` …). */
  area?: string;
  entityType?: string;
  entityId?: string;
  /** The folder of the client's documents to put it in. */
  folderId?: string;
  meta?: DocumentMeta;
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
  clientId: file.clientId,
  folderId: file.folderId,
  docType: file.docType,
  docDate: file.docDate ? file.docDate.toISOString().slice(0, 10) : null,
  validUntil: file.validUntil ? file.validUntil.toISOString().slice(0, 10) : null,
  periodFrom: file.periodFrom ? file.periodFrom.toISOString().slice(0, 10) : null,
  periodTo: file.periodTo ? file.periodTo.toISOString().slice(0, 10) : null,
  version: file.version,
  isCurrent: file.isCurrent,
  active: file.isActive,
  uploadedById: file.uploadedById,
  createdAt: file.createdAt.toISOString(),
});

/**
 * Uploaded files: type and size are checked, the bytes go to the storage driver, the metadata to the database. Opening a file needs the
 * `view` permission of the area it belongs to; files are deactivated, never deleted (they stay for history and inspections). Every file that is a
 * document of a client knows that client (`clientId`) and is read for the content search in the background.
 */
@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
    private readonly settings: SettingsService,
  ) {}

  /** Whether the office allows this kind of file (Settings → Security policy): PDF always, the rest by group. */
  private kindAllowed(extension: string): boolean {
    const group = Object.entries(FILE_KIND_SETTINGS).find(([, extensions]) => extensions.includes(extension));
    return !group || this.settings.get<boolean>(`${SECURITY_NAMESPACE}.${group[0]}`);
  }

  /** A person may upload so many files an hour (Settings → Security policy): a runaway script or a stuck loop cannot fill the storage. */
  private async assertUploadRate(userId: string): Promise<void> {
    const limit = this.settings.get<number>(`${SECURITY_NAMESPACE}.uploadsPerHour`);
    const recent = await this.prisma.storedFile.count({ where: { uploadedById: userId, createdAt: { gte: new Date(Date.now() - 3_600_000) } } });
    if (recent >= limit) throw new HttpException({ code: 'upload_limit', message: 'Too many files were uploaded in the last hour. Try again later.', details: { limit } }, HttpStatus.TOO_MANY_REQUESTS);
  }

  async upload(file: Express.Multer.File | undefined, input: UploadInput, user: AuthenticatedUser) {
    if (!file) throw new BadRequestException({ code: 'file_missing', message: 'Choose a file to upload.' });
    await this.assertUploadRate(user.id);
    const purpose = FILE_PURPOSES[input.purpose];
    if (!purpose || purpose.internal) throw new UnprocessableEntityException({ code: 'validation_failed', message: 'Validation failed', fields: { purpose: 'validation.selectOption' } });

    const area = purpose.area === 'request' ? (input.area ?? null) : purpose.area;
    if (purpose.area === 'request') {
      if (!area || !AREA_KEYS.has(area)) throw new UnprocessableEntityException({ code: 'validation_failed', message: 'Validation failed', fields: { area: 'validation.selectOption' } });
      if (!matrixAllows(user.matrix, `${area}.create`) && !matrixAllows(user.matrix, `${area}.edit`)) this.forbidden();
    } else if (!matrixAllows(user.matrix, purpose.upload)) {
      this.forbidden();
    }

    // The browser sends the name as latin1 bytes; turn it back into the text the person saw.
    const name = safeName(input.meta?.name ?? Buffer.from(file.originalname, 'latin1').toString('utf8'));
    const extension = extensionOf(name);
    const type = FILE_TYPES[extension];
    if (!name || !type || !purpose.extensions.includes(extension) || !this.kindAllowed(extension)) {
      throw new UnsupportedMediaTypeException({ code: 'file_type_not_allowed', message: 'This type of file is not allowed.', details: { allowed: purpose.extensions.filter(entry => this.kindAllowed(entry)) } });
    }
    if (file.size === 0) throw new BadRequestException({ code: 'file_empty', message: 'The file is empty.' });
    if (purpose.maxMegabytes && file.size > purpose.maxMegabytes * 1024 * 1024) {
      throw new PayloadTooLargeException({ code: 'file_too_large', message: `The file is larger than ${purpose.maxMegabytes} MB.`, details: { maxMegabytes: purpose.maxMegabytes } });
    }
    if (!type.matches(file.buffer.subarray(0, SNIFF_BYTES))) {
      throw new UnsupportedMediaTypeException({ code: 'file_content_mismatch', message: 'The content of the file does not match its type.' });
    }

    if (input.folderId) await this.assertFolder(input.folderId, input.entityType, input.entityId);
    const clientId = await this.clientOf(input.entityType, input.entityId, input.folderId);

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
        clientId,
        folderId: input.folderId ?? null,
        docType: input.meta?.docType ?? null,
        docDate: day(input.meta?.docDate),
        validUntil: day(input.meta?.validUntil),
        periodFrom: day(input.meta?.periodFrom),
        periodTo: day(input.meta?.periodTo),
        rootId: input.meta?.rootId ?? null,
        version: input.meta?.version ?? 1,
        uploadedById: user.id,
      },
    });
    await this.audit.log({ action: 'created', entityType: 'file', entityId: row.id, entityLabel: row.name, after: { purpose: row.purpose, area: row.area, size: row.size } });
    this.queueIndex(row);
    return serializeFile(row);
  }

  /**
   * Stores a file the system made itself (a generated contract): no upload and no permission check — the caller has checked. The type is still
   * checked against the name, and the file may go straight into a folder, say what kind of document it is and be linked to other records.
   */
  async store(
    bytes: Buffer,
    input: { name: string; purpose: string; entityType?: string; entityId?: string; folderId?: string; userId: string | null; meta?: Omit<DocumentMeta, 'name'>; links?: Array<{ entityType: string; entityId: string }> },
  ): Promise<StoredFile> {
    const purpose = FILE_PURPOSES[input.purpose];
    const name = safeName(input.name);
    const extension = extensionOf(name);
    const type = FILE_TYPES[extension];
    if (!purpose || !name || !type || !purpose.extensions.includes(extension) || bytes.length === 0 || !type.matches(bytes.subarray(0, SNIFF_BYTES))) {
      throw new UnprocessableEntityException({ code: 'file_content_mismatch', message: 'The content of the file does not match its type.' });
    }
    if (input.folderId) await this.assertFolder(input.folderId, input.entityType, input.entityId);
    const clientId = await this.clientOf(input.entityType, input.entityId, input.folderId);
    const storageKey = `files/${randomUUID()}`;
    await this.storage.put(storageKey, bytes);
    const row = await this.prisma.storedFile.create({
      data: {
        name,
        mimeType: type.mime,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        storageKey,
        purpose: input.purpose,
        area: purpose.area === 'request' ? null : purpose.area,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        clientId,
        folderId: input.folderId ?? null,
        docType: input.meta?.docType ?? null,
        docDate: day(input.meta?.docDate),
        validUntil: day(input.meta?.validUntil),
        periodFrom: day(input.meta?.periodFrom),
        periodTo: day(input.meta?.periodTo),
        uploadedById: input.userId,
        ...(input.links?.length && { links: { create: input.links.map(link => ({ entityType: link.entityType, entityId: link.entityId, createdById: input.userId })) } }),
      },
    });
    await this.audit.log({ action: 'created', entityType: 'file', entityId: row.id, entityLabel: row.name, after: { purpose: row.purpose, area: row.area, size: row.size } });
    this.queueIndex(row);
    return row;
  }

  /**
   * Stores many files at once (an import): the same checks as `store` for each file, written together. The caller writes the audit entry for the whole
   * batch (an import's *uploaded*, with the counts) — a line "N files created" would have no language. Files that fail a check are not stored; they come
   * back in `failed` with the reason.
   */
  async storeMany(
    inputs: Array<{ name: string; bytes: Buffer }>,
    options: { purpose: string; userId: string | null },
  ): Promise<{ stored: Array<{ index: number; file: StoredFile }>; failed: Array<{ index: number; reason: 'type_not_allowed' | 'content_mismatch' | 'empty' }> }> {
    const purpose = FILE_PURPOSES[options.purpose];
    if (!purpose) throw new UnprocessableEntityException({ code: 'validation_failed', message: 'Validation failed', fields: { purpose: 'validation.selectOption' } });
    const failed: Array<{ index: number; reason: 'type_not_allowed' | 'content_mismatch' | 'empty' }> = [];
    const prepared: Array<{ index: number; data: Prisma.StoredFileCreateManyInput }> = [];
    for (const [index, input] of inputs.entries()) {
      const name = safeName(input.name);
      const type = FILE_TYPES[extensionOf(name)];
      if (!name || !type || !purpose.extensions.includes(extensionOf(name)) || !this.kindAllowed(extensionOf(name))) failed.push({ index, reason: 'type_not_allowed' });
      else if (input.bytes.length === 0) failed.push({ index, reason: 'empty' });
      else if (!type.matches(input.bytes.subarray(0, SNIFF_BYTES))) failed.push({ index, reason: 'content_mismatch' });
      else {
        const storageKey = `files/${randomUUID()}`;
        await this.storage.put(storageKey, input.bytes);
        prepared.push({
          index,
          data: {
            name,
            mimeType: type.mime,
            size: input.bytes.length,
            sha256: createHash('sha256').update(input.bytes).digest('hex'),
            storageKey,
            purpose: options.purpose,
            area: purpose.area === 'request' ? null : purpose.area,
            uploadedById: options.userId,
          },
        });
      }
    }
    const rows = prepared.length ? await this.prisma.storedFile.createManyAndReturn({ data: prepared.map(item => item.data) }) : [];
    return { stored: rows.map((file, position) => ({ index: prepared[position]!.index, file })), failed };
  }

  /**
   * Files a document an import has read: the same stored file (nothing is copied) becomes a document of a client or a worker, in a folder, with its
   * type and the date on it. `area` is who may open it afterwards (`personal_data` for copies of IDs). The caller has checked who may do this.
   */
  async file(
    id: string,
    target: { purpose: string; area: string | null; entityType: string; entityId: string; folderId?: string | null; docType?: string | null; docDate?: string | null; validUntil?: string | null; periodFrom?: string | null; periodTo?: string | null; name?: string },
  ): Promise<StoredFile> {
    const file = await this.prisma.storedFile.findUnique({ where: { id } });
    const purpose = FILE_PURPOSES[target.purpose];
    if (!file || !file.isActive || !purpose) throw new NotFoundException({ code: 'not_found', message: 'The file is no longer available.' });
    const area = purpose.area === 'request' ? target.area : purpose.area;
    if (target.folderId) await this.assertFolder(target.folderId, target.entityType, target.entityId);
    const name = target.name ? safeName(target.name) : file.name;
    if (extensionOf(name) !== extensionOf(file.name)) throw new UnprocessableEntityException({ code: 'validation_failed', message: 'Validation failed', fields: { name: 'validation.invalid' } });
    const updated = await this.prisma.storedFile.update({
      where: { id },
      data: {
        name,
        purpose: target.purpose,
        area,
        entityType: target.entityType,
        entityId: target.entityId,
        clientId: await this.clientOf(target.entityType, target.entityId, target.folderId),
        folderId: target.folderId ?? null,
        docType: target.docType ?? null,
        docDate: day(target.docDate),
        validUntil: day(target.validUntil),
        periodFrom: day(target.periodFrom),
        periodTo: day(target.periodTo),
      },
    });
    await this.audit.log({
      action: 'updated',
      entityType: 'file',
      entityId: id,
      entityLabel: updated.name,
      before: { purpose: file.purpose, area: file.area, entityType: file.entityType, folderId: file.folderId },
      after: { purpose: updated.purpose, area: updated.area, entityType: updated.entityType, entityId: updated.entityId, folderId: updated.folderId, docType: updated.docType },
    });
    this.queueIndex(updated);
    return updated;
  }

  /** The bytes of a file, without a permission check (for the system itself: filling in a template, converting to PDF). */
  async bytes(id: string): Promise<{ file: StoredFile; buffer: Buffer }> {
    const file = await this.prisma.storedFile.findUnique({ where: { id } });
    if (!file || !(await this.storage.exists(file.storageKey))) throw new NotFoundException({ code: 'not_found', message: 'The file is no longer available.' });
    const chunks: Buffer[] = [];
    for await (const chunk of await this.storage.get(file.storageKey)) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    return { file, buffer: Buffer.concat(chunks) };
  }

  /** An uploaded file that a feature is about to take in: it must exist, be active and have been uploaded for one of these purposes. */
  async uploaded(id: string, purposes: readonly string[], field = 'fileId'): Promise<StoredFile> {
    const file = await this.prisma.storedFile.findUnique({ where: { id } });
    if (!file || !file.isActive || !purposes.includes(file.purpose)) {
      throw new UnprocessableEntityException({ code: 'validation_failed', message: 'Validation failed', fields: { [field]: 'validation.invalid' } });
    }
    return file;
  }

  /** Puts files on a record and in a folder (the contract's scan ends up in the worker's folder). */
  async place(ids: string[], target: { entityType: string; entityId: string; folderId?: string | null }): Promise<void> {
    if (!ids.length) return;
    if (target.folderId) await this.assertFolder(target.folderId, target.entityType, target.entityId);
    const clientId = await this.clientOf(target.entityType, target.entityId, target.folderId);
    await this.prisma.storedFile.updateMany({
      where: { id: { in: ids } },
      data: { entityType: target.entityType, entityId: target.entityId, ...(clientId && { clientId }), ...(target.folderId !== undefined && { folderId: target.folderId }) },
    });
    const files = await this.prisma.storedFile.findMany({ where: { id: { in: ids } } });
    for (const file of files) this.queueIndex(file);
  }

  /** Says what kind of document placed files are and ties them to other records — only where nothing is known yet (a person's own choice is never overwritten). */
  async tag(ids: string[], meta: { docType?: string; docDate?: string | null; periodFrom?: string | null; periodTo?: string | null; links?: Array<{ entityType: string; entityId: string }> }, userId: string | null = null): Promise<void> {
    if (!ids.length) return;
    if (meta.docType) await this.prisma.storedFile.updateMany({ where: { id: { in: ids }, docType: null }, data: { docType: meta.docType } });
    if (meta.docDate) await this.prisma.storedFile.updateMany({ where: { id: { in: ids }, docDate: null }, data: { docDate: day(meta.docDate) } });
    if (meta.periodFrom) await this.prisma.storedFile.updateMany({ where: { id: { in: ids }, periodFrom: null }, data: { periodFrom: day(meta.periodFrom) } });
    if (meta.periodTo) await this.prisma.storedFile.updateMany({ where: { id: { in: ids }, periodTo: null }, data: { periodTo: day(meta.periodTo) } });
    if (meta.links?.length) {
      await this.prisma.documentLink.createMany({ data: ids.flatMap(fileId => (meta.links ?? []).map(link => ({ fileId, entityType: link.entityType, entityId: link.entityId, createdById: userId }))), skipDuplicates: true });
    }
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

  /** Renames a file (the extension stays) and / or moves it to another folder of the same client. */
  async update(id: string, changes: { name?: string; folderId?: string | null }, user: AuthenticatedUser) {
    const file = await this.prisma.storedFile.findUnique({ where: { id } });
    if (!file || !file.isActive) throw new NotFoundException({ code: 'not_found', message: 'File not found' });
    if (!file.area || !matrixAllows(user.matrix, `${file.area}.edit`)) this.forbidden();

    const data: { name?: string; folderId?: string | null } = {};
    if (changes.name !== undefined) {
      const name = safeName(changes.name);
      if (!name || extensionOf(name) !== extensionOf(file.name)) throw new UnprocessableEntityException({ code: 'validation_failed', message: 'Validation failed', fields: { name: 'validation.invalid' } });
      data.name = name;
    }
    if (changes.folderId !== undefined) {
      if (changes.folderId) await this.assertFolder(changes.folderId, file.entityType ?? undefined, file.entityId ?? undefined);
      data.folderId = changes.folderId;
    }
    const updated = Object.keys(data).length ? await this.prisma.storedFile.update({ where: { id }, data }) : file;
    const diff = AuditService.changes({ name: file.name, folderId: file.folderId }, { name: updated.name, folderId: updated.folderId });
    if (Object.keys(diff.after).length) await this.audit.log({ action: 'updated', entityType: 'file', entityId: id, entityLabel: updated.name, before: diff.before, after: diff.after });
    return serializeFile(updated);
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
    const clientId = await this.clientOf(entityType, entityId, null);
    await this.prisma.storedFile.updateMany({ where: { id: { in: ids } }, data: { entityType, entityId, ...(clientId && { clientId }) } });
    for (const file of await this.prisma.storedFile.findMany({ where: { id: { in: ids } } })) this.queueIndex(file);
  }

  /**
   * The client a file belongs to: its folder's client, else the client it is filed on, else the client of the worker it is filed on. Records that
   * can belong to several clients (a person) or to none (a template) give `null`.
   */
  async clientOf(entityType: string | null | undefined, entityId: string | null | undefined, folderId: string | null | undefined): Promise<string | null> {
    if (folderId) return (await this.prisma.folder.findUnique({ where: { id: folderId }, select: { clientId: true } }))?.clientId ?? null;
    if (!entityId) return null;
    if (entityType === 'client') return (await this.prisma.client.findUnique({ where: { id: entityId }, select: { id: true } }))?.id ?? null;
    if (entityType === 'employee') return (await this.prisma.employee.findUnique({ where: { id: entityId }, select: { clientId: true } }))?.clientId ?? null;
    return null;
  }

  /** A folder is only for the files of its own client — or, for a worker's folder, of that worker. */
  private async assertFolder(folderId: string, entityType: string | undefined, entityId: string | undefined): Promise<void> {
    const where =
      entityType === 'client' && entityId
        ? { id: folderId, clientId: entityId, employeeId: null, isActive: true }
        : entityType === 'employee' && entityId
          ? { id: folderId, employeeId: entityId, isActive: true }
          : null;
    const folder = where ? await this.prisma.folder.findFirst({ where, select: { id: true } }) : null;
    if (!folder) throw new UnprocessableEntityException({ code: 'validation_failed', message: 'Validation failed', fields: { folderId: 'validation.invalid' } });
  }

  private async readable(id: string, user: AuthenticatedUser): Promise<StoredFile> {
    const file = await this.prisma.storedFile.findUnique({ where: { id } });
    if (!file) throw new NotFoundException({ code: 'not_found', message: 'File not found' });
    if (file.area && !matrixAllows(user.matrix, `${file.area}.view`)) this.forbidden();
    return file;
  }

  /** Switches a file off; when it was the current version of a document, the version before it counts again. */
  private async deactivateRow(file: StoredFile): Promise<void> {
    await this.prisma.storedFile.update({ where: { id: file.id }, data: { isActive: false, deactivatedAt: new Date() } });
    if (file.isCurrent && file.rootId) {
      const previous = await this.prisma.storedFile.findFirst({ where: { OR: [{ id: file.rootId }, { rootId: file.rootId }], isActive: true, NOT: { id: file.id } }, orderBy: { version: 'desc' }, select: { id: true } });
      if (previous) await this.prisma.storedFile.update({ where: { id: previous.id }, data: { isCurrent: true } });
    }
    await this.audit.log({ action: 'deactivated', entityType: 'file', entityId: file.id, entityLabel: file.name });
  }

  /** Asks the queue to read the text of a document (when the office wants that); a queue that is not up is no problem — the next start picks up what is missing. */
  private queueIndex(file: Pick<StoredFile, 'id' | 'purpose'>): void {
    if (!DOCUMENT_PURPOSES.includes(file.purpose) || !this.settings.get<boolean>('documents.indexText')) return;
    this.queue.send(DOCUMENT_INDEX_QUEUE, { fileId: file.id }, { singletonKey: file.id }).catch((error: Error) => this.logger.debug(`Text of ${file.id} is read later: ${error.message}`));
  }

  private forbidden(): never {
    throw new ForbiddenException({ code: 'forbidden', message: 'You do not have access to this.' });
  }
}
