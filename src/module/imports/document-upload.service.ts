import { BadRequestException, ConflictException, Injectable, UnprocessableEntityException, UnsupportedMediaTypeException } from '@nestjs/common';
import PizZip from 'pizzip';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { SettingsService } from '../../lib/settings/settings.service.js';
import { FILE_TYPES, extensionOf } from '../files/files.constants.js';
import { FilesService } from '../files/files.service.js';
import { SECURITY_NAMESPACE } from '../security-settings/security-settings.definitions.js';
import { FILE_JOB_KINDS, IMPORTS_NAMESPACE, IMPORT_FILE_PURPOSE, MAX_ZIP_ENTRIES, MAX_ZIP_ENTRY_MEGABYTES, auditTypeOf } from './imports.constants.js';

export type SkipReason = 'type_not_allowed' | 'too_large' | 'empty' | 'content_mismatch' | 'junk' | 'limit' | 'too_many_in_zip' | 'unreadable';

export interface UploadOutcome {
  added: number;
  skipped: Array<{ path: string; reason: SkipReason }>;
}

interface Entry {
  path: string;
  bytes: Buffer;
}

const MAX_PATH_LENGTH = 400;
const MAX_SEGMENT_LENGTH = 150;
const MAX_DEPTH = 12;
const JUNK_NAMES = new Set(['thumbs.db', '.ds_store', 'desktop.ini']);

/** A path from a browser or a ZIP made safe: `/` separators, no `..`, no control characters, not endless. `null` when nothing is left. */
export function cleanPath(raw: string): string | null {
  const segments = raw
    .replace(/\\/g, '/')
    .split('/')
    .map(segment =>
      [...segment]
        .filter(character => character.charCodeAt(0) >= 32)
        .join('')
        .trim()
        .slice(0, MAX_SEGMENT_LENGTH),
    )
    .filter(segment => segment && segment !== '.' && segment !== '..');
  if (!segments.length) return null;
  return segments.slice(-MAX_DEPTH).join('/').slice(-MAX_PATH_LENGTH);
}

const isJunk = (path: string): boolean => {
  const segments = path.split('/');
  const name = segments[segments.length - 1]!.toLowerCase();
  return JUNK_NAMES.has(name) || name.startsWith('~$') || segments.some(segment => segment === '__MACOSX');
};

/**
 * Adds the files of an import: a batch of files (picked one by one or a whole folder — the browser sends a folder in batches) or a ZIP that is
 * opened here. Every file is checked like any upload (type, content, size), stored once, and becomes one item that waits for the import to start.
 * A ZIP is never trusted: the number of files, the size of each file and of all of them together are limited, and paths cannot leave the import.
 */
