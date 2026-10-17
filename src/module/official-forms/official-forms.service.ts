import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ApiResult, paged } from '../../common/api-result.js';
import { formatDay } from '../../common/dates.js';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import { pageMeta, toSkipTake } from '../../common/pagination.js';
import { fold } from '../../common/text.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { validationFailed } from '../../common/validation/failure.js';
import type { AddressBookEntry, OfficialForm, OfficialFormVersion, Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import type { ExportTable } from '../../lib/exports/export.types.js';
import { ExportsService } from '../../lib/exports/exports.service.js';
import { addressLines } from '../address-book/address-book.service.js';
import { unknownTokens } from '../document-settings/document-naming.js';
import { DocumentTypesService } from '../document-settings/document-types.service.js';
import type { FormExportQuery, FormListQuery, FormStatusDto, SaveFormDto } from './dto/official-forms.dto.js';
import { isFillable, readFields } from './form-fields.js';
import { readMapping } from './form-mapping.js';
import { DEFAULT_FORM_DOC_TYPE, FORM_NAME_PATTERN_DEFAULT, OFFICIAL_FORM_ENTITY, PENDING_STATUSES } from './official-forms.constants.js';

type Row = OfficialForm & { recipient: AddressBookEntry | null; versions: OfficialFormVersion[] };

const withDetails = { recipient: true, versions: { orderBy: { version: 'desc' as const } } };

const slug = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^[0-9_]+/, '')
    .slice(0, 60);

/**
 * The library of official PDF forms: what each form is called (in both languages), the code printed on it, where it goes, who it is about, how its filled file is named
 * and filed, and its editions (the PDFs). A form is switched off, never deleted: what was filled in with it stays in the log.
 */
