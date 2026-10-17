import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ApiResult, paged } from '../../common/api-result.js';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import { formatDay, parseDay } from '../../common/dates.js';
import { pageMeta } from '../../common/pagination.js';
import { fold } from '../../common/text.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { validationFailed } from '../../common/validation/failure.js';
import type { Prisma, StoredFile } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import type { ExportTable } from '../../lib/exports/export.types.js';
import { MAX_EXPORT_ROWS } from '../../lib/exports/export.types.js';
import { ExportsService } from '../../lib/exports/exports.service.js';
import { DocumentTypesService } from '../document-settings/document-types.service.js';
import type { Validity } from '../document-settings/document-validity.js';
import { DOCUMENT_PURPOSES, FILE_TYPES, extensionOf, viewableAreas } from '../files/files.constants.js';
import { FilesService } from '../files/files.service.js';
import { matrixAllows, type PermissionMatrix } from '../roles/permission-catalog.js';
import { personName } from '../people/person-record.js';
import { COMPUTED_LIMIT, LINK_TYPES, type LinkType } from './documents.constants.js';
import { DocumentVersionsService } from './document-versions.service.js';
import { DocumentViewService } from './document-view.service.js';
import type { DocumentListQuery, LinkDto, UpdateDocumentDto } from './dto/documents.dto.js';

const split = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);

/** Sorting the list can do in the database; `client` follows the client's number, `type` the code of the type. */
const SORTS: Record<string, (direction: 'asc' | 'desc') => Prisma.StoredFileOrderByWithRelationInput> = {
  name: direction => ({ name: direction }),
  docDate: direction => ({ docDate: { sort: direction, nulls: 'last' } }),
  createdAt: direction => ({ createdAt: direction }),
  size: direction => ({ size: direction }),
  version: direction => ({ version: direction }),
  type: direction => ({ docType: { sort: direction, nulls: 'last' } }),
  client: direction => ({ client: { number: direction } }),
};

const NOTHING: Prisma.StoredFileWhereInput = { id: '__nothing__' };

/** What a link to another record is shown as. */
export interface LinkView {
  id: string;
  entityType: string;
  entityId: string;
  label: string;
  href: string | null;
}

/**
 * The Documents page: every document of every client and worker in one list — found by name, client number, worker, type or what it says — with the
 * folders of a client, the end of each document's validity, its versions and the records it is linked to. What a person sees of a document is decided
 * by the permission area of the file (`clients`, `employees`, `personal_data`, `contracts`, `invoices`, `salary_statements`), on top of the right to open
 * the page.
 */