@Injectable()
export class DocumentUploadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  /** A batch of uploaded files (`originalname` is the path inside the chosen folder). */
  async addFiles(jobId: string, uploads: Express.Multer.File[] | undefined, user: AuthenticatedUser): Promise<UploadOutcome> {
    if (!uploads?.length) throw new BadRequestException({ code: 'file_missing', message: 'Choose files to upload.' });
    const entries: Entry[] = [];
    const skipped: UploadOutcome['skipped'] = [];
    for (const upload of uploads) {
      // The browser sends the name as latin1 bytes; turn it back into the text the person saw.
      const path = cleanPath(Buffer.from(upload.originalname, 'latin1').toString('utf8'));
      if (!path) skipped.push({ path: upload.originalname, reason: 'unreadable' });
      else entries.push({ path, bytes: upload.buffer });
    }
    return this.add(jobId, entries, skipped, user);
  }

  /** A ZIP file: its files are added; folders inside it are kept as the path of each file. */
  async addZip(jobId: string, upload: Express.Multer.File | undefined, user: AuthenticatedUser): Promise<UploadOutcome> {
    if (!upload) throw new BadRequestException({ code: 'file_missing', message: 'Choose a ZIP file.' });
    if (extensionOf(upload.originalname) !== 'zip' || !(upload.buffer[0] === 0x50 && upload.buffer[1] === 0x4b)) {
      throw new UnsupportedMediaTypeException({ code: 'file_type_not_allowed', message: 'This is not a ZIP file.' });
    }
    const { entries, skipped } = this.expand(upload.buffer);
    return this.add(jobId, entries, skipped, user);
  }

  /** Opens a ZIP in memory, refusing a bomb: too many files, a file that is huge, or a total that is far more than the ZIP itself. */
  private expand(buffer: Buffer): { entries: Entry[]; skipped: UploadOutcome['skipped'] } {
    let zip: PizZip;
    try {
      zip = new PizZip(buffer);
    } catch {
      throw new UnprocessableEntityException({ code: 'zip_unreadable', message: 'The ZIP file could not be opened.' });
    }
    const maxEntryBytes = MAX_ZIP_ENTRY_MEGABYTES * 1024 * 1024;
    const maxTotalBytes = this.settings.get<number>(`${IMPORTS_NAMESPACE}.maxZipMegabytes`) * 1024 * 1024 * 4;
    const entries: Entry[] = [];
    const skipped: UploadOutcome['skipped'] = [];
    let total = 0;
    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      const path = cleanPath(entry.name);
      if (!path) {
        skipped.push({ path: entry.name, reason: 'unreadable' });
        continue;
      }
      if (isJunk(path)) continue;
      if (entries.length + skipped.length >= MAX_ZIP_ENTRIES) {
        skipped.push({ path, reason: 'too_many_in_zip' });
        continue;
      }
      const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
      if (size > maxEntryBytes || total + size > maxTotalBytes) {
        skipped.push({ path, reason: 'too_large' });
        continue;
      }
      try {
        const bytes = entry.asNodeBuffer();
        total += bytes.length;
        entries.push({ path, bytes });
      } catch {
        skipped.push({ path, reason: 'unreadable' });
      }
    }
    return { entries, skipped };
  }

  private async add(jobId: string, entries: Entry[], skipped: UploadOutcome['skipped'], user: AuthenticatedUser): Promise<UploadOutcome> {
    const job = await this.prisma.importJob.findUnique({ where: { id: jobId } });
    if (!job || !FILE_JOB_KINDS.includes(job.kind)) throw new BadRequestException({ code: 'not_found', message: 'Import not found' });
    if (job.status !== 'draft') throw new ConflictException({ code: 'import_not_draft', message: 'Files can only be added before the import is started.' });

    const maxFiles = this.settings.get<number>(`${IMPORTS_NAMESPACE}.maxFilesPerImport`);
    const maxBytes = this.settings.get<number>(`${SECURITY_NAMESPACE}.uploadMaxMegabytes`) * 1024 * 1024;
    const existing = await this.prisma.importItem.count({ where: { jobId } });
    const last = await this.prisma.importItem.aggregate({ where: { jobId }, _max: { sortOrder: true } });

    const accepted: Entry[] = [];
    for (const entry of entries) {
      const name = entry.path.split('/').pop()!;
      if (isJunk(entry.path)) continue;
      if (!FILE_TYPES[extensionOf(name)]) skipped.push({ path: entry.path, reason: 'type_not_allowed' });
      else if (entry.bytes.length === 0) skipped.push({ path: entry.path, reason: 'empty' });
      else if (entry.bytes.length > maxBytes) skipped.push({ path: entry.path, reason: 'too_large' });
      else if (existing + accepted.length >= maxFiles) skipped.push({ path: entry.path, reason: 'limit' });
      else accepted.push(entry);
    }
    accepted.sort((a, b) => a.path.localeCompare(b.path, 'nl', { numeric: true }));

    const { stored, failed } = await this.files.storeMany(accepted.map(entry => ({ name: entry.path.split('/').pop()!, bytes: entry.bytes })), { purpose: IMPORT_FILE_PURPOSE, userId: user.id });
    for (const failure of failed) skipped.push({ path: accepted[failure.index]!.path, reason: failure.reason });
    if (stored.length) {
      const base = (last._max.sortOrder ?? -1) + 1;
      await this.prisma.importItem.createMany({
        data: stored.map(({ index, file }, position) => ({
          jobId,
          sortOrder: base + position,
          kind: 'file',
          status: 'pending',
          name: file.name,
          path: accepted[index]!.path,
          fileId: file.id,
          size: file.size,
          sha256: file.sha256,
        })),
      });
      await this.audit.log({ action: 'uploaded', entityType: auditTypeOf(job.kind), entityId: jobId, entityLabel: job.name, meta: { files: stored.length, skipped: skipped.length } });
    }
    return { added: stored.length, skipped };
  }
}
