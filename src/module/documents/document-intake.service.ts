import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import { formatDay, parseDay, todayInAmsterdam } from '../../common/dates.js';
import { fold } from '../../common/text.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { validationFailed } from '../../common/validation/failure.js';
import type { DocumentType, StoredFile } from '../../generated/prisma/client.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { SettingsService } from '../../lib/settings/settings.service.js';
import { nameFromPattern } from '../document-settings/document-naming.js';
import { DocumentTypesService } from '../document-settings/document-types.service.js';
import { EmployeeFoldersService } from '../employees/employee-folders.service.js';
import { extensionOf } from '../files/files.constants.js';
import { FilesService } from '../files/files.service.js';
import { readPath } from '../imports/classification-rules.js';
import { personName } from '../people/person-record.js';
import { matrixAllows } from '../roles/permission-catalog.js';
import { DocumentVersionsService } from './document-versions.service.js';
import { DocumentViewService } from './document-view.service.js';
import type { SuggestDto, UploadDocumentDto } from './dto/documents.dto.js';

const isDay = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(parseDay(value).getTime()) && formatDay(parseDay(value)) === value;

/** Where a document is going: the record it is filed on, the client it belongs to and the folder it sits in. */
interface Destination {
  entityType: 'client' | 'employee';
  entityId: string;
  clientId: string;
  folderId: string | null;
  /** The worker's name, for the file name pattern. */
  worker: string | null;
  client: { number: string; name: string };
}

/**
 * Adding documents: one file with what is known about it. The type decides where it is filed and how it is named, and whether it is the next version of
 * the document that is there already; a file that is in the documents already is noticed.
 */
