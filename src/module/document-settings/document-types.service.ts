import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import { todayInAmsterdam } from '../../common/dates.js';
import { fold } from '../../common/text.js';
import { validationFailed } from '../../common/validation/failure.js';
import type { DocumentType, Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { FormsService } from '../forms/forms.service.js';
import { nameFromPattern, unknownTokens } from './document-naming.js';
import type { DocumentTypeDto } from './dto/document-settings.dto.js';

const CACHE_MS = 30_000;
const ENTITY = 'document_type';

/** `KvK-uittreksel` → `kvk_uittreksel`: a code made from a name. */
const slug = (value: string): string =>
  fold(value)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 36);

/**
 * The kinds of document the office works with (Settings → Documents → Types): who each is for, how long it stays valid, where it is filed and how its
 * file is named. Other parts of the program read the types through here (the upload, the import, the reminders, the worker list); the table is small
 * and read a lot, so it is kept in memory for a short while and forgotten whenever a type changes.
 */
@Injectable()
export class DocumentTypesService {
  private cache: { at: number; rows: DocumentType[] } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly forms: FormsService,
  ) {}

  /* ── Reading ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  async all(): Promise<DocumentType[]> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.rows;
    const rows = await this.prisma.documentType.findMany({ orderBy: [{ sortOrder: 'asc' }, { nameNl: 'asc' }] });
    this.cache = { at: Date.now(), rows };
    return rows;
  }

  async active(): Promise<DocumentType[]> {
    return (await this.all()).filter(row => row.isActive);
  }

  async byCode(code: string | null | undefined): Promise<DocumentType | null> {
    return code ? ((await this.all()).find(row => row.code === code) ?? null) : null;
  }

  async codeMap(): Promise<Map<string, DocumentType>> {
    return new Map((await this.all()).map(row => [row.code, row]));
  }

  /** Whether a code is a type that can be given to a file (it exists and is switched on). */
  async isUsable(code: string): Promise<boolean> {
    return (await this.active()).some(row => row.code === code);
  }

  /** The standard folder a type is filed in when nobody chose one (a code of the folder template). */
  async folderCodeOf(code: string | null | undefined): Promise<string | null> {
    return (await this.byCode(code))?.folderCode ?? null;
  }

  /** The person-form fields that hold the end of a document's validity (`id_expiry`, `permit_expiry`): the fields the active "follows the worker's record" types name. */
  async fieldKeys(): Promise<string[]> {
    return [...new Set((await this.active()).filter(row => row.validity === 'field' && row.validityField).map(row => row.validityField as string))];
  }

  /** The name of a type in a language. */
  static nameIn(row: Pick<DocumentType, 'nameNl' | 'nameEn'>, locale: AppLocale): string {
    return locale === 'en' ? row.nameEn || row.nameNl : row.nameNl || row.nameEn;
  }

  view(row: DocumentType, locale: AppLocale, documents?: number) {
    return {
      id: row.id,
      code: row.code,
      name: DocumentTypesService.nameIn(row, locale),
      nameNl: row.nameNl,
      nameEn: row.nameEn,
      scope: row.scope,
      validity: row.validity,
      validityMonths: row.validityMonths,
      validityField: row.validityField,
      warnDays: row.warnDays,
      versioned: row.versioned,
      personal: row.personal,
      folderCode: row.folderCode,
      namePattern: row.namePattern,
      keywords: row.keywords,
      order: row.sortOrder,
      isActive: row.isActive,
      isSystem: row.isSystem,
      ...(documents !== undefined && { documents }),
    };
  }

  /** The list for the screens: with `activeOnly` the pick-list of the upload dialog, otherwise the admin list with how many documents each type has. */
  async list(locale: AppLocale, activeOnly: boolean) {
    const rows = activeOnly ? await this.active() : await this.all();
    if (activeOnly) return rows.map(row => this.view(row, locale));
    const groups = await this.prisma.storedFile.groupBy({ by: ['docType'], where: { isActive: true, isCurrent: true, docType: { not: null } }, _count: { _all: true } });
    const counts = new Map(groups.map(group => [group.docType, group._count._all]));
    return rows.map(row => this.view(row, locale, counts.get(row.code) ?? 0));
  }

  /** What a pattern makes for an example client, worker and date — shown while the pattern is typed. */
  async namePreview(pattern: string, typeCode: string | undefined, locale: AppLocale) {
    const type = await this.byCode(typeCode);
    const name = nameFromPattern(pattern, { number: '042', client: 'Voorbeeld B.V.', worker: 'Jan de Vries', type: type ? DocumentTypesService.nameIn(type, locale) : locale === 'nl' ? 'Documentsoort' : 'Document type', date: todayInAmsterdam(), original: 'scan-0001' });
    return { name, unknown: unknownTokens(pattern) };
  }

  /* ── Changing ─────────────────────────────────────────────────────────────────────────────────────────────────── */

  async create(dto: DocumentTypeDto, locale: AppLocale) {
    const code = dto.code ?? (await this.freeCode(slug(dto.nameEn) || slug(dto.nameNl) || 'type'));
    if (await this.prisma.documentType.findUnique({ where: { code } })) throw validationFailed({ code: 'validation.alreadyExists' });
    const data = await this.checked(dto, null);
    const last = await this.prisma.documentType.aggregate({ _max: { sortOrder: true } });
    const row = await this.prisma.documentType.create({ data: { code, ...data, sortOrder: (last._max.sortOrder ?? 0) + 10 } });
    this.cache = null;
    await this.audit.log({ action: 'created', entityType: ENTITY, entityId: row.id, entityLabel: row.nameNl, after: this.snapshot(row) });
    return this.view(row, locale, 0);
  }

  async update(id: string, dto: DocumentTypeDto, locale: AppLocale) {
    const row = await this.rowOrThrow(id);
    const data = await this.checked(dto, row);
    const updated = await this.prisma.documentType.update({ where: { id }, data });
    this.cache = null;
    const diff = AuditService.changes(this.snapshot(row), this.snapshot(updated));
    if (Object.keys(diff.after).length) await this.audit.log({ action: 'updated', entityType: ENTITY, entityId: id, entityLabel: updated.nameNl, before: diff.before, after: diff.after });
    return this.view(updated, locale);
  }

  async setActive(id: string, active: boolean, locale: AppLocale) {
    const row = await this.rowOrThrow(id);
    if (!active && row.isSystem) {
      throw new ConflictException({ code: 'document_type_system', message: 'The import and the generated documents use this type, so it cannot be switched off.' });
    }
    if (row.isActive === active) return this.view(row, locale);
    const updated = await this.prisma.documentType.update({ where: { id }, data: { isActive: active } });
    this.cache = null;
    await this.audit.log({ action: active ? 'activated' : 'deactivated', entityType: ENTITY, entityId: id, entityLabel: row.nameNl });
    return this.view(updated, locale);
  }

  async reorder(ids: string[]): Promise<void> {
    const known = new Set((await this.all()).map(row => row.id));
    const order = ids.filter(id => known.has(id));
    await this.prisma.$transaction(order.map((id, index) => this.prisma.documentType.update({ where: { id }, data: { sortOrder: (index + 1) * 10 } })));
    this.cache = null;
    await this.audit.log({ action: 'updated', entityType: ENTITY, entityLabel: 'order', meta: { reordered: order.length } });
  }

  /* ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  private async rowOrThrow(id: string): Promise<DocumentType> {
    const row = await this.prisma.documentType.findUnique({ where: { id } });
    if (!row) throw new NotFoundException({ code: 'not_found', message: 'Document type not found' });
    return row;
  }

  private async freeCode(base: string): Promise<string> {
    const taken = new Set((await this.prisma.documentType.findMany({ where: { code: { startsWith: base } }, select: { code: true } })).map(row => row.code));
    if (!taken.has(base)) return base;
    for (let number = 2; number < 100; number += 1) if (!taken.has(`${base}_${number}`)) return `${base}_${number}`;
    return `${base}_${Date.now()}`;
  }

  /** The rules that go together: months for an age rule, a worker-record field for a "follows the worker" rule, a folder that exists, a pattern with known tokens. */
  private async checked(dto: DocumentTypeDto, current: DocumentType | null) {
    const problems: Record<string, string> = {};
    const nameNl = dto.nameNl.trim();
    const nameEn = dto.nameEn.trim();
    if (!nameNl) problems.nameNl = 'validation.required';
    if (!nameEn) problems.nameEn = 'validation.required';
    const clash = await this.prisma.documentType.findFirst({
      where: { OR: [{ nameNl: { equals: nameNl, mode: 'insensitive' } }, { nameEn: { equals: nameEn, mode: 'insensitive' } }], ...(current && { NOT: { id: current.id } }) },
      select: { nameNl: true, nameEn: true },
    });
    if (clash) problems[clash.nameNl.toLowerCase() === nameNl.toLowerCase() ? 'nameNl' : 'nameEn'] = 'validation.alreadyExists';

    let validityMonths: number | null = null;
    let validityField: string | null = null;
    if (dto.validity === 'age') {
      if (!dto.validityMonths) problems.validityMonths = 'validation.required';
      else validityMonths = dto.validityMonths;
    } else if (dto.validity === 'field') {
      if (dto.scope === 'client') problems.scope = 'validation.invalid';
      const key = dto.validityField?.trim() ?? '';
      const { doc } = await this.forms.live('person');
      if (!key) problems.validityField = 'validation.required';
      else if (!doc.fields.some(field => field.key === key && field.active && field.type === 'date')) problems.validityField = 'validation.invalid';
      else validityField = key;
    }

    const folderCode = dto.folderCode?.trim() || null;
    if (folderCode && !(await this.prisma.folderTemplate.findUnique({ where: { code: folderCode }, select: { id: true } }))) problems.folderCode = 'validation.invalid';
    const namePattern = (dto.namePattern ?? '').trim();
    if (unknownTokens(namePattern).length) problems.namePattern = 'validation.invalid';
    if (Object.keys(problems).length) throw validationFailed(problems);

    return {
      nameNl,
      nameEn,
      scope: dto.scope,
      validity: dto.validity,
      validityMonths,
      validityField,
      warnDays: dto.warnDays ?? null,
      versioned: dto.versioned ?? false,
      personal: dto.personal ?? false,
      folderCode,
      namePattern,
      keywords: (dto.keywords ?? '')
        .split(',')
        .map(word => word.trim())
        .filter(Boolean)
        .join(', '),
    } satisfies Prisma.DocumentTypeUncheckedUpdateInput;
  }

  private snapshot(row: DocumentType): Record<string, unknown> {
    return {
      nameNl: row.nameNl,
      nameEn: row.nameEn,
      scope: row.scope,
      validity: row.validity,
      validityMonths: row.validityMonths,
      validityField: row.validityField,
      warnDays: row.warnDays,
      versioned: row.versioned,
      personal: row.personal,
      folderCode: row.folderCode,
      namePattern: row.namePattern,
      keywords: row.keywords,
    };
  }
}
