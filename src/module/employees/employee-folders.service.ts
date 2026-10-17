import { Injectable } from '@nestjs/common';
import type { Folder, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { folderNameOf } from '../clients/client-record.js';
import { STOPPED_FOLDER_NAME } from './employee-record.js';

/** A worker's folder name: no characters a file name cannot hold. */
const cleanName = (value: string): string => value.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Werknemer';

/**
 * Every worker has a folder inside the client's contracts folder (contracts, documents, the photos received over WhatsApp), named after the
 * worker — the way Ahmad keeps them today. When a worker leaves, the folder moves into the sub-folder `0-GESTOPT` of the same contracts folder;
 * when they come back, it moves back. Folders are virtual (see `Folder`): moving one never touches the files' bytes.
 */
@Injectable()
export class EmployeeFoldersService {
  constructor(private readonly prisma: PrismaService) {}

  /** Makes the worker's folder (inside the client's contracts folder, or in `0-GESTOPT` when the worker is already stopped). */
  async createFor(tx: Prisma.TransactionClient, employee: { id: string; clientId: string }, name: string, stopped = false): Promise<Folder> {
    const parent = await this.parentFor(tx, employee.clientId, stopped);
    return tx.folder.create({
      data: { clientId: employee.clientId, parentId: parent.id, employeeId: employee.id, name: await this.freeName(tx, employee.clientId, parent.id, cleanName(name), null), sortOrder: 1000 },
    });
  }

  /** Moves the worker's folder into `0-GESTOPT` (the worker left) or back into the contracts folder (the worker is back). */
  async moveForStatus(tx: Prisma.TransactionClient, employee: { id: string; clientId: string }, stopped: boolean): Promise<void> {
    const folder = await tx.folder.findUnique({ where: { employeeId: employee.id } });
    if (!folder) return;
    const parent = await this.parentFor(tx, employee.clientId, stopped);
    if (folder.parentId === parent.id) return;
    await tx.folder.update({ where: { id: folder.id }, data: { parentId: parent.id, name: await this.freeName(tx, employee.clientId, parent.id, folder.name, folder.id) } });
  }

  /** The worker changed employer: the folder moves to the new client's tree. */
  async moveToClient(tx: Prisma.TransactionClient, employee: { id: string; clientId: string }, stopped: boolean): Promise<void> {
    const folder = await tx.folder.findUnique({ where: { employeeId: employee.id } });
    const parent = await this.parentFor(tx, employee.clientId, stopped);
    if (!folder) return;
    await tx.folder.update({
      where: { id: folder.id },
      data: { clientId: employee.clientId, parentId: parent.id, name: await this.freeName(tx, employee.clientId, parent.id, folder.name, folder.id) },
    });
    // The worker's documents move with the worker: they belong to the new employer now.
    await tx.storedFile.updateMany({ where: { OR: [{ folderId: folder.id }, { entityType: 'employee', entityId: employee.id }] }, data: { clientId: employee.clientId } });
  }

  /** The folder follows the person's name. */
  async rename(tx: Prisma.TransactionClient, employee: { id: string; clientId: string }, name: string): Promise<void> {
    const folder = await tx.folder.findUnique({ where: { employeeId: employee.id } });
    const wanted = cleanName(name);
    if (!folder || folder.name === wanted || !folder.parentId) return;
    await tx.folder.update({ where: { id: folder.id }, data: { name: await this.freeName(tx, employee.clientId, folder.parentId, wanted, folder.id) } });
  }

  /** The worker's folder with the path to it ("042- Name / Arbeidsovereenkomsten / 0-GESTOPT / Jan de Vries"). */
  async describe(employeeId: string): Promise<{ id: string; name: string; path: string } | null> {
    const folder = await this.prisma.folder.findUnique({ where: { employeeId } });
    if (!folder) return null;
    const names = [folder.name];
    let parentId = folder.parentId;
    for (let depth = 0; parentId && depth < 10; depth += 1) {
      const parent = await this.prisma.folder.findUnique({ where: { id: parentId } });
      if (!parent) break;
      names.unshift(parent.name);
      parentId = parent.parentId;
    }
    return { id: folder.id, name: folder.name, path: names.join(' / ') };
  }

  /** The client's contracts folder (its root when the template has none), or its `0-GESTOPT` folder for workers who left. */
  private async parentFor(tx: Prisma.TransactionClient, clientId: string, stopped: boolean): Promise<Folder> {
    const contracts = (await tx.folder.findFirst({ where: { clientId, templateCode: 'contracts', isActive: true } })) ?? (await this.rootOf(tx, clientId));
    if (!stopped) return contracts;
    const existing = await tx.folder.findFirst({ where: { clientId, parentId: contracts.id, name: STOPPED_FOLDER_NAME, isActive: true } });
    return existing ?? tx.folder.create({ data: { clientId, parentId: contracts.id, name: STOPPED_FOLDER_NAME, sortOrder: 0 } });
  }

  private async rootOf(tx: Prisma.TransactionClient, clientId: string): Promise<Folder> {
    const root = await tx.folder.findFirst({ where: { clientId, parentId: null, isActive: true } });
    if (root) return root;
    // A client from before folders existed: it gets its main folder now.
    const client = await tx.client.findUniqueOrThrow({ where: { id: clientId }, select: { number: true, name: true } });
    return tx.folder.create({ data: { clientId, name: folderNameOf(client), sortOrder: 0 } });
  }

  /** `Jan de Vries`, or `Jan de Vries (2)` when another folder next to it has that name. */
  private async freeName(tx: Prisma.TransactionClient, clientId: string, parentId: string, name: string, ownId: string | null): Promise<string> {
    const siblings = await tx.folder.findMany({ where: { clientId, parentId, isActive: true, ...(ownId && { NOT: { id: ownId } }) }, select: { name: true } });
    const taken = new Set(siblings.map(sibling => sibling.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let number = 2; number < 100; number += 1) {
      const candidate = `${name} (${number})`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return `${name} (${Date.now()})`;
  }
}
