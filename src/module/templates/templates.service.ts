import { Injectable, NotFoundException } from '@nestjs/common';
import { paged, type ApiResult } from '../../common/api-result.js';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import { pageMeta } from '../../common/pagination.js';
import { fold } from '../../common/text.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { validationFailed } from '../../common/validation/failure.js';
import { Prisma, type Template, type TemplateVersion } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { DocumentsService, type TemplateTag } from '../../lib/documents/documents.service.js';
import { FilesService } from '../files/files.service.js';
import { ListsService } from '../lists/lists.service.js';
import { INVOICE_KIND, MergeFieldsService, STATEMENT_KIND } from './merge-fields.service.js';
import type { AddTemplateVersionDto, CreateTemplateDto, SetTemplateStatusDto, TemplateListQuery, TemplateLookupQuery, UpdateTemplateDto } from './dto/template.dto.js';

export const TEMPLATE_KINDS_LIST = 'template_kind';
const LATEST = { versions: { orderBy: { version: 'desc' }, take: 1 }, client: { select: { id: true, number: true, name: true, isActive: true } } } as const satisfies Prisma.TemplateInclude;
type TemplateRow = Template & { versions: TemplateVersion[]; client: { id: string; number: string; name: string; isActive: boolean } | null };

/** The merge fields of a file that the system does not know (a typo, or a field that was removed from a form). Fields inside a repeated block cannot be checked. */
const unknownTags = (tags: TemplateTag[], known: Set<string>): string[] => [...new Set(tags.filter(entry => entry.kind !== 'close' && entry.depth === 0 && !known.has(entry.tag)).map(entry => entry.tag))];

/** The distinct merge fields (blocks included), in the order they first appear. */
const distinct = (tags: TemplateTag[]): string[] => [...new Set(tags.filter(entry => entry.kind !== 'close').map(entry => entry.tag))];

/**
 * Word templates for contracts and letters. A template is a name, a kind (contract, termination letter …), the language it is written in and a
 * list of versions, each one a Word file with merge fields (`{employee.first_name}`). A new Word file is a new version: contracts made earlier keep
 * the version they were made from. Templates are never deleted — they are switched off.
 */
