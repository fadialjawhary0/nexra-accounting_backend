import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import { fold } from '../../common/text.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { validationFailed } from '../../common/validation/failure.js';
import { Prisma, type ChecklistTemplate, type ChecklistVersion } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import type { ExportTable } from '../../lib/exports/export.types.js';
import { DocumentTypesService } from '../document-settings/document-types.service.js';
import { RequiredDocumentsService } from '../document-settings/required-documents.service.js';
import { itemHelp, itemLabel, readDoc, sanitizeDoc, sectionName, type ChecklistDoc } from './checklist-doc.js';
import type { CreateTemplateDto, SaveVersionDto, UpdateTemplateDto } from './dto/checklist-templates.dto.js';
import { InspectionListsService } from './inspection-lists.service.js';
import { CHECKLIST_ENTITY } from './inspections.constants.js';

type TemplateRow = ChecklistTemplate & { versions: ChecklistVersion[] };

const itemCount = (version: Pick<ChecklistVersion, 'items'>): number => (Array.isArray(version.items) ? version.items.length : 0);
/** The edition inspections are prepared with: the newest published one. */
const currentOf = (versions: readonly ChecklistVersion[]): ChecklistVersion | null => [...versions].filter(version => version.status === 'published').sort((a, b) => b.version - a.version)[0] ?? null;

/**
 * The checklists of inspections (Settings → Inspections): what an inspector asks for, as editable, versioned data. A checklist has editions; the draft is edited, a published edition
 * is never changed — a change is a new edition, and an inspection keeps the one it was prepared with. Nothing about NEN 4400-1 is in the program: the checklist that ships with it
 * is seed data like any other, and the office adds its own for the tax authority or the labour inspectorate.
 */
