import { Injectable } from '@nestjs/common';
import type { ImportItem, StoredFile } from '../../generated/prisma/client.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { DocumentTypesService } from '../document-settings/document-types.service.js';
import { FolderTemplatesService } from '../document-settings/folder-templates.service.js';
import { DocumentVersionsService } from '../documents/document-versions.service.js';
import { EmployeeFoldersService } from '../employees/employee-folders.service.js';
import { FilesService } from '../files/files.service.js';
import { readPath, type KnownFolder, type PathHints } from './classification-rules.js';

const FOLDERS_CACHE_MS = 60_000;

/** Folders people make that only hold things; a worker's name is the folder that is none of these. */
const CONTAINER_FOLDERS: KnownFolder[] = [
  { code: 'contracts', names: ['contracten', 'arbeidscontracten', 'arbeidsovereenkomst', 'contracts', 'employment contracts'] },
  { code: 'hours_invoices', names: ['loonstroken', 'urenstaten', 'uren', 'facturen', 'invoices', 'timesheets', 'payslips'] },
  { code: null, names: ['identiteitsbewijzen', 'id', 'id bewijzen', 'paspoorten', 'paspoort', 'overig', 'overige', 'documenten', 'scans', 'bijlagen', 'diversen', 'other', 'documents', 'bsn', 'medewerkers', 'werknemers', 'personeel', 'employees'] },
];

export interface FilingTarget {
  purpose: string;
  area: string | null;
  entityType: 'client' | 'employee';
  entityId: string;
  folderId: string | null;
}

/**
 * Where a read document goes: the worker's folder or the client's folder, with the right purpose and who may open it afterwards. The folder comes
 * from where the file was found (a standard folder of the client), otherwise from the type of document (a KvK extract goes to "Gegevens"). Whether a
 * type belongs to a worker, is personal data, or has a standard folder is the office's setting (Settings → Documents → Types). A document of a type that
 * keeps versions becomes the next version of the one that is there.
 */
@Injectable()
export class DocumentFilingService {
  private folders: { at: number; list: KnownFolder[] } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
    private readonly workerFolders: EmployeeFoldersService,
    private readonly types: DocumentTypesService,
    private readonly templates: FolderTemplatesService,
    private readonly versions: DocumentVersionsService,
  ) {}

  /** The standard folders of a client (the folder template, in both languages) and the usual names of folders that only hold things. */
  async knownFolders(): Promise<KnownFolder[]> {
    if (this.folders && Date.now() - this.folders.at < FOLDERS_CACHE_MS) return this.folders.list;
    const list: KnownFolder[] = [...(await this.templates.knownFolders()).map(entry => ({ code: entry.code as string | null, names: entry.names })), ...CONTAINER_FOLDERS];
    this.folders = { at: Date.now(), list };
    return list;
  }

  async hints(item: Pick<ImportItem, 'path' | 'name'>): Promise<PathHints> {
    return readPath(item.path || item.name, await this.knownFolders());
  }

  /** The place for a document of this type; `null` when there is no client and no worker to put it with. */
  async target(docType: string | null, clientId: string | null, employeeId: string | null, folderCode: string | null): Promise<FilingTarget | null> {
    const type = await this.types.byCode(docType);
    const personal = Boolean(type?.personal);
    if (employeeId && (!docType || type?.scope === 'worker' || !clientId)) {
      const folder = await this.workerFolders.describe(employeeId);
      return { purpose: 'attachment', area: personal ? 'personal_data' : 'employees', entityType: 'employee', entityId: employeeId, folderId: folder?.id ?? null };
    }
    if (!clientId) return null;
    const code = folderCode ?? type?.folderCode ?? null;
    const folder = code
      ? await this.prisma.folder.findFirst({ where: { clientId, templateCode: code, employeeId: null, isActive: true }, select: { id: true } })
      : await this.prisma.folder.findFirst({ where: { clientId, parentId: null, isActive: true }, select: { id: true } });
    return { purpose: 'attachment', area: personal ? 'personal_data' : 'clients', entityType: 'client', entityId: clientId, folderId: folder?.id ?? null };
  }

  /** Puts the staged file in its place, with its type and date — as the next version of the document that is there, for a type that keeps versions. */
  async file(fileId: string, target: FilingTarget, docType: string | null, docDate: string | null, purpose?: string): Promise<StoredFile> {
    const filed = await this.files.file(fileId, { ...target, purpose: purpose ?? target.purpose, docType, docDate });
    await this.versions.supersede(filed);
    return filed;
  }
}