@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly files: FilesService,
    private readonly view: DocumentViewService,
    private readonly types: DocumentTypesService,
    private readonly versions: DocumentVersionsService,
    private readonly exports: ExportsService,
  ) {}

  /* ── The list ─────────────────────────────────────────────────────────────────────────────────────────────────── */

  async list(query: DocumentListQuery, user: AuthenticatedUser, locale: AppLocale): Promise<ApiResult> {
    const base = await this.where(query, user.matrix);
    const statuses = split(query.status);
    const terms = fold(query.search ?? '').split(' ').filter(Boolean).slice(0, 5);
    const computedSort = /^validity(:|$)/.test(query.sort ?? '');
    let where = base;
    let total: number;
    let rows: StoredFile[];

    if (statuses.length || computedSort) {
      // The end of validity is worked out (an extract is good for 3 months, an ID follows the person's record), so the database cannot filter on it.
      const known = await this.computedStatuses(base);
      if (statuses.length) where = { AND: [base, this.statusClause(known, statuses)] };
      if (computedSort) {
        const direction = (query.sort ?? '').endsWith(':desc') ? -1 : 1;
        const order = await this.prisma.storedFile.findMany({ where, select: { id: true }, take: COMPUTED_LIMIT });
        const sorted = order.map(row => row.id).sort((a, b) => direction * (compareUntil(known.get(a)) - compareUntil(known.get(b))));
        total = sorted.length;
        const pageIds = sorted.slice((query.page - 1) * query.pageSize, query.page * query.pageSize);
        const found = await this.prisma.storedFile.findMany({ where: { id: { in: pageIds } } });
        rows = pageIds.map(id => found.find(row => row.id === id)).filter((row): row is StoredFile => Boolean(row));
        return this.answer(rows, total, query, base, user, locale, terms);
      }
    }
    [total, rows] = await Promise.all([
      this.prisma.storedFile.count({ where }),
      this.prisma.storedFile.findMany({ where, orderBy: this.orderBy(query.sort), skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    ]);
    return this.answer(rows, total, query, base, user, locale, terms);
  }

  /** The documents whose status is one of `statuses` ("no end date" also takes in every document whose type has none). */
  private statusClause(known: Map<string, Validity>, statuses: string[]): Prisma.StoredFileWhereInput {
    const include = [...known.entries()].filter(([, validity]) => statuses.includes(validity.status)).map(([id]) => id);
    if (!statuses.includes('none')) return { id: { in: include } };
    const dated = [...known.entries()].filter(([, validity]) => validity.status !== 'none').map(([id]) => id);
    return { OR: [{ id: { in: include } }, { id: { notIn: dated } }] };
  }

  private async answer(rows: StoredFile[], total: number, query: DocumentListQuery, base: Prisma.StoredFileWhereInput, user: AuthenticatedUser, locale: AppLocale, terms: string[]) {
    const [data, stats] = await Promise.all([this.view.build(rows, locale, terms), query.stats ? this.stats(base) : undefined]);
    return paged(data, pageMeta(total, query, stats ? { stats } : {}));
  }

  /** The counters above the list: how many documents there are in what is being looked at, how many are about to expire or have expired. */
  private async stats(base: Prisma.StoredFileWhereInput) {
    const [total, known, untyped] = await Promise.all([this.prisma.storedFile.count({ where: base }), this.computedStatuses(base), this.prisma.storedFile.count({ where: { AND: [base, { docType: null }] } })]);
    let expiring = 0;
    let expired = 0;
    for (const validity of known.values()) {
      if (validity.status === 'expiring') expiring += 1;
      else if (validity.status === 'expired') expired += 1;
    }
    return { total, expiring, expired, untyped };
  }

  /** `id → validity` of the documents in `where` whose type has an end date. */
  private async computedStatuses(where: Prisma.StoredFileWhereInput): Promise<Map<string, Validity>> {
    const codes = (await this.types.all()).filter(type => type.validity !== 'none').map(type => type.code);
    if (!codes.length) return new Map();
    const rows = await this.prisma.storedFile.findMany({
      where: { AND: [where, { docType: { in: codes } }] },
      select: { id: true, docType: true, docDate: true, validUntil: true, entityType: true, entityId: true },
      take: COMPUTED_LIMIT,
    });
    return this.view.validities(rows);
  }

  private orderBy(sort: string | undefined): Prisma.StoredFileOrderByWithRelationInput[] {
    const order = split(sort)
      .map(part => part.split(':') as [string, string?])
      .filter(([key]) => key in SORTS)
      .map(([key, direction]) => SORTS[key]!(direction === 'desc' ? 'desc' : 'asc'));
    return [...(order.length ? order : [{ createdAt: 'desc' as const }]), { id: 'asc' }];
  }

  /** What the person may see, narrowed by the filters. */
  async where(query: Partial<DocumentListQuery>, matrix: PermissionMatrix): Promise<Prisma.StoredFileWhereInput> {
    const areas = viewableAreas(matrix);
    if (!areas.length) return NOTHING;
    const state = query.state ?? 'active';
    const and: Prisma.StoredFileWhereInput[] = [];
    if (query.clientId) and.push(await this.ofClient(query.clientId));
    if (query.employeeId) and.push(await this.ofWorker(query.employeeId));
    if (query.folderId) and.push({ folderId: { in: await this.folderIds(query.folderId, query.subfolders !== false) } });
    const types = split(query.type);
    if (types.length) and.push({ docType: { in: types } });
    if (query.untyped) and.push({ docType: null });
    if (query.from) and.push({ docDate: { gte: parseDay(query.from) } });
    if (query.to) and.push({ docDate: { lte: parseDay(query.to) } });
    if (query.scope === 'worker') and.push({ entityType: { in: ['employee', 'person'] } });
    if (query.scope === 'client') and.push({ OR: [{ entityType: null }, { entityType: { notIn: ['employee', 'person'] } }] });
    if (query.linkType && query.linkId) and.push({ links: { some: { entityType: query.linkType, entityId: query.linkId } } });
    if (query.search?.trim()) and.push(...(await this.searchClauses(query.search)));
    return {
      purpose: { in: [...DOCUMENT_PURPOSES] },
      area: { in: areas },
      ...(state !== 'all' && { isActive: state === 'active' }),
      ...(query.versions !== 'all' && { isCurrent: true }),
      ...(and.length && { AND: and }),
    };
  }

  /** The documents of a client: filed on it or in its folders, the copies on the people it works with, and what is linked to it. */
  private async ofClient(clientId: string): Promise<Prisma.StoredFileWhereInput> {
    const [workers, people] = await Promise.all([
      this.prisma.employee.findMany({ where: { clientId }, select: { personId: true } }),
      this.prisma.clientPerson.findMany({ where: { clientId }, select: { personId: true } }),
    ]);
    const personIds = [...new Set([...workers, ...people].map(row => row.personId))];
    return { OR: [{ clientId }, ...(personIds.length ? [{ entityType: 'person', entityId: { in: personIds } }] : []), { links: { some: { entityType: 'client', entityId: clientId } } }] };
  }

  /** The documents of a worker: filed on them or in their folder, the copies on their person's record, and what is linked to them. */
  private async ofWorker(employeeId: string): Promise<Prisma.StoredFileWhereInput> {
    const employee = await this.prisma.employee.findUnique({ where: { id: employeeId }, select: { personId: true } });
    if (!employee) return NOTHING;
    return { OR: [{ entityType: 'employee', entityId: employeeId }, { entityType: 'person', entityId: employee.personId }, { links: { some: { entityType: 'employee', entityId: employeeId } } }] };
  }

  /** A folder and, unless told otherwise, the folders inside it. */
  private async folderIds(folderId: string, subfolders: boolean): Promise<string[]> {
    const folder = await this.prisma.folder.findUnique({ where: { id: folderId }, select: { id: true, clientId: true } });
    if (!folder) return [folderId];
    if (!subfolders) return [folder.id];
    const all = await this.prisma.folder.findMany({ where: { clientId: folder.clientId }, select: { id: true, parentId: true } });
    const found = new Set([folder.id]);
    for (let round = 0; round < 10; round += 1) {
      const before = found.size;
      for (const row of all) if (row.parentId && found.has(row.parentId)) found.add(row.id);
      if (found.size === before) break;
    }
    return [...found];
  }

  /** Every word must be found somewhere: in the file's name, the client's number or name, the worker, the type or the text of the document. */
  private async searchClauses(search: string): Promise<Prisma.StoredFileWhereInput[]> {
    const terms = fold(search).split(' ').filter(Boolean).slice(0, 5);
    const types = await this.types.all();
    const clauses: Prisma.StoredFileWhereInput[] = [];
    for (const term of terms) {
      const codes = types.filter(type => fold(type.nameNl).includes(term) || fold(type.nameEn).includes(term)).map(type => type.code);
      const people = await this.prisma.person.findMany({ where: { searchText: { contains: term } }, select: { id: true }, take: 200 });
      const personIds = people.map(person => person.id);
      const workers = personIds.length ? await this.prisma.employee.findMany({ where: { personId: { in: personIds } }, select: { id: true } }) : [];
      clauses.push({
        OR: [
          { name: { contains: term, mode: 'insensitive' } },
          { client: { is: { OR: [{ number: { contains: term, mode: 'insensitive' } }, { name: { contains: term, mode: 'insensitive' } }] } } },
          { text: { is: { searchText: { contains: term } } } },
          ...(codes.length ? [{ docType: { in: codes } }] : []),
          ...(personIds.length ? [{ entityType: 'person', entityId: { in: personIds } }] : []),
          ...(workers.length ? [{ entityType: 'employee', entityId: { in: workers.map(worker => worker.id) } }] : []),
        ],
      });
    }
    return clauses;
  }

  /* ── One document ─────────────────────────────────────────────────────────────────────────────────────────────── */

  /** The file, for someone who may see it. */
  async readable(id: string, user: AuthenticatedUser): Promise<StoredFile> {
    const file = await this.prisma.storedFile.findUnique({ where: { id } });
    if (!file || !DOCUMENT_PURPOSES.includes(file.purpose)) throw new NotFoundException({ code: 'not_found', message: 'Document not found' });
    if (!file.area || !matrixAllows(user.matrix, `${file.area}.view`)) throw new ForbiddenException({ code: 'forbidden', message: 'You do not have access to this.' });
    return file;
  }

  async one(id: string, user: AuthenticatedUser, locale: AppLocale) {
    const file = await this.readable(id, user);
    const root = file.rootId ?? file.id;
    const [[view], chain, links, text] = await Promise.all([
      this.view.build([file], locale),
      // A removed document still shows itself as a version, so the list is never empty.
      this.prisma.storedFile.findMany({ where: { AND: [DocumentVersionsService.chain(root), { OR: [{ isActive: true }, { id }] }] }, orderBy: { version: 'desc' } }),
      this.prisma.documentLink.findMany({ where: { fileId: id }, orderBy: { createdAt: 'asc' } }),
      this.prisma.documentText.findUnique({ where: { fileId: id }, select: { status: true, pages: true, extractedAt: true } }),
    ]);
    const users = await this.prisma.user.findMany({ where: { id: { in: chain.map(version => version.uploadedById).filter((value): value is string => Boolean(value)) } }, select: { id: true, name: true } });
    const userName = new Map(users.map(person => [person.id, person.name]));
    return {
      ...view!,
      previewable: previewKind(file.name),
      hash: file.sha256,
      versionList: chain.map(version => ({
        id: version.id,
        version: version.version,
        name: version.name,
        size: version.size,
        docDate: version.docDate ? formatDay(version.docDate) : null,
        isCurrent: version.isCurrent,
        active: version.isActive,
        uploadedBy: version.uploadedById ? (userName.get(version.uploadedById) ?? '') : '',
        createdAt: version.createdAt.toISOString(),
      })),
      links: await this.describeLinks(links, user.matrix),
      read: text ? { status: text.status, pages: text.pages, at: text.extractedAt.toISOString() } : null,
    };
  }

  /* ── Changing ─────────────────────────────────────────────────────────────────────────────────────────────────── */

  /** The file for a change: the person may open it and edit its area. */
  private async editable(id: string, user: AuthenticatedUser): Promise<StoredFile> {
    const file = await this.readable(id, user);
    if (!file.isActive) throw new NotFoundException({ code: 'not_found', message: 'Document not found' });
    if (!matrixAllows(user.matrix, `${file.area}.edit`)) throw new ForbiddenException({ code: 'forbidden', message: 'You do not have access to this.' });
    return file;
  }

  async update(id: string, dto: UpdateDocumentDto, user: AuthenticatedUser, locale: AppLocale) {
    const file = await this.editable(id, user);
    const problems: Record<string, string> = {};
    const data: Prisma.StoredFileUncheckedUpdateInput = {};
    if (dto.name !== undefined || dto.folderId !== undefined) {
      await this.files.update(id, { ...(dto.name !== undefined && { name: dto.name }), ...(dto.folderId !== undefined && { folderId: dto.folderId }) }, user);
    }
    if (dto.docType !== undefined) {
      const type = dto.docType ? await this.types.byCode(dto.docType) : null;
      if (dto.docType && (!type || (!type.isActive && type.code !== file.docType))) problems.docType = 'validation.selectOption';
      else {
        data.docType = dto.docType || null;
        // A copy of an ID or a permit is personal data from the moment it is called one; the area is only ever tightened.
        if (type?.personal && file.area !== 'personal_data') {
          if (!matrixAllows(user.matrix, 'personal_data.edit')) throw new ForbiddenException({ code: 'forbidden', message: 'You do not have access to this.' });
          data.area = 'personal_data';
        }
      }
    }
    if (dto.docDate !== undefined) {
      if (dto.docDate && !isDay(dto.docDate)) problems.docDate = 'validation.invalid';
      else data.docDate = dto.docDate ? parseDay(dto.docDate) : null;
    }
    if (dto.validUntil !== undefined) {
      if (dto.validUntil && !isDay(dto.validUntil)) problems.validUntil = 'validation.invalid';
      else data.validUntil = dto.validUntil ? parseDay(dto.validUntil) : null;
    }
    if (dto.periodFrom !== undefined) {
      if (dto.periodFrom && !isDay(dto.periodFrom)) problems.periodFrom = 'validation.invalid';
      else data.periodFrom = dto.periodFrom ? parseDay(dto.periodFrom) : null;
    }
    if (dto.periodTo !== undefined) {
      if (dto.periodTo && !isDay(dto.periodTo)) problems.periodTo = 'validation.invalid';
      else data.periodTo = dto.periodTo ? parseDay(dto.periodTo) : null;
    }
    const from = dto.periodFrom !== undefined ? dto.periodFrom : file.periodFrom ? formatDay(file.periodFrom) : null;
    const to = dto.periodTo !== undefined ? dto.periodTo : file.periodTo ? formatDay(file.periodTo) : null;
    if (from && to && isDay(from) && isDay(to) && to < from && !problems.periodTo) problems.periodTo = 'validation.endBeforeStart';
    if (Object.keys(problems).length) throw validationFailed(problems);
    if (Object.keys(data).length) {
      const updated = await this.prisma.storedFile.update({ where: { id }, data });
      const shape = (row: StoredFile) => ({
        docType: row.docType,
        docDate: row.docDate ? formatDay(row.docDate) : null,
        validUntil: row.validUntil ? formatDay(row.validUntil) : null,
        periodFrom: row.periodFrom ? formatDay(row.periodFrom) : null,
        periodTo: row.periodTo ? formatDay(row.periodTo) : null,
        area: row.area,
      });
      const diff = AuditService.changes(shape(file), shape(updated));
      if (Object.keys(diff.after).length) await this.audit.log({ action: 'updated', entityType: 'file', entityId: id, entityLabel: updated.name, before: diff.before, after: diff.after });
    }
    return this.one(id, user, locale);
  }

  /** Switches the document off (nothing is deleted); an older version takes its place. */
  async remove(id: string, user: AuthenticatedUser) {
    await this.editable(id, user);
    return this.files.deactivate(id, user);
  }

  /** Brings a removed document back (as the current version when there is none). */
  async restore(id: string, user: AuthenticatedUser, locale: AppLocale) {
    const file = await this.readable(id, user);
    if (!matrixAllows(user.matrix, `${file.area}.edit`)) throw new ForbiddenException({ code: 'forbidden', message: 'You do not have access to this.' });
    if (!file.isActive) {
      const root = file.rootId ?? file.id;
      const current = await this.prisma.storedFile.findFirst({ where: { AND: [DocumentVersionsService.chain(root), { isActive: true, isCurrent: true }] }, select: { id: true } });
      await this.prisma.storedFile.update({ where: { id }, data: { isActive: true, deactivatedAt: null, isCurrent: !current } });
      await this.audit.log({ action: 'activated', entityType: 'file', entityId: id, entityLabel: file.name });
    }
    return this.one(id, user, locale);
  }

  /** Makes an older version the current one again. */
  async makeCurrent(id: string, user: AuthenticatedUser, locale: AppLocale) {
    const file = await this.editable(id, user);
    const root = file.rootId ?? file.id;
    await this.prisma.$transaction([
      this.prisma.storedFile.updateMany({ where: { AND: [DocumentVersionsService.chain(root), { NOT: { id } }] }, data: { isCurrent: false } }),
      this.prisma.storedFile.update({ where: { id }, data: { isCurrent: true } }),
    ]);
    await this.audit.log({ action: 'updated', entityType: 'file', entityId: id, entityLabel: file.name, before: { current: false }, after: { current: true, version: file.version } });
    return this.one(id, user, locale);
  }

  /* ── Links ────────────────────────────────────────────────────────────────────────────────────────────────────── */

  async addLink(id: string, dto: LinkDto, user: AuthenticatedUser, locale: AppLocale) {
    const file = await this.editable(id, user);
    const type = dto.entityType as LinkType;
    if (!matrixAllows(user.matrix, `${LINK_TYPES[type].area}.view`)) throw new ForbiddenException({ code: 'forbidden', message: 'You do not have access to this.' });
    if (!(await this.recordExists(type, dto.entityId))) throw validationFailed({ entityId: 'validation.invalid' });
    const existing = await this.prisma.documentLink.findUnique({ where: { fileId_entityType_entityId: { fileId: id, entityType: type, entityId: dto.entityId } } });
    if (existing) throw new ConflictException({ code: 'document_link_exists', message: 'The document is already linked to this.' });
    await this.prisma.documentLink.create({ data: { fileId: id, entityType: type, entityId: dto.entityId, createdById: user.id } });
    await this.audit.log({ action: 'updated', entityType: 'file', entityId: id, entityLabel: file.name, before: {}, after: { linkedTo: `${type}:${dto.entityId}` } });
    return this.one(id, user, locale);
  }

  async removeLink(id: string, linkId: string, user: AuthenticatedUser, locale: AppLocale) {
    const file = await this.editable(id, user);
    const link = await this.prisma.documentLink.findFirst({ where: { id: linkId, fileId: id } });
    if (!link) throw new NotFoundException({ code: 'not_found', message: 'Link not found' });
    await this.prisma.documentLink.delete({ where: { id: linkId } });
    await this.audit.log({ action: 'updated', entityType: 'file', entityId: id, entityLabel: file.name, before: { linkedTo: `${link.entityType}:${link.entityId}` }, after: { linkedTo: null } });
    return this.one(id, user, locale);
  }

  private async recordExists(type: LinkType, id: string): Promise<boolean> {
    switch (type) {
      case 'client':
        return Boolean(await this.prisma.client.findUnique({ where: { id }, select: { id: true } }));
      case 'employee':
        return Boolean(await this.prisma.employee.findUnique({ where: { id }, select: { id: true } }));
      case 'contract':
        return Boolean(await this.prisma.contract.findUnique({ where: { id }, select: { id: true } }));
      case 'invoice':
        return Boolean(await this.prisma.invoice.findUnique({ where: { id }, select: { id: true } }));
      case 'salary_statement':
        return Boolean(await this.prisma.salaryStatement.findUnique({ where: { id }, select: { id: true } }));
    }
  }

  /** The records a document is linked to, named; only the ones the person may open. */
  private async describeLinks(links: Array<{ id: string; entityType: string; entityId: string }>, matrix: PermissionMatrix): Promise<LinkView[]> {
    const allowed = links.filter(link => link.entityType in LINK_TYPES && matrixAllows(matrix, `${LINK_TYPES[link.entityType as LinkType].area}.view`));
    const ids = (type: LinkType) => allowed.filter(link => link.entityType === type).map(link => link.entityId);
    const [clients, workers, contracts, invoices, statements] = await Promise.all([
      this.prisma.client.findMany({ where: { id: { in: ids('client') } }, select: { id: true, number: true, name: true } }),
      this.prisma.employee.findMany({ where: { id: { in: ids('employee') } }, select: { id: true, person: { select: { firstName: true, lastName: true, data: true } } } }),
      this.prisma.contract.findMany({ where: { id: { in: ids('contract') } }, select: { id: true, startDate: true, employee: { select: { person: { select: { firstName: true, lastName: true, data: true } } } } } }),
      this.prisma.invoice.findMany({ where: { id: { in: ids('invoice') } }, select: { id: true, number: true, periodFrom: true, periodTo: true } }),
      this.prisma.salaryStatement.findMany({ where: { id: { in: ids('salary_statement') } }, select: { id: true, periodFrom: true, periodTo: true, employee: { select: { person: { select: { firstName: true, lastName: true, data: true } } } } } }),
    ]);
    const label = new Map<string, { label: string; href: string | null }>();
    for (const client of clients) label.set(`client:${client.id}`, { label: `${client.number} – ${client.name}`, href: `/clients/${client.id}` });
    for (const worker of workers) label.set(`employee:${worker.id}`, { label: personName(worker.person), href: `/employees/${worker.id}` });
    for (const contract of contracts) label.set(`contract:${contract.id}`, { label: `${personName(contract.employee.person)} · ${dutch(contract.startDate)}`, href: `/contracts/${contract.id}` });
    for (const invoice of invoices) label.set(`invoice:${invoice.id}`, { label: `${invoice.number ?? '—'} · ${dutch(invoice.periodFrom)} – ${dutch(invoice.periodTo)}`, href: `/invoices/${invoice.id}` });
    for (const statement of statements) label.set(`salary_statement:${statement.id}`, { label: `${personName(statement.employee.person)} · ${dutch(statement.periodFrom)} – ${dutch(statement.periodTo)}`, href: null });
    return allowed.map(link => ({ id: link.id, entityType: link.entityType, entityId: link.entityId, label: label.get(`${link.entityType}:${link.entityId}`)?.label ?? '—', href: label.get(`${link.entityType}:${link.entityId}`)?.href ?? null }));
  }

  /* ── Folders ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  /** The folders of a client with how many documents each holds (people who may not open workers do not see the workers' folders). */
  async folders(clientId: string, user: AuthenticatedUser) {
    const withWorkers = matrixAllows(user.matrix, 'employees.view');
    const [folders, counts] = await Promise.all([
      this.prisma.folder.findMany({ where: { clientId, isActive: true, ...(!withWorkers && { employeeId: null }) }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
      this.prisma.storedFile.groupBy({ by: ['folderId'], where: { clientId, isActive: true, isCurrent: true, purpose: { in: [...DOCUMENT_PURPOSES] }, area: { in: viewableAreas(user.matrix) }, folderId: { not: null } }, _count: { _all: true } }),
    ]);
    const count = new Map(counts.map(row => [row.folderId, row._count._all]));
    return folders.map(folder => ({ id: folder.id, parentId: folder.parentId, name: folder.name, templateCode: folder.templateCode, employeeId: folder.employeeId, order: folder.sortOrder, documents: count.get(folder.id) ?? 0 }));
  }

  /* ── Export ───────────────────────────────────────────────────────────────────────────────────────────────────── */

  /** The list (same filters and sorting, every page) as a table. */
  async exportTable(query: DocumentListQuery, user: AuthenticatedUser, locale: AppLocale): Promise<ExportTable> {
    const base = await this.where(query, user.matrix);
    const statuses = split(query.status);
    let where = base;
    if (statuses.length) where = { AND: [base, this.statusClause(await this.computedStatuses(base), statuses)] };
    this.exports.assertSize(Math.min(await this.prisma.storedFile.count({ where }), MAX_EXPORT_ROWS + 1));
    const rows = await this.prisma.storedFile.findMany({ where, orderBy: this.orderBy(query.sort), take: MAX_EXPORT_ROWS });
    const views = await this.view.build(rows, locale);
    const nl = locale === 'nl';
    const statusName = (status: string): string =>
      ({ valid: nl ? 'Geldig' : 'Valid', expiring: nl ? 'Verloopt binnenkort' : 'Expiring soon', expired: nl ? 'Verlopen' : 'Expired', none: '' })[status] ?? '';
    return {
      title: nl ? 'Documenten' : 'Documents',
      subtitle: query.search?.trim() ? `${nl ? 'Zoekterm' : 'Search'}: ${query.search.trim()}` : undefined,
      locale,
      columns: [
        { key: 'clientNumber', header: nl ? 'Klantnr.' : 'Client no.', width: 10 },
        { key: 'client', header: nl ? 'Klant' : 'Client', width: 26 },
        { key: 'person', header: nl ? 'Persoon' : 'Person', width: 22 },
        { key: 'type', header: nl ? 'Soort' : 'Type', width: 22 },
        { key: 'name', header: nl ? 'Bestand' : 'File', width: 34 },
        { key: 'docDate', header: nl ? 'Datum' : 'Date', type: 'date', width: 12 },
        { key: 'until', header: nl ? 'Geldig tot' : 'Valid until', type: 'date', width: 12 },
        { key: 'status', header: 'Status', width: 18 },
        { key: 'folder', header: nl ? 'Map' : 'Folder', width: 26 },
        { key: 'version', header: nl ? 'Versie' : 'Version', type: 'number', width: 8 },
        { key: 'size', header: nl ? 'Grootte (kB)' : 'Size (kB)', type: 'number', width: 12 },
        { key: 'createdAt', header: nl ? 'Toegevoegd' : 'Added', type: 'datetime', width: 18 },
      ],
      rows: views.map(item => ({
        clientNumber: item.client?.number ?? '',
        client: item.client?.name ?? '',
        person: item.person?.name ?? '',
        type: item.type?.name ?? '',
        name: item.name,
        docDate: item.docDate,
        until: item.validity.until,
        status: statusName(item.validity.status),
        folder: item.folder?.path ?? '',
        version: item.version,
        size: Math.round(item.size / 1024),
        createdAt: item.createdAt,
      })),
    };
  }
}

/** `2026-03-15` for a date column → `15-03-2026`. */
const dutch = (date: Date): string => {
  const text = formatDay(date);
  return `${text.slice(8, 10)}-${text.slice(5, 7)}-${text.slice(0, 4)}`;
};

const isDay = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(parseDay(value).getTime()) && formatDay(parseDay(value)) === value;

/** Documents without an end date go last, whichever way the list is sorted. */
const compareUntil = (validity: Validity | undefined): number => (validity?.until ? Date.parse(validity.until) : Number.MAX_SAFE_INTEGER);

/** How a file can be shown: a PDF or an image as it is, a Word / Excel file through its PDF, plain text as text; `null` = download only. */
export function previewKind(name: string): 'pdf' | 'image' | 'convert' | 'text' | null {
  const extension = extensionOf(name);
  if (extension === 'pdf') return 'pdf';
  if (FILE_TYPES[extension]?.inline) return 'image';
  if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'rtf'].includes(extension)) return 'convert';
  if (['txt', 'csv'].includes(extension)) return 'text';
  return null;
}
