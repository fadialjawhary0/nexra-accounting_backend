import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { Client, Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { SettingsService } from '../../lib/settings/settings.service.js';
import { serializeFile } from '../files/files.service.js';
import { matrixAllows, type PermissionMatrix } from '../roles/permission-catalog.js';
import { displayLabel, folderNameOf } from './client-record.js';
import type { CreateFolderDto } from './dto/client.dto.js';

/** A folder name people type: no characters a file name cannot hold, no double spaces. */
const cleanName = (value: string): string => value.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);

const FILE_LIMIT = 2000;

/**
 * A client's documents: the folder `<number>- <name>` with the standard sub-folders of the `client_folder` list (Settings → Lists),
 * made when the client is created, plus whatever folders people add. Folders are virtual — a file's bytes sit in storage under their own key.
 */
@Injectable()
export class ClientFoldersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  /** Makes the root folder and the standard sub-folders. Call inside the transaction that creates the client. */
  async createFor(tx: Prisma.TransactionClient, client: Pick<Client, 'id' | 'number' | 'name'>): Promise<void> {
    const template = await tx.listItem.findMany({ where: { isActive: true, list: { key: 'client_folder' } }, orderBy: [{ sortOrder: 'asc' }, { nameNl: 'asc' }] });
    const english = this.settings.get<string>('locale.documentLocale') === 'en';
    await tx.folder.create({
      data: {
        clientId: client.id,
        name: folderNameOf(client),
        sortOrder: 0,
        children: {
          create: template.map((item, index) => ({ clientId: client.id, name: cleanName(english ? item.nameEn : item.nameNl) || item.code, templateCode: item.code, sortOrder: (index + 1) * 10 })),
        },
      },
    });
  }

  /** The root folder follows the client's number and name. */
  async renameRoot(tx: Prisma.TransactionClient, client: Pick<Client, 'id' | 'number' | 'name'>): Promise<void> {
    await tx.folder.updateMany({ where: { clientId: client.id, parentId: null }, data: { name: folderNameOf(client) } });
  }

  /**
   * Every folder and file of a client (the folder tree is flat here: each folder says which one it sits in). The folders of the client's
   * workers sit inside the contracts folder with the workers' files — only people who may open workers see them.
   */
  async documents(clientId: string, matrix: PermissionMatrix) {
    const withWorkers = matrixAllows(matrix, 'employees.view');
    const [folders, files] = await Promise.all([
      this.prisma.folder.findMany({ where: { clientId, isActive: true, ...(!withWorkers && { employeeId: null }) }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
      this.prisma.storedFile.findMany({
        where: { purpose: 'attachment', isActive: true, OR: [{ entityType: 'client', entityId: clientId }, ...(withWorkers ? [{ entityType: 'employee', folder: { clientId } }] : [])] },
        orderBy: { createdAt: 'desc' },
        take: FILE_LIMIT,
      }),
    ]);
    return {
      folders: folders.map(folder => ({ id: folder.id, parentId: folder.parentId, name: folder.name, templateCode: folder.templateCode, order: folder.sortOrder, employeeId: folder.employeeId })),
      files: files.map(serializeFile),
    };
  }

  async countFiles(clientId: string): Promise<number> {
    return this.prisma.storedFile.count({ where: { entityType: 'client', entityId: clientId, purpose: 'attachment', isActive: true } });
  }

  async create(client: Client, dto: CreateFolderDto) {
    const parent = dto.parentId
      ? await this.prisma.folder.findFirst({ where: { id: dto.parentId, clientId: client.id, isActive: true } })
      : await this.prisma.folder.findFirst({ where: { clientId: client.id, parentId: null, isActive: true } });
    if (!parent) throw new NotFoundException({ code: 'not_found', message: 'Folder not found' });
    if (parent.employeeId) throw new UnprocessableEntityException({ code: 'validation_failed', message: 'Validation failed', fields: { parentId: 'validation.invalid' } });
    const name = await this.checkName(client.id, parent.id, dto.name, null);
    const folder = await this.prisma.folder.create({ data: { clientId: client.id, parentId: parent.id, name, sortOrder: 1000 } });
    await this.audit.log({ action: 'created', entityType: 'folder', entityId: folder.id, entityLabel: `${displayLabel(client)} / ${name}` });
    return { id: folder.id, parentId: folder.parentId, name: folder.name, templateCode: null, order: folder.sortOrder };
  }

  async rename(client: Client, folderId: string, rawName: string) {
    const folder = await this.prisma.folder.findFirst({ where: { id: folderId, clientId: client.id, isActive: true } });
    if (!folder) throw new NotFoundException({ code: 'not_found', message: 'Folder not found' });
    if (!folder.parentId) throw new ConflictException({ code: 'folder_is_root', message: 'The main folder follows the client’s number and name.' });
    if (folder.employeeId) throw new ConflictException({ code: 'folder_follows_worker', message: 'The folder of an employee follows the employee’s name.' });
    const name = await this.checkName(client.id, folder.parentId, rawName, folder.id);
    if (name !== folder.name) {
      await this.prisma.folder.update({ where: { id: folder.id }, data: { name } });
      await this.audit.log({ action: 'updated', entityType: 'folder', entityId: folder.id, entityLabel: `${displayLabel(client)} / ${name}`, before: { name: folder.name }, after: { name } });
    }
    return { id: folder.id, parentId: folder.parentId, name, templateCode: folder.templateCode, order: folder.sortOrder };
  }

  /** Switches an empty folder off (folders with files or sub-folders stay). */
  async remove(client: Client, folderId: string) {
    const folder = await this.prisma.folder.findFirst({ where: { id: folderId, clientId: client.id, isActive: true } });
    if (!folder) throw new NotFoundException({ code: 'not_found', message: 'Folder not found' });
    if (!folder.parentId) throw new ConflictException({ code: 'folder_is_root', message: 'The main folder of a client cannot be removed.' });
    if (folder.employeeId) throw new ConflictException({ code: 'folder_follows_worker', message: 'The folder of an employee stays with the employee.' });
    const [files, children] = await Promise.all([
      this.prisma.storedFile.count({ where: { folderId: folder.id, isActive: true } }),
      this.prisma.folder.count({ where: { parentId: folder.id, isActive: true } }),
    ]);
    if (files || children) throw new ConflictException({ code: 'folder_not_empty', message: 'Empty the folder first.', details: { files, folders: children } });
    await this.prisma.folder.update({ where: { id: folder.id }, data: { isActive: false } });
    await this.audit.log({ action: 'deactivated', entityType: 'folder', entityId: folder.id, entityLabel: `${displayLabel(client)} / ${folder.name}` });
    return { id: folder.id };
  }

  /** The cleaned name, unique among the folders next to it. */
  private async checkName(clientId: string, parentId: string, raw: string, ownId: string | null): Promise<string> {
    const name = cleanName(raw);
    if (!name) throw new UnprocessableEntityException({ code: 'validation_failed', message: 'Validation failed', fields: { name: 'validation.required' } });
    const siblings = await this.prisma.folder.findMany({ where: { clientId, parentId, isActive: true, ...(ownId && { NOT: { id: ownId } }) }, select: { name: true } });
    if (siblings.some(sibling => sibling.name.toLowerCase() === name.toLowerCase())) {
      throw new UnprocessableEntityException({ code: 'validation_failed', message: 'Validation failed', fields: { name: 'validation.alreadyExists' } });
    }
    return name;
  }
}