@Injectable()
export class OfficialFormsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly exports: ExportsService,
    private readonly types: DocumentTypesService,
  ) {}

  /* ── Reading ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  /** The newest edition of a form: the one that is filled in. */
  static current(row: Pick<Row, 'versions'>): OfficialFormVersion | null {
    return row.versions[0] ?? null;
  }

  static versionSummary(version: OfficialFormVersion) {
    const fields = readFields(version.fields);
    const mapping = readMapping(version.mapping);
    return {
      id: version.id,
      version: version.version,
      fileId: version.fileId,
      fileName: version.fileName,
      pageCount: version.pageCount,
      fields: fields.filter(isFillable).length,
      mapped: mapping.filter(entry => entry.source !== null && fields.some(field => field.name === entry.pdfField)).length,
      isSample: version.isSample,
      note: version.note,
      createdAt: version.createdAt.toISOString(),
    };
  }

  view(row: Row, extra: { pending: number; used: number; lastUsed: string | null }, locale: AppLocale) {
    const current = OfficialFormsService.current(row);
    const nl = locale === 'nl';
    return {
      id: row.id,
      code: row.code,
      name: nl ? row.nameNl : row.nameEn,
      nameNl: row.nameNl,
      nameEn: row.nameEn,
      description: (nl ? row.descriptionNl : row.descriptionEn) || row.descriptionNl || row.descriptionEn,
      descriptionNl: row.descriptionNl,
      descriptionEn: row.descriptionEn,
      authorityCode: row.authorityCode,
      officialUrl: row.officialUrl,
      subject: row.subject,
      periodKind: row.periodKind,
      recipient: row.recipient ? { id: row.recipient.id, name: row.recipient.name, lines: addressLines(row.recipient, locale), isActive: row.recipient.isActive } : null,
      followUpDays: row.followUpDays,
      warnWhenPending: row.warnWhenPending,
      docType: row.docType,
      folderCode: row.folderCode,
      namePattern: row.namePattern,
      flatten: row.flatten,
      isActive: row.isActive,
      current: current ? OfficialFormsService.versionSummary(current) : null,
      versions: row.versions.length,
      /** The newest edition has something mapped: the form can be filled in. */
      ready: Boolean(current && OfficialFormsService.versionSummary(current).mapped > 0),
      ...extra,
    };
  }

  private async extras(ids: string[]): Promise<Map<string, { pending: number; used: number; lastUsed: string | null }>> {
    const rows = ids.length ? await this.prisma.formSubmission.findMany({ where: { formId: { in: ids } }, select: { formId: true, status: true, isActive: true, preparedOn: true } }) : [];
    const map = new Map(ids.map(id => [id, { pending: 0, used: 0, lastUsed: null as string | null }]));
    for (const row of rows) {
      const entry = map.get(row.formId)!;
      if (row.isActive) {
        entry.used += 1;
        if (PENDING_STATUSES.includes(row.status)) entry.pending += 1;
        const day = formatDay(row.preparedOn);
        if (!entry.lastUsed || day > entry.lastUsed) entry.lastUsed = day;
      }
    }
    return map;
  }

  private where(query: Pick<FormListQuery, 'search' | 'status' | 'subject'>): Prisma.OfficialFormWhereInput {
    const terms = fold(query.search ?? '').split(' ').filter(Boolean);
    const status = query.status ?? 'active';
    return {
      ...(status !== 'all' && { isActive: status === 'active' }),
      ...(query.subject && { subject: query.subject }),
      ...(terms.length && { AND: terms.map(term => ({ OR: [{ nameNl: { contains: term, mode: 'insensitive' as const } }, { nameEn: { contains: term, mode: 'insensitive' as const } }, { code: { contains: term } }, { authorityCode: { contains: term, mode: 'insensitive' as const } }] })) }),
    };
  }

  private orderBy(sort: string | undefined, locale: AppLocale): Prisma.OfficialFormOrderByWithRelationInput[] {
    const [field, direction] = (sort ?? '').split(',')[0]?.split(':') ?? [];
    const dir = direction === 'desc' ? 'desc' : 'asc';
    if (field === 'name') return [{ [locale === 'nl' ? 'nameNl' : 'nameEn']: dir }];
    if (field === 'authorityCode') return [{ authorityCode: dir }];
    if (field === 'createdAt') return [{ createdAt: dir }];
    return [{ sortOrder: 'asc' }, { nameNl: 'asc' }];
  }

  async list(query: FormListQuery, locale: AppLocale): Promise<ApiResult> {
    const where = this.where(query);
    const [total, rows, counts] = await Promise.all([
      this.prisma.officialForm.count({ where }),
      this.prisma.officialForm.findMany({ where, orderBy: this.orderBy(query.sort, locale), include: withDetails, ...toSkipTake(query) }),
      query.stats ? this.prisma.officialForm.groupBy({ by: ['isActive'], where: this.where({ search: query.search, subject: query.subject, status: 'all' }), _count: { _all: true } }) : Promise.resolve(null),
    ]);
    const extras = await this.extras(rows.map(row => row.id));
    return paged(
      rows.map(row => this.view(row, extras.get(row.id)!, locale)),
      pageMeta(total, query, counts ? { counts: { active: counts.find(row => row.isActive)?._count._all ?? 0, inactive: counts.find(row => !row.isActive)?._count._all ?? 0 } } : {}),
    );
  }

  async rowOrThrow(id: string): Promise<Row> {
    const row = await this.prisma.officialForm.findUnique({ where: { id }, include: withDetails });
    if (!row) throw new NotFoundException({ code: 'not_found', message: 'Form not found' });
    return row;
  }

  async one(id: string, locale: AppLocale) {
    const row = await this.rowOrThrow(id);
    const extras = await this.extras([id]);
    return { ...this.view(row, extras.get(id)!, locale), editions: row.versions.map(version => OfficialFormsService.versionSummary(version)) };
  }

  /* ── Changing ─────────────────────────────────────────────────────────────────────────────────────────────────── */

  private async clean(dto: SaveFormDto) {
    const problems: Record<string, string> = {};
    const nameNl = dto.nameNl.trim();
    const nameEn = dto.nameEn.trim();
    if (!nameNl) problems.nameNl = 'validation.required';
    if (!nameEn) problems.nameEn = 'validation.required';
    const officialUrl = (dto.officialUrl ?? '').trim();
    if (officialUrl) {
      try {
        if (!/^https?:$/.test(new URL(officialUrl).protocol)) problems.officialUrl = 'validation.invalidUrl';
      } catch {
        problems.officialUrl = 'validation.invalidUrl';
      }
    }
    const recipientId = dto.recipientId || null;
    if (recipientId && !(await this.prisma.addressBookEntry.findFirst({ where: { id: recipientId, isActive: true }, select: { id: true } }))) problems.recipientId = 'validation.selectOption';
    const docType = (dto.docType ?? DEFAULT_FORM_DOC_TYPE).trim() || DEFAULT_FORM_DOC_TYPE;
    const type = await this.types.byCode(docType);
    if (!type || !type.isActive) problems.docType = 'validation.selectOption';
    const folderCode = dto.folderCode?.trim() || null;
    if (folderCode && !(await this.prisma.folderTemplate.findFirst({ where: { code: folderCode, isActive: true }, select: { id: true } }))) problems.folderCode = 'validation.selectOption';
    const namePattern = (dto.namePattern ?? FORM_NAME_PATTERN_DEFAULT).trim() || FORM_NAME_PATTERN_DEFAULT;
    if (unknownTokens(namePattern).length) problems.namePattern = 'validation.invalid';
    if (Object.keys(problems).length) throw validationFailed(problems);
    return {
      nameNl,
      nameEn,
      descriptionNl: (dto.descriptionNl ?? '').trim(),
      descriptionEn: (dto.descriptionEn ?? '').trim(),
      authorityCode: (dto.authorityCode ?? '').trim(),
      officialUrl,
      subject: dto.subject ?? 'client',
      periodKind: dto.periodKind ?? 'none',
      recipientId,
      followUpDays: dto.followUpDays ?? null,
      warnWhenPending: dto.warnWhenPending ?? false,
      docType,
      folderCode,
      namePattern,
      flatten: dto.flatten ?? false,
    };
  }

  async create(dto: SaveFormDto, user: AuthenticatedUser, locale: AppLocale) {
    const values = await this.clean(dto);
    const code = dto.code || slug(values.nameEn) || slug(values.nameNl);
    if (!code) throw validationFailed({ code: 'validation.invalid' });
    if (await this.prisma.officialForm.findUnique({ where: { code }, select: { id: true } })) throw new ConflictException({ code: 'form_code_taken', message: 'There is a form with this code already.', fields: { code: 'validation.alreadyExists' } });
    const count = await this.prisma.officialForm.count();
    const row = await this.prisma.officialForm.create({ data: { code, ...values, sortOrder: (count + 1) * 10, createdById: user.id } });
    await this.audit.log({ action: 'created', entityType: OFFICIAL_FORM_ENTITY, entityId: row.id, entityLabel: row.nameNl, after: { code, ...values } });
    return this.one(row.id, locale);
  }

  async update(id: string, dto: SaveFormDto, locale: AppLocale) {
    const row = await this.rowOrThrow(id);
    const values = await this.clean(dto);
    const before = Object.fromEntries(Object.keys(values).map(key => [key, (row as unknown as Record<string, unknown>)[key]]));
    const diff = AuditService.changes(before, values);
    if (!Object.keys(diff.after).length) return this.one(id, locale);
    await this.prisma.officialForm.update({ where: { id }, data: values });
    await this.audit.log({ action: 'updated', entityType: OFFICIAL_FORM_ENTITY, entityId: id, entityLabel: values.nameNl, before: diff.before, after: diff.after });
    return this.one(id, locale);
  }

  /** Switches a form off (it stays for what was filled in with it) or on again. */
  async setStatus(id: string, dto: FormStatusDto, user: AuthenticatedUser, locale: AppLocale) {
    const row = await this.rowOrThrow(id);
    if (row.isActive === dto.isActive) return this.one(id, locale);
    await this.prisma.officialForm.update({
      where: { id },
      data: dto.isActive ? { isActive: true, deactivatedAt: null, deactivatedById: null } : { isActive: false, deactivatedAt: new Date(), deactivatedById: user.id },
    });
    await this.audit.log({ action: dto.isActive ? 'activated' : 'deactivated', entityType: OFFICIAL_FORM_ENTITY, entityId: id, entityLabel: row.nameNl, ...(dto.reason?.trim() && { meta: { reason: dto.reason.trim() } }) });
    return this.one(id, locale);
  }

  /* ── Export ───────────────────────────────────────────────────────────────────────────────────────────────────── */

  async exportTable(query: FormExportQuery, locale: AppLocale): Promise<ExportTable> {
    const where = this.where(query);
    this.exports.assertSize(await this.prisma.officialForm.count({ where }));
    const rows = await this.prisma.officialForm.findMany({ where, orderBy: this.orderBy(query.sort, locale), include: withDetails });
    const extras = await this.extras(rows.map(row => row.id));
    const nl = locale === 'nl';
    const subjectName = (subject: string) => (nl ? { client: 'Klant', person: 'Persoon van de klant', worker: 'Werknemer' } : { client: 'Client', person: 'Person of the client', worker: 'Worker' })[subject as 'client'] ?? subject;
    return {
      title: nl ? 'Formulierenbibliotheek' : 'Library of official forms',
      locale,
      columns: [
        { key: 'name', header: nl ? 'Formulier' : 'Form', width: 38 },
        { key: 'code', header: nl ? 'Formuliercode' : 'Form code', width: 14 },
        { key: 'subject', header: nl ? 'Voor' : 'For', width: 18 },
        { key: 'recipient', header: nl ? 'Wordt gestuurd naar' : 'Goes to', width: 34 },
        { key: 'edition', header: nl ? 'Editie' : 'Edition', type: 'number', width: 8 },
        { key: 'mapped', header: nl ? 'Velden gekoppeld' : 'Fields mapped', type: 'number', width: 14 },
        { key: 'used', header: nl ? 'Gebruikt' : 'Used', type: 'number', width: 9 },
        { key: 'pending', header: nl ? 'Openstaand' : 'Pending', type: 'number', width: 11 },
        { key: 'active', header: nl ? 'Actief' : 'Active', type: 'boolean', width: 8 },
      ],
      rows: rows.map(row => {
        const view = this.view(row, extras.get(row.id)!, locale);
        return { name: view.name, code: view.authorityCode, subject: subjectName(view.subject), recipient: view.recipient?.lines.slice(0, 1).join(', ') ?? '', edition: view.current?.version ?? 0, mapped: view.current?.mapped ?? 0, used: view.used, pending: view.pending, active: view.isActive };
      }),
    };
  }
}
