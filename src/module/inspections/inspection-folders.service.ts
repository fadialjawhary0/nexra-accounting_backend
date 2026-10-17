import { Injectable } from '@nestjs/common';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';

/** A folder name people can see everywhere: no characters a file name cannot hold, no double spaces. */
const cleanName = (value: string): string => value.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);

/** `2026-08-21` → `21-08-2026`. */
export const dutchDay = (day: string): string => day.split('-').reverse().join('-');

/**
 * The folder of an inspection in the client's documents, the way the office keeps it today: inside the standard folder "Controles", a folder for the body that inspects and
 * inside it a folder per inspection day (`Controles / Cicero / 21-08-2026`), with a folder for each part of the checklist (the "standard NEN 4400 folder structure").
 * Folders are virtual; nothing is moved. A folder that exists is reused, never renamed.
 */
@Injectable()
export class InspectionFoldersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async child(clientId: string, parentId: string, name: string, extra: { templateCode?: string; sortOrder?: number } = {}): Promise<{ id: string; created: boolean }> {
    const siblings = await this.prisma.folder.findMany({ where: { clientId, parentId, isActive: true }, select: { id: true, name: true } });
    const found = siblings.find(sibling => sibling.name.toLowerCase() === name.toLowerCase());
    if (found) return { id: found.id, created: false };
    const created = await this.prisma.folder.create({ data: { clientId, parentId, name, templateCode: extra.templateCode ?? null, sortOrder: extra.sortOrder ?? 1000 } });
    return { id: created.id, created: true };
  }

  /** Makes the dated folder (and the folders of the checklist's parts). Returns its id, or null when the client has no folders at all. */
  async ensure(input: { clientId: string; clientLabel: string; bodyName: string; day: string; sections: ReadonlyArray<{ nameNl: string; folder: boolean }> }): Promise<string | null> {
    const root = await this.prisma.folder.findFirst({ where: { clientId: input.clientId, parentId: null, isActive: true }, select: { id: true } });
    if (!root) return null;
    const standard = await this.prisma.folder.findFirst({ where: { clientId: input.clientId, templateCode: 'inspections', employeeId: null, isActive: true }, select: { id: true } });
    const controls = standard ? { id: standard.id } : await this.child(input.clientId, root.id, 'Controles', { templateCode: 'inspections', sortOrder: 20 });
    const body = await this.child(input.clientId, controls.id, cleanName(input.bodyName) || 'Controle');
    const siblings = await this.prisma.folder.findMany({ where: { clientId: input.clientId, parentId: body.id, isActive: true }, select: { name: true } });
    const taken = new Set(siblings.map(sibling => sibling.name.toLowerCase()));
    const base = dutchDay(input.day);
    let name = base;
    for (let number = 2; taken.has(name.toLowerCase()) && number < 50; number += 1) name = `${base} (${number})`;
    const dated = await this.prisma.folder.create({ data: { clientId: input.clientId, parentId: body.id, name, sortOrder: 1000 } });
    await this.audit.log({ action: 'created', entityType: 'folder', entityId: dated.id, entityLabel: `${input.clientLabel} / Controles / ${cleanName(input.bodyName)} / ${name}` });

    let order = 0;
    for (const section of input.sections) {
      if (!section.folder) continue;
      order += 1;
      await this.prisma.folder.create({ data: { clientId: input.clientId, parentId: dated.id, name: cleanName(`${order} ${section.nameNl}`), sortOrder: order * 10 } });
    }
    return dated.id;
  }

  /** `Controles / Cicero / 21-08-2026` — the path of a folder inside the client's own folder. */
  async pathOf(folderId: string | null): Promise<string | null> {
    if (!folderId) return null;
    const folders = await this.prisma.folder.findUnique({ where: { id: folderId }, select: { clientId: true } });
    if (!folders) return null;
    const all = await this.prisma.folder.findMany({ where: { clientId: folders.clientId }, select: { id: true, name: true, parentId: true } });
    const byId = new Map(all.map(folder => [folder.id, folder]));
    const names: string[] = [];
    let cursor = byId.get(folderId);
    for (let depth = 0; cursor && cursor.parentId && depth < 10; depth += 1) {
      names.unshift(cursor.name);
      cursor = byId.get(cursor.parentId);
    }
    return names.join(' / ');
  }
}
