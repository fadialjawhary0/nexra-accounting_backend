import { Injectable, NotFoundException } from '@nestjs/common';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import { fold } from '../../common/text.js';
import { validationFailed } from '../../common/validation/failure.js';
import type { Client, Folder, FolderTemplate, Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { SettingsService } from '../../lib/settings/settings.service.js';
import { folderNameOf } from '../clients/client-record.js';
import { MAX_TEMPLATE_DEPTH } from './document-settings.constants.js';
import type { FolderTemplateDto } from './dto/document-settings.dto.js';

const ENTITY = 'folder_template';

/** A folder name people type: no characters a file name cannot hold, no double spaces. */
const cleanName = (value: string): string => value.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);

const slug = (value: string): string =>
  fold(value)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 36);

/**
 * The standard folders of a client (Settings → Documents → Folders): made for every new client inside the folder `<number>- <name>`, nested as deep as
 * the office wants (three levels). Changing the template never touches folders that exist — "Apply to existing clients" adds the folders a client
 * does not have yet, and never moves, renames or brings back a folder somebody removed.
 */
@Injectable()
export class FolderTemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  /* ── Reading ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  async all(): Promise<FolderTemplate[]> {
    return this.prisma.folderTemplate.findMany({ orderBy: [{ sortOrder: 'asc' }, { nameNl: 'asc' }] });
  }

  /** The folders in tree order (a folder, then its folders) with their depth and how many client folders were made from each. */
  async list(locale: AppLocale) {
    const [rows, groups] = await Promise.all([
      this.all(),
      this.prisma.folder.groupBy({ by: ['templateCode'], where: { isActive: true, templateCode: { not: null } }, _count: { _all: true } }),
    ]);
    const counts = new Map(groups.map(group => [group.templateCode, group._count._all]));
    const children = new Map<string | null, FolderTemplate[]>();
    for (const row of rows) children.set(row.parentCode, [...(children.get(row.parentCode) ?? []), row]);
    const out: Array<ReturnType<FolderTemplatesService['view']>> = [];
    const walk = (parent: string | null, depth: number, seen: Set<string>) => {
      for (const row of children.get(parent) ?? []) {
        if (seen.has(row.code)) continue;
        seen.add(row.code);
        out.push(this.view(row, locale, depth, counts.get(row.code) ?? 0));
        walk(row.code, depth + 1, seen);
      }
    };
    walk(null, 1, new Set());
    return out;
  }

  view(row: FolderTemplate, locale: AppLocale, depth: number, folders: number) {
    return {
      id: row.id,
      code: row.code,
      parentCode: row.parentCode,
      name: locale === 'en' ? row.nameEn || row.nameNl : row.nameNl || row.nameEn,
      nameNl: row.nameNl,
      nameEn: row.nameEn,
      order: row.sortOrder,
      depth,
      isActive: row.isActive,
      isSystem: row.isSystem,
      folders,
    };
  }

  /** The standard folders by every name they are known by — to recognise a folder of the old tree when files are imported. */
  async knownFolders(): Promise<Array<{ code: string; names: string[] }>> {
    return (await this.prisma.folderTemplate.findMany({ where: { isActive: true }, select: { code: true, nameNl: true, nameEn: true } })).map(row => ({ code: row.code, names: [row.nameNl, row.nameEn] }));
  }

  /* ── Changing ─────────────────────────────────────────────────────────────────────────────────────────────────── */

  async create(dto: FolderTemplateDto, locale: AppLocale) {
    const code = dto.code ?? (await this.freeCode(slug(dto.nameEn) || slug(dto.nameNl) || 'folder'));
    if (await this.prisma.folderTemplate.findUnique({ where: { code } })) throw validationFailed({ code: 'validation.alreadyExists' });
    const checked = await this.checked(dto, null);
    const siblings = await this.prisma.folderTemplate.aggregate({ where: { parentCode: checked.parentCode }, _max: { sortOrder: true } });
    const row = await this.prisma.folderTemplate.create({ data: { code, ...checked, sortOrder: (siblings._max.sortOrder ?? 0) + 10 } });
    await this.audit.log({ action: 'created', entityType: ENTITY, entityId: row.id, entityLabel: row.nameNl, after: this.snapshot(row) });
    return this.view(row, locale, 1, 0);
  }

  async update(id: string, dto: FolderTemplateDto, locale: AppLocale) {
    const row = await this.rowOrThrow(id);
    const checked = await this.checked(dto, row);
    const updated = await this.prisma.folderTemplate.update({ where: { id }, data: checked });
    const diff = AuditService.changes(this.snapshot(row), this.snapshot(updated));
    if (Object.keys(diff.after).length) await this.audit.log({ action: 'updated', entityType: ENTITY, entityId: id, entityLabel: updated.nameNl, before: diff.before, after: diff.after });
    return this.view(updated, locale, 1, 0);
  }

  async setActive(id: string, active: boolean, locale: AppLocale) {
    const row = await this.rowOrThrow(id);
    if (row.isActive === active) return this.view(row, locale, 1, 0);
    const updated = await this.prisma.folderTemplate.update({ where: { id }, data: { isActive: active } });
    await this.audit.log({ action: active ? 'activated' : 'deactivated', entityType: ENTITY, entityId: id, entityLabel: row.nameNl });
    return this.view(updated, locale, 1, 0);
  }

  /** The order of the folders next to each other (the ids of one level, in the new order). */
  async reorder(ids: string[]): Promise<void> {
    const known = new Set((await this.all()).map(row => row.id));
    const order = ids.filter(id => known.has(id));
    await this.prisma.$transaction(order.map((id, index) => this.prisma.folderTemplate.update({ where: { id }, data: { sortOrder: (index + 1) * 10 } })));
    await this.audit.log({ action: 'updated', entityType: ENTITY, entityLabel: 'order', meta: { reordered: order.length } });
  }

  /* ── Making folders ───────────────────────────────────────────────────────────────────────────────────────────── */

  /** Makes the main folder and the standard folders of a new client. Call inside the transaction that creates the client. */
  async createFor(tx: Prisma.TransactionClient, client: Pick<Client, 'id' | 'number' | 'name'>): Promise<void> {
    const root = await tx.folder.create({ data: { clientId: client.id, name: folderNameOf(client), sortOrder: 0 } });
    await this.fill(tx, client.id, root, new Set());
  }

  /** Adds the standard folders a client does not have yet — one client, or every client that is not stopped. */
  async apply(clientId?: string): Promise<{ clients: number; created: number }> {
    const clients = await this.prisma.client.findMany({ where: clientId ? { id: clientId } : { isActive: true }, select: { id: true, number: true, name: true } });
    if (clientId && !clients.length) throw new NotFoundException({ code: 'not_found', message: 'Client not found' });
    let created = 0;
    for (const client of clients) {
      created += await this.prisma.$transaction(async tx => {
        const root = (await tx.folder.findFirst({ where: { clientId: client.id, parentId: null, isActive: true } })) ?? (await tx.folder.create({ data: { clientId: client.id, name: folderNameOf(client), sortOrder: 0 } }));
        const have = new Set((await tx.folder.findMany({ where: { clientId: client.id, templateCode: { not: null } }, select: { templateCode: true } })).map(folder => folder.templateCode as string));
        return this.fill(tx, client.id, root, have);
      });
    }
    await this.audit.log({ action: 'updated', entityType: ENTITY, entityLabel: 'apply', meta: { clients: clients.length, created } });
    return { clients: clients.length, created };
  }

  /** Creates, level by level, the standard folders `have` does not hold yet; a folder whose parent is switched off or missing is skipped. */
  private async fill(tx: Prisma.TransactionClient, clientId: string, root: Folder, have: Set<string>): Promise<number> {
    const english = this.settings.get<string>('locale.documentLocale') === 'en';
    const templates = await tx.folderTemplate.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { nameNl: 'asc' }] });
    const folderOf = new Map<string, string>();
    // Folders the client already has (from an earlier run) are the parents of the new ones.
    for (const folder of await tx.folder.findMany({ where: { clientId, templateCode: { in: templates.map(template => template.code) }, isActive: true }, select: { id: true, templateCode: true } })) {
      if (folder.templateCode) folderOf.set(folder.templateCode, folder.id);
    }
    let created = 0;
    for (let depth = 1; depth <= MAX_TEMPLATE_DEPTH; depth += 1) {
      const level = templates.filter(template => this.depthOf(template, templates) === depth);
      for (const [index, template] of level.entries()) {
        if (have.has(template.code)) continue;
        const parentId = template.parentCode ? folderOf.get(template.parentCode) : root.id;
        if (!parentId) continue;
        const folder = await tx.folder.create({
          data: { clientId, parentId, name: await this.freeName(tx, clientId, parentId, cleanName(english ? template.nameEn : template.nameNl) || template.code), templateCode: template.code, sortOrder: (index + 1) * 10 },
        });
        folderOf.set(template.code, folder.id);
        created += 1;
      }
    }
    return created;
  }

  private depthOf(template: FolderTemplate, all: readonly FolderTemplate[]): number {
    let depth = 1;
    let parent = template.parentCode;
    while (parent && depth <= MAX_TEMPLATE_DEPTH) {
      parent = all.find(candidate => candidate.code === parent)?.parentCode ?? null;
      depth += 1;
    }
    return depth;
  }

  private async freeName(tx: Prisma.TransactionClient, clientId: string, parentId: string, name: string): Promise<string> {
    const taken = new Set((await tx.folder.findMany({ where: { clientId, parentId, isActive: true }, select: { name: true } })).map(sibling => sibling.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let number = 2; number < 100; number += 1) if (!taken.has(`${name} (${number})`.toLowerCase())) return `${name} (${number})`;
    return `${name} (${Date.now()})`;
  }

  /* ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  private async rowOrThrow(id: string): Promise<FolderTemplate> {
    const row = await this.prisma.folderTemplate.findUnique({ where: { id } });
    if (!row) throw new NotFoundException({ code: 'not_found', message: 'Folder not found' });
    return row;
  }

  private async freeCode(base: string): Promise<string> {
    const taken = new Set((await this.prisma.folderTemplate.findMany({ where: { code: { startsWith: base } }, select: { code: true } })).map(row => row.code));
    if (!taken.has(base)) return base;
    for (let number = 2; number < 100; number += 1) if (!taken.has(`${base}_${number}`)) return `${base}_${number}`;
    return `${base}_${Date.now()}`;
  }

  /** Names filled in, no two folders with one name next to each other, a parent that exists, no loops, not deeper than allowed. */
  private async checked(dto: FolderTemplateDto, current: FolderTemplate | null) {
    const problems: Record<string, string> = {};
    const nameNl = cleanName(dto.nameNl);
    const nameEn = cleanName(dto.nameEn);
    if (!nameNl) problems.nameNl = 'validation.required';
    if (!nameEn) problems.nameEn = 'validation.required';
    const parentCode = dto.parentCode?.trim() || null;
    const all = await this.all();
    if (parentCode) {
      const parent = all.find(row => row.code === parentCode);
      if (!parent || parent.code === current?.code) problems.parentCode = 'validation.invalid';
      else {
        // A folder cannot sit inside one of its own folders, and the tree stays within its depth.
        let cursor: string | null = parent.parentCode;
        for (let step = 0; cursor && step <= MAX_TEMPLATE_DEPTH + 1; step += 1) {
          if (cursor === current?.code) problems.parentCode = 'validation.invalid';
          cursor = all.find(row => row.code === cursor)?.parentCode ?? null;
        }
        if (this.depthOf(parent, all) >= MAX_TEMPLATE_DEPTH) problems.parentCode = 'validation.invalid';
      }
    }
    const sibling = all.find(row => row.parentCode === parentCode && row.code !== current?.code && (row.nameNl.toLowerCase() === nameNl.toLowerCase() || row.nameEn.toLowerCase() === nameEn.toLowerCase()));
    if (sibling) problems[sibling.nameNl.toLowerCase() === nameNl.toLowerCase() ? 'nameNl' : 'nameEn'] = 'validation.alreadyExists';
    if (Object.keys(problems).length) throw validationFailed(problems);
    return { nameNl, nameEn, parentCode };
  }

  private snapshot(row: FolderTemplate): Record<string, unknown> {
    return { nameNl: row.nameNl, nameEn: row.nameEn, parentCode: row.parentCode };
  }
}