@Injectable()
export class ChecklistTemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly types: DocumentTypesService,
    private readonly required: RequiredDocumentsService,
    private readonly lists: InspectionListsService,
  ) {}

  /* ── Reading ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  view(row: TemplateRow, locale: AppLocale) {
    const nl = locale === 'nl';
    const current = currentOf(row.versions);
    const draft = row.versions.find(version => version.status === 'draft') ?? null;
    return {
      id: row.id,
      code: row.code,
      name: nl ? row.nameNl : row.nameEn,
      nameNl: row.nameNl,
      nameEn: row.nameEn,
      description: (nl ? row.descriptionNl : row.descriptionEn) || row.descriptionNl || row.descriptionEn,
      descriptionNl: row.descriptionNl,
      descriptionEn: row.descriptionEn,
      inspectionTypes: row.inspectionTypes,
      order: row.sortOrder,
      isActive: row.isActive,
      current: current ? { id: current.id, version: current.version, label: current.label, publishedAt: current.publishedAt?.toISOString() ?? null, items: itemCount(current) } : null,
      draft: draft ? { id: draft.id, version: draft.version, label: draft.label, items: itemCount(draft) } : null,
      versions: row.versions.length,
    };
  }

  async list(locale: AppLocale) {
    const rows = await this.prisma.checklistTemplate.findMany({ orderBy: [{ isActive: 'desc' }, { sortOrder: 'asc' }, { nameNl: 'asc' }], include: { versions: { orderBy: { version: 'desc' } } } });
    return rows.map(row => this.view(row, locale));
  }

  async rowOrThrow(id: string): Promise<TemplateRow> {
    const row = await this.prisma.checklistTemplate.findUnique({ where: { id }, include: { versions: { orderBy: { version: 'desc' } } } });
    if (!row) throw new NotFoundException({ code: 'not_found', message: 'Checklist not found' });
    return row;
  }

  async one(id: string, locale: AppLocale) {
    const row = await this.rowOrThrow(id);
    return {
      ...this.view(row, locale),
      editions: row.versions.map(version => ({
        id: version.id,
        version: version.version,
        label: version.label,
        status: version.status,
        publishedAt: version.publishedAt?.toISOString() ?? null,
        items: itemCount(version),
        note: version.note,
      })),
    };
  }

  /** One edition with its parts and lines. */
  async version(templateId: string, versionId: string, locale: AppLocale) {
    const row = await this.versionOrThrow(templateId, versionId);
    const doc = readDoc(row.sections, row.items);
    return {
      id: row.id,
      templateId: row.templateId,
      version: row.version,
      label: row.label,
      note: row.note,
      status: row.status,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      sections: doc.sections,
      items: doc.items,
      template: { id: row.template.id, code: row.template.code, name: locale === 'nl' ? row.template.nameNl : row.template.nameEn },
    };
  }

  async versionOrThrow(templateId: string, versionId: string): Promise<ChecklistVersion & { template: ChecklistTemplate }> {
    const row = await this.prisma.checklistVersion.findFirst({ where: { id: versionId, templateId }, include: { template: true } });
    if (!row) throw new NotFoundException({ code: 'not_found', message: 'Edition not found' });
    return row;
  }

  /** An edition by its id (an inspection points at one). */
  async versionById(versionId: string): Promise<(ChecklistVersion & { template: ChecklistTemplate }) | null> {
    return this.prisma.checklistVersion.findUnique({ where: { id: versionId }, include: { template: true } });
  }

  /** The checklist an inspection of this kind starts from, with its newest published edition (null = the office has none for it). */
  async forType(typeCode: string): Promise<{ template: ChecklistTemplate; version: ChecklistVersion } | null> {
    const rows = await this.prisma.checklistTemplate.findMany({ where: { isActive: true, inspectionTypes: { has: typeCode } }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }], include: { versions: { where: { status: 'published' }, orderBy: { version: 'desc' }, take: 1 } } });
    for (const row of rows) {
      const version = row.versions[0];
      if (version) return { template: row, version };
    }
    return null;
  }

  /** Every active checklist with its newest published edition (the choices on the form of a new inspection). */
  async choices(locale: AppLocale) {
    const rows = await this.prisma.checklistTemplate.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { nameNl: 'asc' }], include: { versions: { where: { status: 'published' }, orderBy: { version: 'desc' }, take: 1 } } });
    return rows
      .filter(row => row.versions.length > 0)
      .map(row => ({ id: row.id, code: row.code, name: locale === 'nl' ? row.nameNl : row.nameEn, inspectionTypes: row.inspectionTypes, version: { id: row.versions[0]!.id, number: row.versions[0]!.version, label: row.versions[0]!.label, items: itemCount(row.versions[0]!) } }));
  }

  /** The document types and client fields a line may use (the editor's drop-downs). */
  async editorOptions(locale: AppLocale) {
    const [types, fields] = await Promise.all([this.types.all(), this.required.fields('client')]);
    return {
      types: types.filter(type => type.isActive).map(type => ({ code: type.code, name: DocumentTypesService.nameIn(type, locale), scope: type.scope })),
      fields,
    };
  }

  /* ── Checklists ───────────────────────────────────────────────────────────────────────────────────────────────── */

  private async checkedTypes(input: string[] | undefined): Promise<string[]> {
    const wanted = [...new Set((input ?? []).map(code => code.trim()).filter(Boolean))];
    if (!wanted.length) return [];
    const known = await this.prisma.listItem.findMany({ where: { list: { key: 'inspection_type' }, code: { in: wanted } }, select: { code: true } });
    if (known.length !== wanted.length) throw validationFailed({ inspectionTypes: 'validation.invalid' });
    return wanted;
  }

  private async freeCode(base: string): Promise<string> {
    const start = base || 'checklist';
    for (let number = 1; number < 100; number += 1) {
      const candidate = number === 1 ? start : `${start}_${number}`;
      if (!(await this.prisma.checklistTemplate.findUnique({ where: { code: candidate }, select: { id: true } }))) return candidate;
    }
    return `${start}_${Date.now()}`;
  }

  async create(dto: CreateTemplateDto, user: AuthenticatedUser, locale: AppLocale) {
    const nameNl = dto.nameNl.trim();
    const nameEn = dto.nameEn.trim();
    const problems: Record<string, string> = {};
    if (!nameNl) problems.nameNl = 'validation.required';
    if (!nameEn) problems.nameEn = 'validation.required';
    if (dto.code && (await this.prisma.checklistTemplate.findUnique({ where: { code: dto.code }, select: { id: true } }))) problems.code = 'validation.alreadyExists';
    if (Object.keys(problems).length) throw validationFailed(problems);
    const inspectionTypes = await this.checkedTypes(dto.inspectionTypes);
    const code = dto.code ?? (await this.freeCode(fold(nameEn).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 36)));
    const last = await this.prisma.checklistTemplate.aggregate({ _max: { sortOrder: true } });
    const row = await this.prisma.checklistTemplate.create({
      data: {
        code,
        nameNl,
        nameEn,
        descriptionNl: dto.descriptionNl?.trim() ?? '',
        descriptionEn: dto.descriptionEn?.trim() ?? '',
        inspectionTypes,
        sortOrder: (last._max.sortOrder ?? 0) + 10,
        createdById: user.id,
        versions: { create: { version: 1, status: 'draft', sections: [], items: [], createdById: user.id } },
      },
      include: { versions: { orderBy: { version: 'desc' } } },
    });
    await this.audit.log({ action: 'created', entityType: CHECKLIST_ENTITY, entityId: row.id, entityLabel: row.nameNl, after: { code: row.code, nameNl: row.nameNl, nameEn: row.nameEn, inspectionTypes } });
    return this.view(row, locale);
  }

  async update(id: string, dto: UpdateTemplateDto, locale: AppLocale) {
    const row = await this.rowOrThrow(id);
    const problems: Record<string, string> = {};
    const nameNl = dto.nameNl === undefined ? row.nameNl : dto.nameNl.trim();
    const nameEn = dto.nameEn === undefined ? row.nameEn : dto.nameEn.trim();
    if (!nameNl) problems.nameNl = 'validation.required';
    if (!nameEn) problems.nameEn = 'validation.required';
    if (Object.keys(problems).length) throw validationFailed(problems);
    const inspectionTypes = dto.inspectionTypes === undefined ? row.inspectionTypes : await this.checkedTypes(dto.inspectionTypes);
    const next = { nameNl, nameEn, descriptionNl: dto.descriptionNl === undefined ? row.descriptionNl : dto.descriptionNl.trim(), descriptionEn: dto.descriptionEn === undefined ? row.descriptionEn : dto.descriptionEn.trim(), inspectionTypes };
    const diff = AuditService.changes({ nameNl: row.nameNl, nameEn: row.nameEn, descriptionNl: row.descriptionNl, descriptionEn: row.descriptionEn, inspectionTypes: row.inspectionTypes }, next);
    if (!Object.keys(diff.after).length) return this.view(row, locale);
    const updated = await this.prisma.checklistTemplate.update({ where: { id }, data: next, include: { versions: { orderBy: { version: 'desc' } } } });
    await this.audit.log({ action: 'updated', entityType: CHECKLIST_ENTITY, entityId: id, entityLabel: updated.nameNl, before: diff.before, after: diff.after });
    return this.view(updated, locale);
  }

  async setActive(id: string, active: boolean, user: AuthenticatedUser, locale: AppLocale) {
    const row = await this.rowOrThrow(id);
    if (row.isActive === active) return this.view(row, locale);
    const updated = await this.prisma.checklistTemplate.update({
      where: { id },
      data: active ? { isActive: true, deactivatedAt: null, deactivatedById: null } : { isActive: false, deactivatedAt: new Date(), deactivatedById: user.id },
      include: { versions: { orderBy: { version: 'desc' } } },
    });
    await this.audit.log({ action: active ? 'activated' : 'deactivated', entityType: CHECKLIST_ENTITY, entityId: id, entityLabel: row.nameNl });
    return this.view(updated, locale);
  }

  /* ── Editions ─────────────────────────────────────────────────────────────────────────────────────────────────── */

  /** A new draft: a copy of the newest published edition (or of the one asked for). Only one draft exists at a time. */
  async newDraft(id: string, fromVersionId: string | undefined, user: AuthenticatedUser, locale: AppLocale) {
    const row = await this.rowOrThrow(id);
    if (row.versions.some(version => version.status === 'draft')) throw new ConflictException({ code: 'checklist_draft_exists', message: 'There is a draft already — finish or discard it first.' });
    const source = fromVersionId ? row.versions.find(version => version.id === fromVersionId) : currentOf(row.versions);
    if (fromVersionId && !source) throw validationFailed({ fromVersionId: 'validation.invalid' });
    const number = Math.max(0, ...row.versions.map(version => version.version)) + 1;
    const created = await this.prisma.checklistVersion.create({
      data: {
        templateId: id,
        version: number,
        status: 'draft',
        label: '',
        note: '',
        sections: (source?.sections ?? []) as Prisma.InputJsonValue,
        items: (source?.items ?? []) as Prisma.InputJsonValue,
        createdById: user.id,
      },
    });
    await this.audit.log({ action: 'created', entityType: CHECKLIST_ENTITY, entityId: id, entityLabel: row.nameNl, after: { draft: number, copiedFrom: source?.version ?? null } });
    return this.version(id, created.id, locale);
  }

  /** Saves the draft: the whole document at once. Every problem comes back under the key of the part it is about (`items.3.docTypes`). */
  async saveDraft(id: string, versionId: string, dto: SaveVersionDto, locale: AppLocale) {
    const row = await this.versionOrThrow(id, versionId);
    if (row.status !== 'draft') throw new ConflictException({ code: 'checklist_version_published', message: 'A published edition cannot be changed — make a new draft.' });
    const [types, fields] = await Promise.all([this.types.all(), this.required.fields('client')]);
    const { doc, problems } = sanitizeDoc({ sections: dto.sections ?? row.sections, items: dto.items ?? row.items }, { types: new Set(types.map(type => type.code)), fields: new Set(fields.map(field => field.key)) });
    if (Object.keys(problems).length) throw validationFailed(problems);
    const label = dto.label === undefined ? row.label : dto.label.trim();
    const note = dto.note === undefined ? row.note : dto.note.trim();
    await this.prisma.checklistVersion.update({ where: { id: versionId }, data: { label, note, sections: doc.sections as unknown as Prisma.InputJsonValue, items: doc.items as unknown as Prisma.InputJsonValue } });
    await this.audit.log({ action: 'updated', entityType: CHECKLIST_ENTITY, entityId: id, entityLabel: row.template.nameNl, before: { draft: row.version, items: itemCount(row) }, after: { draft: row.version, items: doc.items.length, label } });
    return this.version(id, versionId, locale);
  }

  /** The draft becomes the edition inspections are prepared with. It needs at least one line, each in a part. */
  async publish(id: string, versionId: string, user: AuthenticatedUser, locale: AppLocale) {
    const row = await this.versionOrThrow(id, versionId);
    if (row.status !== 'draft') throw new ConflictException({ code: 'checklist_version_published', message: 'This edition is published already.' });
    const [types, fields] = await Promise.all([this.types.all(), this.required.fields('client')]);
    const { doc, problems } = sanitizeDoc({ sections: row.sections, items: row.items }, { types: new Set(types.map(type => type.code)), fields: new Set(fields.map(field => field.key)) });
    if (!doc.items.length) problems.items = 'validation.required';
    if (Object.keys(problems).length) throw validationFailed(problems);
    await this.prisma.checklistVersion.update({ where: { id: versionId }, data: { status: 'published', publishedAt: new Date(), publishedById: user.id } });
    await this.audit.log({ action: 'updated', entityType: CHECKLIST_ENTITY, entityId: id, entityLabel: row.template.nameNl, before: { draft: row.version }, after: { published: row.version, label: row.label, items: doc.items.length } });
    return this.version(id, versionId, locale);
  }

  /** Throws a draft away. A published edition stays: inspections point at it. */
  async discard(id: string, versionId: string): Promise<void> {
    const row = await this.versionOrThrow(id, versionId);
    if (row.status !== 'draft') throw new ConflictException({ code: 'checklist_version_published', message: 'A published edition cannot be removed.' });
    await this.prisma.checklistVersion.delete({ where: { id: versionId } });
    await this.audit.log({ action: 'updated', entityType: CHECKLIST_ENTITY, entityId: id, entityLabel: row.template.nameNl, before: { draft: row.version, items: itemCount(row) }, after: { draft: null } });
  }

  /* ── Export ───────────────────────────────────────────────────────────────────────────────────────────────────── */

  /** An edition as a table (Excel, PDF or Word): the list the inspector works from. */
  async exportTable(templateId: string, versionId: string, locale: AppLocale): Promise<ExportTable> {
    const row = await this.versionOrThrow(templateId, versionId);
    const doc: ChecklistDoc = readDoc(row.sections, row.items);
    const [types, periods, cutoffs] = await Promise.all([this.types.codeMap(), this.lists.names('checklist_period_rule', locale), this.lists.names('checklist_cutoff', locale)]);
    const nl = locale === 'nl';
    const sections = new Map(doc.sections.map(section => [section.key, sectionName(section, locale)]));
    const rule = (item: ChecklistDoc['items'][number]): string => {
      const parts = [item.period === 'none' ? '' : (periods.get(item.period) ?? item.period), item.cutoff ? (cutoffs.get(item.cutoff) ?? item.cutoff) : '', item.maxAgeMonths ? (nl ? `Hoogstens ${item.maxAgeMonths} maanden oud` : `At most ${item.maxAgeMonths} months old`) : ''];
      return parts.filter(Boolean).join('; ');
    };
    return {
      title: `${nl ? row.template.nameNl : row.template.nameEn}${row.label ? ` – ${row.label}` : ''}`,
      subtitle: `${nl ? 'Versie' : 'Version'} ${row.version}${row.status === 'draft' ? (nl ? ' (concept)' : ' (draft)') : ''}`,
      locale,
      columns: [
        { key: 'code', header: nl ? 'Nr.' : 'No.', width: 8 },
        { key: 'section', header: nl ? 'Onderdeel' : 'Part', width: 24 },
        { key: 'item', header: nl ? 'Wat de inspecteur vraagt' : 'What the inspector asks for', width: 54 },
        { key: 'types', header: nl ? 'Soort document' : 'Type of document', width: 30 },
        { key: 'rule', header: nl ? 'Periode en leeftijd' : 'Period and age', width: 34 },
        { key: 'onSite', header: nl ? 'Ter inzage' : 'On site', type: 'boolean', width: 10 },
        { key: 'digital', header: nl ? 'Kopie digitaal' : 'Digital copy', type: 'boolean', width: 12 },
        { key: 'help', header: nl ? 'Toelichting' : 'Explanation', width: 40 },
      ],
      rows: doc.items.map(item => ({
        code: item.code,
        section: sections.get(item.section) ?? '',
        item: itemLabel(item, locale),
        types: item.docTypes.map(code => (types.get(code) ? DocumentTypesService.nameIn(types.get(code)!, locale) : code)).join(', '),
        rule: rule(item),
        onSite: item.onSite,
        digital: item.digital,
        help: itemHelp(item, locale),
      })),
    };
  }

}