@Injectable()
export class DocumentIntakeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
    private readonly types: DocumentTypesService,
    private readonly versions: DocumentVersionsService,
    private readonly workerFolders: EmployeeFoldersService,
    private readonly settings: SettingsService,
    private readonly view: DocumentViewService,
  ) {}

  async upload(file: Express.Multer.File | undefined, dto: UploadDocumentDto, user: AuthenticatedUser, locale: AppLocale) {
    if (!file) throw new BadRequestException({ code: 'file_missing', message: 'Choose a file to upload.' });
    const previous = dto.replaces ? await this.previousOf(dto.replaces, user) : null;
    const typeCode = dto.docType || previous?.docType || null;
    const type = typeCode ? await this.types.byCode(typeCode) : null;
    if (typeCode && (!type || !type.isActive)) throw validationFailed({ docType: 'validation.selectOption' });
    if (dto.docDate && !isDay(dto.docDate)) throw validationFailed({ docDate: 'validation.invalid' });
    if (dto.validUntil && !isDay(dto.validUntil)) throw validationFailed({ validUntil: 'validation.invalid' });
    if (dto.periodFrom && !isDay(dto.periodFrom)) throw validationFailed({ periodFrom: 'validation.invalid' });
    if (dto.periodTo && !isDay(dto.periodTo)) throw validationFailed({ periodTo: 'validation.invalid' });
    if (dto.periodFrom && dto.periodTo && dto.periodTo < dto.periodFrom) throw validationFailed({ periodTo: 'validation.endBeforeStart' });
    const problems: Record<string, string> = {};
    if (type?.validity === 'age' && !dto.docDate) problems.docDate = 'validation.required';
    if (type?.validity === 'date' && !dto.validUntil) problems.validUntil = 'validation.required';
    if (Object.keys(problems).length) throw validationFailed(problems);

    const destination = previous ? await this.destinationOf(previous) : await this.destinationFor(dto, type);
    const area = type?.personal ? 'personal_data' : destination.entityType === 'employee' ? 'employees' : 'clients';
    const original = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const extension = extensionOf(original);
    const name = await this.nameFor(dto, type, destination, original, extension, previous);

    if (!dto.allowDuplicate) {
      const duplicate = await this.duplicateOf(file.buffer, destination.clientId, previous);
      if (duplicate) {
        throw new ConflictException({ code: 'document_duplicate', message: 'This file is in the documents already.', details: { existing: { id: duplicate.id, name: duplicate.name, docType: duplicate.docType, docDate: duplicate.docDate ? formatDay(duplicate.docDate) : null } } });
      }
    }

    const root = previous ? (previous.rootId ?? previous.id) : null;
    const version = root ? ((await this.prisma.storedFile.aggregate({ where: DocumentVersionsService.chain(root), _max: { version: true } }))._max.version ?? 1) + 1 : 1;
    const stored = await this.files.upload(
      file,
      {
        purpose: 'attachment',
        area,
        entityType: destination.entityType,
        entityId: destination.entityId,
        ...(destination.folderId && { folderId: destination.folderId }),
        meta: {
          name,
          docType: type?.code ?? null,
          docDate: dto.docDate ?? null,
          validUntil: type?.validity === 'date' ? (dto.validUntil ?? null) : null,
          periodFrom: dto.periodFrom ?? null,
          periodTo: dto.periodTo ?? null,
          rootId: root,
          version,
        },
      },
      user,
    );
    // The new version is the one that counts from now on.
    if (root) await this.prisma.storedFile.updateMany({ where: { AND: [DocumentVersionsService.chain(root), { NOT: { id: stored.id } }] }, data: { isCurrent: false } });
    const [shown] = await this.view.build([await this.prisma.storedFile.findUniqueOrThrow({ where: { id: stored.id } })], locale);
    return { ...shown!, replaced: previous?.id ?? null };
  }

  /** The type each file name points to (by the rules the import uses, then by the words a type lists) and the date written in it. */
  async suggest(dto: SuggestDto) {
    const active = await this.types.active();
    return dto.names.map(name => {
      const hints = readPath(name, []);
      let docType = hints.docType && active.some(type => type.code === hints.docType) ? hints.docType : null;
      if (!docType) {
        const folded = fold(name);
        docType = active.find(type => type.keywords.split(',').some(word => word.trim() && folded.includes(fold(word))))?.code ?? null;
      }
      return { name, docType, docDate: hints.docDate, strong: hints.strong && docType === hints.docType };
    });
  }

  /** The document a new file of this type would replace: the current one of the same client or worker. */
  async current(typeCode: string, clientId: string | undefined, employeeId: string | undefined, user: AuthenticatedUser, locale: AppLocale) {
    const type = await this.types.byCode(typeCode);
    if (!type?.versioned || (!clientId && !employeeId)) return null;
    const worker = employeeId && type.scope !== 'client' ? await this.prisma.employee.findUnique({ where: { id: employeeId }, select: { id: true, clientId: true } }) : null;
    const owner = worker ? { entityType: 'employee', entityId: worker.id, clientId: worker.clientId } : { entityType: 'client', entityId: clientId ?? '', clientId: clientId ?? null };
    const found = await this.versions.current({ id: '', docType: type.code, ...owner });
    if (!found || !found.area || !matrixAllows(user.matrix, `${found.area}.view`)) return null;
    const [shown] = await this.view.build([found], locale);
    return shown ?? null;
  }

  /* ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  /** The document a new version is for: the person must be allowed to change it. */
  private async previousOf(id: string, user: AuthenticatedUser): Promise<StoredFile> {
    const previous = await this.prisma.storedFile.findUnique({ where: { id } });
    if (!previous || !previous.isActive) throw new NotFoundException({ code: 'not_found', message: 'Document not found' });
    if (!previous.area || !matrixAllows(user.matrix, `${previous.area}.edit`) || !matrixAllows(user.matrix, 'documents.edit')) {
      throw new ForbiddenException({ code: 'forbidden', message: 'You do not have access to this.' });
    }
    return previous;
  }

  /** A new version is filed where the document it follows is. */
  private async destinationOf(previous: StoredFile): Promise<Destination> {
    const clientId = previous.clientId ?? (previous.entityType === 'employee' ? (await this.prisma.employee.findUnique({ where: { id: previous.entityId ?? '' }, select: { clientId: true } }))?.clientId : null);
    if (!clientId || (previous.entityType !== 'client' && previous.entityType !== 'employee') || !previous.entityId) throw validationFailed({ replaces: 'validation.invalid' });
    const worker = previous.entityType === 'employee' ? await this.workerName(previous.entityId) : null;
    return { entityType: previous.entityType, entityId: previous.entityId, clientId, folderId: previous.folderId, worker, client: await this.clientOf(clientId) };
  }

  private async destinationFor(dto: UploadDocumentDto, type: DocumentType | null): Promise<Destination> {
    const worker = dto.employeeId ? await this.prisma.employee.findUnique({ where: { id: dto.employeeId }, select: { id: true, clientId: true, person: { select: { firstName: true, lastName: true, data: true } } } }) : null;
    if (dto.employeeId && !worker) throw validationFailed({ employeeId: 'validation.invalid' });
    if (type?.scope === 'worker' && !worker) throw validationFailed({ employeeId: 'validation.required' });
    const clientId = worker?.clientId ?? dto.clientId;
    if (!clientId) throw validationFailed({ clientId: 'validation.required' });
    if (dto.clientId && worker && dto.clientId !== worker.clientId) throw validationFailed({ employeeId: 'validation.invalid' });
    const client = await this.clientOf(clientId);

    // A worker's papers go in the worker's own folder; everything else in the folder asked for, else the standard folder of its type, else the client's folder.
    if (worker && type?.scope !== 'client') {
      const folder = dto.folderId ?? (await this.workerFolders.describe(worker.id))?.id ?? null;
      return { entityType: 'employee', entityId: worker.id, clientId, folderId: folder, worker: personName(worker.person), client };
    }
    const folderId = dto.folderId ?? (await this.standardFolder(clientId, type?.folderCode ?? null));
    return { entityType: 'client', entityId: clientId, clientId, folderId, worker: worker ? personName(worker.person) : null, client };
  }

  /** The folder made from a standard folder of the template, else the client's own folder. */
  private async standardFolder(clientId: string, code: string | null): Promise<string | null> {
    const standard = code ? await this.prisma.folder.findFirst({ where: { clientId, templateCode: code, employeeId: null, isActive: true }, select: { id: true } }) : null;
    if (standard) return standard.id;
    return (await this.prisma.folder.findFirst({ where: { clientId, parentId: null, isActive: true }, select: { id: true } }))?.id ?? null;
  }

  private async clientOf(clientId: string): Promise<{ number: string; name: string }> {
    const client = await this.prisma.client.findUnique({ where: { id: clientId }, select: { number: true, name: true } });
    if (!client) throw validationFailed({ clientId: 'validation.invalid' });
    return client;
  }

  private async workerName(employeeId: string): Promise<string | null> {
    const worker = await this.prisma.employee.findUnique({ where: { id: employeeId }, select: { person: { select: { firstName: true, lastName: true, data: true } } } });
    return worker ? personName(worker.person) : null;
  }

  /** The name the file gets: the one typed, else the pattern of its type (when the office wants that), else the name it had. Never the same as another file in the folder. */
  private async nameFor(dto: UploadDocumentDto, type: DocumentType | null, destination: Destination, original: string, extension: string, previous: StoredFile | null): Promise<string> {
    const withoutExtension = extension ? original.slice(0, -(extension.length + 1)) : original;
    let name = original;
    if (dto.name?.trim()) {
      name = dto.name.trim();
      if (extensionOf(name) !== extension) name = `${name}.${extension}`;
    } else if (type?.namePattern && (dto.autoName ?? this.settings.get<boolean>('documents.autoName'))) {
      const documentLocale = this.settings.get<string>('locale.documentLocale') === 'en' ? 'en' : 'nl';
      const made = nameFromPattern(type.namePattern, {
        number: destination.client.number,
        client: destination.client.name,
        worker: destination.worker,
        type: DocumentTypesService.nameIn(type, documentLocale),
        date: dto.docDate ?? todayInAmsterdam(),
        original: withoutExtension,
      });
      if (made) name = `${made}.${extension}`;
    }
    if (previous) return name;
    return this.freeName(destination, name, extension);
  }

  /** `name.pdf`, or `name (2).pdf` when the folder has a file of that name. */
  private async freeName(destination: Destination, name: string, extension: string): Promise<string> {
    const taken = new Set(
      (await this.prisma.storedFile.findMany({ where: { isActive: true, isCurrent: true, folderId: destination.folderId, clientId: destination.clientId }, select: { name: true } })).map(row => row.name.toLowerCase()),
    );
    if (!taken.has(name.toLowerCase())) return name;
    const base = extension ? name.slice(0, -(extension.length + 1)) : name;
    for (let number = 2; number < 100; number += 1) {
      const candidate = extension ? `${base} (${number}).${extension}` : `${base} (${number})`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return `${base} (${Date.now()}).${extension}`;
  }

  /** The same bytes in the documents of the same client already (a newer version of the same document does not count). */
  private async duplicateOf(bytes: Buffer, clientId: string, previous: StoredFile | null): Promise<StoredFile | null> {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const root = previous ? (previous.rootId ?? previous.id) : null;
    return this.prisma.storedFile.findFirst({ where: { sha256, clientId, isActive: true, ...(root && { NOT: DocumentVersionsService.chain(root) }) }, orderBy: { createdAt: 'desc' } });
  }
}