@Injectable()
export class TemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly files: FilesService,
    private readonly documents: DocumentsService,
    private readonly lists: ListsService,
    private readonly merge: MergeFieldsService,
  ) {}

  /* ── Reading ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  async list(query: TemplateListQuery): Promise<ApiResult> {
    const status = query.status ?? 'active';
    const search = fold(query.search ?? '');
    const where: Prisma.TemplateWhereInput = {
      ...(status !== 'all' && { isActive: status === 'active' }),
      ...(query.kind && { kind: query.kind }),
      ...(query.contractType && { contractType: query.contractType }),
      ...(query.scope && { scope: query.scope }),
      ...(query.clientId && { clientId: query.clientId }),
      ...(query.language && { language: query.language }),
      ...(search && { OR: [{ name: { contains: search, mode: 'insensitive' } }, { description: { contains: search, mode: 'insensitive' } }] }),
    };
    const [total, rows, counts, known] = await Promise.all([
      this.prisma.template.count({ where }),
      this.prisma.template.findMany({ where, include: LATEST, orderBy: [{ kind: 'asc' }, { name: 'asc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.prisma.template.groupBy({ by: ['isActive'], _count: { _all: true } }),
      this.knownByKind(),
    ]);
    const uses = await this.uses(rows.map(row => row.id));
    return paged(
      rows.map(row => this.serialize(row, known(row.kind), uses.get(row.id) ?? 0)),
      pageMeta(total, query, { counts: { active: counts.find(group => group.isActive)?._count._all ?? 0, inactive: counts.find(group => !group.isActive)?._count._all ?? 0 } }),
    );
  }

  /** Active templates a person can pick from when making a contract or a letter: the office's and the client's own. */
  async lookup(query: TemplateLookupQuery) {
    const rows = await this.prisma.template.findMany({
      where: {
        isActive: true,
        ...(query.kind && { kind: query.kind }),
        ...(query.contractType && { OR: [{ contractType: query.contractType }, { contractType: null }] }),
        ...(query.language && { language: query.language }),
        OR: query.clientId ? [{ scope: 'office' }, { scope: 'client', clientId: query.clientId }] : [{ scope: 'office' }],
      },
      include: LATEST,
      orderBy: [{ name: 'asc' }],
    });
    // A client's own template comes before the office's.
    return rows
      .filter(row => row.versions.length > 0)
      .sort((a, b) => Number(b.scope === 'client') - Number(a.scope === 'client') || a.name.localeCompare(b.name))
      .map(row => ({ id: row.id, name: row.name, kind: row.kind, scope: row.scope, language: row.language, contractType: row.contractType, version: row.versions[0]!.version, client: row.client }));
  }

  async get(id: string, locale: AppLocale) {
    const row = await this.findOrThrow(id);
    const [versions, known, uses, names] = await Promise.all([
      this.prisma.templateVersion.findMany({ where: { templateId: id }, orderBy: { version: 'desc' } }),
      this.knownByKind(),
      this.uses([id]),
      this.userNames(),
    ]);
    const catalog = await this.merge.catalog(locale, undefined, row.kind);
    return {
      ...this.serialize(row, known(row.kind), uses.get(id) ?? 0),
      createdAt: row.createdAt.toISOString(),
      versions: versions.map(version => {
        const tags = version.tags as unknown as TemplateTag[];
        return {
          id: version.id,
          version: version.version,
          fileId: version.fileId,
          fileName: version.fileName,
          note: version.note,
          createdAt: version.createdAt.toISOString(),
          createdBy: version.createdById ? (names.get(version.createdById) ?? null) : null,
          tags: distinct(tags),
          unknownTags: unknownTags(tags, known(row.kind)),
        };
      }),
      mergeFields: catalog,
    };
  }

  /** The Word file of a version (the latest when `version` is left out) — for the contract that is made from it. */
  async read(templateId: string, version?: number) {
    const row = await this.findOrThrow(templateId);
    const chosen = version ? await this.prisma.templateVersion.findUnique({ where: { templateId_version: { templateId, version } } }) : row.versions[0];
    if (!chosen) throw new NotFoundException({ code: 'not_found', message: 'Template version not found' });
    const { buffer } = await this.files.bytes(chosen.fileId);
    return { template: row, version: chosen, buffer };
  }

  /** Reads an uploaded file before it is saved: the merge fields it uses and the ones the system does not know. */
  async inspect(fileId: string, kind?: string) {
    const file = await this.files.uploaded(fileId, ['template']);
    const { buffer } = await this.files.bytes(file.id);
    const tags = this.documents.inspect(buffer);
    return { fileName: file.name, tags: distinct(tags), unknownTags: unknownTags(tags, (await this.knownByKind())(kind ?? 'contract')) };
  }

  /** The template filled with made-up data, as a PDF (or Word when LibreOffice is not there). */
  async preview(id: string, version: number | undefined, format: 'pdf' | 'docx') {
    const { template, version: chosen, buffer } = await this.read(id, version);
    const data = await this.merge.sample(template.language as 'nl' | 'en', template.kind);
    const rendered = this.documents.render(buffer, data);
    const base = `${template.name} (voorbeeld)`.replace(/[\\/:*?"<>|]+/g, ' ');
    if (format === 'pdf') return { buffer: await this.documents.toPdf(rendered.buffer), name: `${base}.pdf`, mime: 'application/pdf', unknown: rendered.unknown, version: chosen.version };
    return { buffer: rendered.buffer, name: `${base}.docx`, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', unknown: rendered.unknown, version: chosen.version };
  }

  /* ── Saving ───────────────────────────────────────────────────────────────────────────────────────────────────── */

  async create(dto: CreateTemplateDto, user: AuthenticatedUser, locale: AppLocale) {
    const fields = await this.check(dto);
    if (Object.keys(fields).length) throw validationFailed(fields);
    const file = await this.files.uploaded(dto.fileId, ['template']);
    const { buffer } = await this.files.bytes(file.id);
    const tags = this.documents.inspect(buffer);

    const created = await this.prisma.$transaction(async tx => {
      const template = await tx.template.create({
        data: {
          name: dto.name.trim(),
          kind: dto.kind,
          scope: dto.scope ?? 'office',
          clientId: dto.scope === 'client' ? dto.clientId : null,
          language: dto.language ?? 'nl',
          contractType: dto.contractType || null,
          description: dto.description?.trim() ?? '',
          createdById: user.id,
        },
      });
      await tx.templateVersion.create({ data: { templateId: template.id, version: 1, fileId: file.id, fileName: file.name, tags: tags as unknown as Prisma.InputJsonValue, note: dto.note?.trim() ?? '', createdById: user.id } });
      return template;
    });
    await this.files.link([file.id], 'template', created.id);
    await this.audit.log({ action: 'created', entityType: 'template', entityId: created.id, entityLabel: created.name, after: { name: created.name, kind: created.kind, scope: created.scope, language: created.language, contractType: created.contractType } });
    return this.get(created.id, locale);
  }

  async update(id: string, dto: UpdateTemplateDto, locale: AppLocale) {
    const row = await this.findOrThrow(id);
    const merged = {
      name: dto.name ?? row.name,
      kind: dto.kind ?? row.kind,
      scope: dto.scope ?? (row.scope as 'office' | 'client'),
      clientId: dto.clientId !== undefined ? dto.clientId : row.clientId,
      language: dto.language ?? (row.language as 'nl' | 'en'),
      contractType: dto.contractType !== undefined ? dto.contractType : row.contractType,
      description: dto.description ?? row.description,
    };
    const fields = await this.check({ ...merged, clientId: merged.clientId ?? undefined, contractType: merged.contractType ?? undefined, fileId: 'unchanged' }, true);
    if (Object.keys(fields).length) throw validationFailed(fields);

    const data = {
      name: merged.name.trim(),
      kind: merged.kind,
      scope: merged.scope,
      clientId: merged.scope === 'client' ? merged.clientId : null,
      language: merged.language,
      contractType: merged.contractType || null,
      description: merged.description.trim(),
    };
    const diff = AuditService.changes(
      { name: row.name, kind: row.kind, scope: row.scope, clientId: row.clientId, language: row.language, contractType: row.contractType, description: row.description },
      data,
    );
    if (!Object.keys(diff.after).length) return this.get(id, locale);
    await this.prisma.template.update({ where: { id }, data });
    await this.audit.log({ action: 'updated', entityType: 'template', entityId: id, entityLabel: data.name, before: diff.before, after: diff.after });
    return this.get(id, locale);
  }

  /** A new Word file for the template: version 2, 3 … Contracts made before keep the version they were made from. */
  async addVersion(id: string, dto: AddTemplateVersionDto, user: AuthenticatedUser, locale: AppLocale) {
    const row = await this.findOrThrow(id);
    const file = await this.files.uploaded(dto.fileId, ['template']);
    const { buffer } = await this.files.bytes(file.id);
    const tags = this.documents.inspect(buffer);
    const next = (row.versions[0]?.version ?? 0) + 1;
    await this.prisma.$transaction(async tx => {
      await tx.templateVersion.create({ data: { templateId: id, version: next, fileId: file.id, fileName: file.name, tags: tags as unknown as Prisma.InputJsonValue, note: dto.note?.trim() ?? '', createdById: user.id } });
      await tx.template.update({ where: { id }, data: { updatedAt: new Date() } });
    });
    await this.files.link([file.id], 'template', id);
    await this.audit.log({ action: 'updated', entityType: 'template', entityId: id, entityLabel: row.name, meta: { version: next, fileName: file.name } });
    return this.get(id, locale);
  }

  async setStatus(id: string, dto: SetTemplateStatusDto, user: AuthenticatedUser, locale: AppLocale) {
    const row = await this.findOrThrow(id);
    const active = dto.status === 'active';
    if (row.isActive === active) return this.get(id, locale);
    await this.prisma.template.update({ where: { id }, data: active ? { isActive: true, deactivatedAt: null, deactivatedById: null } : { isActive: false, deactivatedAt: new Date(), deactivatedById: user.id } });
    await this.audit.log({ action: active ? 'activated' : 'deactivated', entityType: 'template', entityId: id, entityLabel: row.name });
    return this.get(id, locale);
  }

  /* ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  async findOrThrow(id: string): Promise<TemplateRow> {
    const row = await this.prisma.template.findUnique({ where: { id }, include: LATEST });
    if (!row) throw new NotFoundException({ code: 'not_found', message: 'Template not found' });
    return row;
  }

  private serialize(row: TemplateRow, known: Set<string>, uses: number) {
    const current = row.versions[0] ?? null;
    const tags = current ? (current.tags as unknown as TemplateTag[]) : [];
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      kind: row.kind,
      scope: row.scope,
      client: row.client,
      language: row.language,
      contractType: row.contractType,
      description: row.description,
      isActive: row.isActive,
      version: current?.version ?? 0,
      fileId: current?.fileId ?? null,
      fileName: current?.fileName ?? null,
      fieldCount: distinct(tags).length,
      unknownTags: unknownTags(tags, known),
      uses,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** The merge fields a template of each kind may use: statement templates have the `statement` group, invoice templates the `invoice` and `recipient` groups, all others the `contract` group. */
  private async knownByKind(): Promise<(kind: string) => Set<string>> {
    const [forContracts, forStatements, forInvoices] = await Promise.all([this.merge.knownTags('contract'), this.merge.knownTags(STATEMENT_KIND), this.merge.knownTags(INVOICE_KIND)]);
    return kind => (kind === STATEMENT_KIND ? forStatements : kind === INVOICE_KIND ? forInvoices : forContracts);
  }

  /** How many contracts, salary statements and invoices were made from each template. */
  private async uses(ids: string[]): Promise<Map<string, number>> {
    if (!ids.length) return new Map();
    const [contracts, statements, invoices] = await Promise.all([
      this.prisma.contract.groupBy({ by: ['templateId'], where: { templateId: { in: ids } }, _count: { _all: true } }),
      this.prisma.salaryStatement.groupBy({ by: ['templateId'], where: { templateId: { in: ids } }, _count: { _all: true } }),
      this.prisma.invoice.groupBy({ by: ['templateId'], where: { templateId: { in: ids } }, _count: { _all: true } }),
    ]);
    const counts = new Map<string, number>();
    for (const group of [...contracts, ...statements, ...invoices]) counts.set(group.templateId as string, (counts.get(group.templateId as string) ?? 0) + group._count._all);
    return counts;
  }

  private async userNames(): Promise<Map<string, string>> {
    const users = await this.prisma.user.findMany({ select: { id: true, name: true } });
    return new Map(users.map(user => [user.id, user.name]));
  }

  /** The rules for the details of a template (the file is checked separately). */
  private async check(input: CreateTemplateDto, update = false): Promise<Record<string, string>> {
    const problems: Record<string, string> = {};
    if (!input.name?.trim()) problems.name = 'validation.required';
    const kinds = await this.lists.activeCodes(TEMPLATE_KINDS_LIST);
    if (!kinds.has(input.kind)) problems.kind = 'validation.selectOption';
    const scope = input.scope ?? 'office';
    if (scope === 'client') {
      if (!input.clientId) problems.clientId = 'validation.required';
      else if (!(await this.prisma.client.findUnique({ where: { id: input.clientId }, select: { id: true } }))) problems.clientId = 'validation.invalid';
    }
    if (input.kind === 'contract') {
      if (!input.contractType) problems.contractType = 'validation.required';
    }
    if (input.contractType && !(await this.lists.activeCodes('contract_type')).has(input.contractType)) problems.contractType = 'validation.selectOption';
    if (!update && !input.fileId) problems.fileId = 'validation.required';
    return problems;
  }
}
