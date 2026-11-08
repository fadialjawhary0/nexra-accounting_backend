import { ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import type { List, ListItem } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { ALIVE } from '../../lib/database/soft-delete.js';
import type { CreateListDto, CreateListItemDto, UpdateListDto, UpdateListItemDto } from './dto/list.dto.js';
import { DeletionService } from '../deletion/deletion.service.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';

/** `Rechtsvorm (BV)` → `rechtsvorm_bv` — a stable code from a name. */
export const toCode = (name: string): string =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

const localized = (locale: AppLocale, nl: string, en: string) => (locale === 'en' ? en : nl);

const serializeItem = (item: ListItem, locale: AppLocale) => ({
  id: item.id,
  code: item.code,
  name: localized(locale, item.nameNl, item.nameEn),
  names: { nl: item.nameNl, en: item.nameEn },
  order: item.sortOrder,
  active: item.isActive,
  system: item.isSystem,
  meta: item.meta as Record<string, unknown>,
});

/**
 * Pick-lists and status lookups: one table pair for every fixed list in the app. Records store the item `code`; screens ask for the
 * names in the person's language. An item is switched off to keep it on offer later; an item of a choice list (`allowNewItems`) can also be deleted (soft), built-in ones
 * too: it is no longer offered anywhere, records that hold its code keep showing its name. The fixed lists (the statuses) are what the program itself works with.
 */
@Injectable()
export class ListsService {
  /** Features that store a list's codes (form definitions …) report why a list may not be removed. */
  private readonly usageChecks: Array<(key: string) => Promise<string | null>> = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly deletion: DeletionService,
  ) {}

  registerUsageCheck(check: (key: string) => Promise<string | null>): void {
    this.usageChecks.push(check);
  }

  /* ── Reading ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  async overview(locale: AppLocale) {
    const lists = await this.prisma.list.findMany({ orderBy: [{ kind: 'asc' }, { nameNl: 'asc' }], include: { items: { where: ALIVE, select: { isActive: true } } } });
    return lists.map(list => ({
      key: list.key,
      name: localized(locale, list.nameNl, list.nameEn),
      names: { nl: list.nameNl, en: list.nameEn },
      description: localized(locale, list.descriptionNl, list.descriptionEn),
      kind: list.kind,
      system: list.isSystem,
      allowNewItems: list.allowNewItems,
      itemCount: list.items.length,
      activeCount: list.items.filter(item => item.isActive).length,
    }));
  }

  async detail(key: string, locale: AppLocale) {
    const list = await this.findOrThrow(key);
    return this.serializeList(list, locale);
  }

  /**
   * Several lists at once, in the person's language: active and inactive items (a record may still carry a switched-off value) and the deleted ones (`deleted`, never offered:
   * a record that holds one keeps showing its name — on the screen and in exports, letters and forms).
   */
  async lookups(keys: string[], locale: AppLocale) {
    const lists = await this.prisma.withDeleted.list.findMany({ where: { key: { in: keys }, deletedAt: null }, include: { items: { orderBy: [{ sortOrder: 'asc' }, { nameNl: 'asc' }] } } });
    return Object.fromEntries(lists.map(list => [list.key, { kind: list.kind, items: list.items.map(item => ({ ...serializeItem(item, locale), ...(item.deletedAt && { active: false, deleted: true }) })) }]));
  }

  /** For other modules: the codes a record may currently be given. */
  async activeCodes(key: string): Promise<Set<string>> {
    const items = await this.prisma.listItem.findMany({ where: { list: { key }, isActive: true }, select: { code: true } });
    return new Set(items.map(item => item.code));
  }

  /* ── Lists ────────────────────────────────────────────────────────────────────────────────────────────────────── */

  async createList(dto: CreateListDto, locale: AppLocale) {
    const key = toCode(dto.nameEn) || toCode(dto.nameNl);
    if (!key) throw this.invalid({ nameEn: 'validation.invalid' });
    if (await this.prisma.list.findUnique({ where: { key } })) throw this.invalid({ nameEn: 'validation.alreadyExists' });
    const list = await this.prisma.list.create({
      data: { key, nameNl: dto.nameNl.trim(), nameEn: dto.nameEn.trim(), descriptionNl: dto.descriptionNl?.trim() ?? '', descriptionEn: dto.descriptionEn?.trim() ?? '', kind: 'picklist', isSystem: false, allowNewItems: true },
      include: { items: { where: ALIVE } },
    });
    await this.audit.log({ action: 'created', entityType: 'list', entityId: list.key, entityLabel: list.nameEn });
    return this.serializeList(list, locale);
  }

  async updateList(key: string, dto: UpdateListDto, locale: AppLocale) {
    const list = await this.findOrThrow(key);
    const data = {
      ...(dto.nameNl !== undefined && { nameNl: dto.nameNl.trim() }),
      ...(dto.nameEn !== undefined && { nameEn: dto.nameEn.trim() }),
      ...(dto.descriptionNl !== undefined && { descriptionNl: dto.descriptionNl.trim() }),
      ...(dto.descriptionEn !== undefined && { descriptionEn: dto.descriptionEn.trim() }),
    };
    const updated = await this.prisma.list.update({ where: { id: list.id }, data, include: { items: { where: ALIVE, orderBy: [{ sortOrder: 'asc' }] } } });
    const diff = AuditService.changes(
      { nameNl: list.nameNl, nameEn: list.nameEn, descriptionNl: list.descriptionNl, descriptionEn: list.descriptionEn },
      { nameNl: updated.nameNl, nameEn: updated.nameEn, descriptionNl: updated.descriptionNl, descriptionEn: updated.descriptionEn },
    );
    if (Object.keys(diff.after).length) await this.audit.log({ action: 'updated', entityType: 'list', entityId: key, entityLabel: updated.nameEn, before: diff.before, after: diff.after });
    return this.serializeList(updated, locale);
  }

  /** Deletes a list the office made (soft, with its items), unless a form still uses it. */
  async deleteList(key: string, user: AuthenticatedUser) {
    const list = await this.findOrThrow(key);
    if (list.isSystem) throw new ConflictException({ code: 'system_list', message: 'Built-in lists cannot be deleted.' });
    for (const check of this.usageChecks) {
      const reason = await check(key);
      if (reason) throw new ConflictException({ code: 'list_in_use', message: `This list is used by ${reason}.`, details: { usedBy: reason } });
    }
    return { key, ...(await this.deletion.delete('list', list.id, user)) };
  }

  /* ── Items ────────────────────────────────────────────────────────────────────────────────────────────────────── */

  async addItem(key: string, dto: CreateListItemDto, locale: AppLocale) {
    const list = await this.findOrThrow(key);
    if (!list.allowNewItems) throw new ForbiddenException({ code: 'list_fixed', message: 'Items cannot be added to this list.' });
    const baseCode = toCode(dto.nameEn) || toCode(dto.nameNl);
    if (!baseCode) throw this.invalid({ nameEn: 'validation.invalid' });
    const existing = await this.prisma.withDeleted.listItem.findMany({ where: { listId: list.id }, select: { id: true, code: true, sortOrder: true, deletedAt: true, nameNl: true, nameEn: true } });
    // The same choice again (a built-in code need not follow the name, so the names count too): the deleted row comes back with its code, and the records that hold it are right again.
    const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
    const deleted = existing.find(item => item.deletedAt && !item.code.includes('~deleted~') && (item.code === baseCode || same(item.nameNl, dto.nameNl) || same(item.nameEn, dto.nameEn)));
    if (deleted) {
      const back = await this.prisma.withDeleted.listItem.update({ where: { id: deleted.id }, data: { nameNl: dto.nameNl.trim(), nameEn: dto.nameEn.trim(), isActive: true, deletedAt: null, deletedById: null, deletionId: null } });
      await this.audit.log({ action: 'restored', entityType: 'list', entityId: key, entityLabel: `${list.nameEn}: ${back.nameEn}`, after: { code: back.code, nameNl: back.nameNl, nameEn: back.nameEn } });
      return serializeItem(back, locale);
    }
    const taken = new Set(existing.map(item => item.code));
    let code = baseCode;
    for (let suffix = 2; taken.has(code); suffix += 1) code = `${baseCode}_${suffix}`;
    const sortOrder = existing.reduce((max, item) => Math.max(max, item.sortOrder), 0) + 10;
    const item = await this.prisma.listItem.create({
      data: { listId: list.id, code, nameNl: dto.nameNl.trim(), nameEn: dto.nameEn.trim(), sortOrder, isSystem: false, meta: dto.tone ? { tone: dto.tone } : {} },
    });
    await this.audit.log({ action: 'created', entityType: 'list', entityId: key, entityLabel: `${list.nameEn}: ${item.nameEn}`, after: { code, nameNl: item.nameNl, nameEn: item.nameEn } });
    return serializeItem(item, locale);
  }

  async updateItem(key: string, code: string, dto: UpdateListItemDto, locale: AppLocale) {
    const list = await this.findOrThrow(key);
    const item = await this.prisma.listItem.findUnique({ where: { listId_code: { listId: list.id, code } } });
    if (!item) throw new NotFoundException({ code: 'not_found', message: 'List item not found' });
    const meta = { ...(item.meta as Record<string, unknown>), ...(dto.meta?.terminal !== undefined && { terminal: Boolean(dto.meta.terminal) }), ...(dto.tone && { tone: dto.tone }) };
    const updated = await this.prisma.listItem.update({
      where: { id: item.id },
      data: {
        ...(dto.nameNl !== undefined && { nameNl: dto.nameNl.trim() }),
        ...(dto.nameEn !== undefined && { nameEn: dto.nameEn.trim() }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        meta,
      },
    });
    const diff = AuditService.changes(
      { nameNl: item.nameNl, nameEn: item.nameEn, isActive: item.isActive, meta: item.meta },
      { nameNl: updated.nameNl, nameEn: updated.nameEn, isActive: updated.isActive, meta: updated.meta },
    );
    if (Object.keys(diff.after).length) {
      const action = dto.isActive !== undefined && dto.isActive !== item.isActive ? (dto.isActive ? 'activated' : 'deactivated') : 'updated';
      await this.audit.log({ action, entityType: 'list', entityId: key, entityLabel: `${list.nameEn}: ${updated.nameEn}`, before: diff.before, after: diff.after });
    }
    return serializeItem(updated, locale);
  }

  async reorder(key: string, codes: string[], locale: AppLocale) {
    const list = await this.findOrThrow(key);
    const items = await this.prisma.listItem.findMany({ where: { listId: list.id } });
    const known = new Set(items.map(item => item.code));
    if (codes.length !== known.size || codes.some(code => !known.has(code)) || new Set(codes).size !== codes.length) {
      throw this.invalid({ codes: 'validation.invalid' });
    }
    await this.prisma.$transaction(codes.map((code, index) => this.prisma.listItem.update({ where: { listId_code: { listId: list.id, code } }, data: { sortOrder: (index + 1) * 10 } })));
    await this.audit.log({ action: 'updated', entityType: 'list', entityId: key, entityLabel: list.nameEn, meta: { reordered: true } });
    return this.detail(key, locale);
  }

  /* ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  private async findOrThrow(key: string): Promise<List & { items: ListItem[] }> {
    const list = await this.prisma.list.findUnique({ where: { key }, include: { items: { where: ALIVE, orderBy: [{ sortOrder: 'asc' }, { nameNl: 'asc' }] } } });
    if (!list) throw new NotFoundException({ code: 'not_found', message: 'List not found' });
    return list;
  }

  private serializeList(list: List & { items: ListItem[] }, locale: AppLocale) {
    return {
      key: list.key,
      name: localized(locale, list.nameNl, list.nameEn),
      names: { nl: list.nameNl, en: list.nameEn },
      description: localized(locale, list.descriptionNl, list.descriptionEn),
      descriptions: { nl: list.descriptionNl, en: list.descriptionEn },
      kind: list.kind,
      system: list.isSystem,
      allowNewItems: list.allowNewItems,
      items: [...list.items].sort((a, b) => a.sortOrder - b.sortOrder).map(item => serializeItem(item, locale)),
    };
  }

  private invalid(fields: Record<string, string>) {
    return new UnprocessableEntityException({ code: 'validation_failed', message: 'Validation failed', fields });
  }
}
