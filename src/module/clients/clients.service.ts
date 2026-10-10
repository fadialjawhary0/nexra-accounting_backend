import { Injectable, Logger, NotFoundException, UnprocessableEntityException, type OnModuleInit } from '@nestjs/common';
import { paged, type ApiResult } from '../../common/api-result.js';
import { isValidDay, parseDay, todayInAmsterdam } from '../../common/dates.js';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import { pageMeta } from '../../common/pagination.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { escapeLike, fold } from '../../common/text.js';
import { Prisma, type Client } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { MAX_EXPORT_ROWS, type ExportColumn, type ExportFormat, type ExportTable } from '../../lib/exports/export.types.js';
import { FilesService } from '../files/files.service.js';
import { canViewField, valuesFor } from '../forms/field-access.js';
import { exportType, exportValue, exportWidth } from '../forms/field-export.js';
import { fieldFilter, fieldOrder, parseSort, searchCondition, type QueryContext } from '../forms/dynamic-query.js';
import { isEmptyValue, isEncryptedField, type FieldDef, type FormDoc } from '../forms/form-doc.js';
import { FormRecordsService } from '../forms/form-records.service.js';
import { FormValidationService } from '../forms/form-validation.service.js';
import { FormsService } from '../forms/forms.service.js';
import { ListsService } from '../lists/lists.service.js';
import { NumberingService } from '../numbering/numbering.service.js';
import { EmployeesService } from '../employees/employees.service.js';
import { PeopleService } from '../people/people.service.js';
import { matrixAllows, type PermissionMatrix } from '../roles/permission-catalog.js';
import { ClientFoldersService } from './client-folders.service.js';
import { ClientQualityService } from './client-quality.service.js';
import { CLIENT_COLUMNS, CLIENT_ENTITY, NUMBER_PATTERN, columnValues, day, displayLabel, personName, splitValues } from './client-record.js';
import type { ClientExportQuery, ClientListQuery, ClientLookupQuery, SaveClientDto, SetClientStatusDto } from './dto/client.dto.js';

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const splitList = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);

const invalid = (fields: Record<string, string>, details?: Record<string, unknown>) =>
  new UnprocessableEntityException({ code: 'validation_failed', message: 'Validation failed', fields, ...(details && { details }) });

/** Columns of the export that are not form fields. */
const BUILT_IN_COLUMNS = ['@people', '@status', '@stoppedOn'];

/** Padded so numbers sort the way people count: 7 < 42 < 146 (and letters after digits). */
const NATURAL_NUMBER = Prisma.raw(`lpad(c."number", 12, '0')`);

/**
 * Clients: the list (search, filters on any field the form builder marks as a filter, sorting, paging, counters), one record,
 * create / update on the dynamic client form, stop / reactivate, the suggested next number, a picker lookup and the export.
 * The columns the logic needs are real columns of `Client`; every other field of the form lives in `Client.data`.
 */
@Injectable()
export class ClientsService implements OnModuleInit {
  private readonly logger = new Logger(ClientsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly forms: FormsService,
    private readonly validation: FormValidationService,
    private readonly records: FormRecordsService,
    private readonly numbering: NumberingService,
    private readonly lists: ListsService,
    private readonly files: FilesService,
    private readonly folders: ClientFoldersService,
    private readonly quality: ClientQualityService,
    private readonly people: PeopleService,
    private readonly employees: EmployeesService,
  ) {}

  onModuleInit(): void {
    this.numbering.registerFloor(CLIENT_ENTITY, () => this.highestNumber());
    // Changing the form (a field becomes searchable, unique …) means the derived data has to be rebuilt.
    this.forms.onPublish(CLIENT_ENTITY, () => this.reindex());
    // A person's name is part of the search text of every client they belong to.
    this.people.onChanged(async personId => {
      const links = await this.prisma.clientPerson.findMany({ where: { personId }, select: { clientId: true } });
      for (const link of links) await this.refreshSearch(link.clientId);
    });
  }

  /* ── Reading ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  async list(query: ClientListQuery, filters: Record<string, string>, user: AuthenticatedUser, locale: AppLocale): Promise<ApiResult> {
    const { doc } = await this.forms.live(CLIENT_ENTITY);
    const plan = this.plan(query, filters, doc, user.matrix, locale);
    const skip = (query.page - 1) * query.pageSize;

    const [ids, totals, stats] = await Promise.all([
      this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT c."id" FROM "Client" c ${plan.join} WHERE ${plan.where} ORDER BY ${plan.order} LIMIT ${query.pageSize} OFFSET ${skip}`),
      this.prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`SELECT count(*) AS "count" FROM "Client" c WHERE ${plan.where}`),
      query.stats ? this.stats() : undefined,
    ]);
    const total = Number(totals[0]?.count ?? 0);

    const rows = await this.prisma.client.findMany({ where: { id: { in: ids.map(row => row.id) } } });
    const position = new Map(ids.map((row, index) => [row.id, index]));
    rows.sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));

    const [people, userNames] = await Promise.all([this.peopleOf(rows.map(row => row.id)), this.userNames(rows.flatMap(row => (row.responsibleUserId ? [row.responsibleUserId] : [])))]);
    const secret = this.records.encryptedKeys(doc);
    const data = rows.map(row => {
      const values = valuesFor(doc, this.values(row), user.matrix);
      for (const key of secret) delete values[key];
      return {
        id: row.id,
        number: row.number,
        name: row.name,
        isActive: row.isActive,
        stoppedOn: day(row.stoppedOn),
        values,
        people: people.get(row.id) ?? [],
        updatedAt: row.updatedAt.toISOString(),
      };
    });
    return paged(data, pageMeta(total, query, { users: Object.fromEntries(userNames), ...(stats && { stats }) }));
  }

  async get(id: string, user: AuthenticatedUser, { audit = true } = {}) {
    const row = await this.findOrThrow(id);
    const { doc } = await this.forms.live(CLIENT_ENTITY);
    const values = valuesFor(doc, this.values(row), user.matrix);
    const secret = [...this.records.encryptedKeys(doc)].filter(key => !isEmptyValue(values[key]));
    // Restricted values (the form builder's "sensitive" switch) reach the screen decrypted: each time that happens it is logged.
    if (audit && secret.length) await this.audit.log({ action: 'revealed', entityType: 'client', entityId: row.id, entityLabel: displayLabel(row), meta: { fields: secret } });
    // Only people who may open workers are told how many there are.
    const mayOpenWorkers = matrixAllows(user.matrix, 'employees.view');
    const [people, relations, employees, activeEmployees, documents, userNames] = await Promise.all([
      this.prisma.clientPerson.count({ where: { clientId: id } }),
      this.prisma.clientRelation.count({ where: { OR: [{ fromId: id }, { toId: id }] } }),
      mayOpenWorkers ? this.prisma.employee.count({ where: { clientId: id } }) : Promise.resolve(null),
      mayOpenWorkers ? this.prisma.employee.count({ where: { clientId: id, isActive: true } }) : Promise.resolve(null),
      this.folders.countFiles(id),
      this.userNames(row.responsibleUserId ? [row.responsibleUserId] : []),
    ]);
    return {
      id: row.id,
      number: row.number,
      name: row.name,
      isActive: row.isActive,
      stoppedOn: day(row.stoppedOn),
      deactivationReason: row.deactivationReason,
      deactivatedAt: row.deactivatedAt?.toISOString() ?? null,
      responsibleUser: row.responsibleUserId ? { id: row.responsibleUserId, name: userNames.get(row.responsibleUserId) ?? '' } : null,
      values,
      counts: { people, relations, employees, activeEmployees, documents },
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** The number a new client gets by default. */
  nextNumber() {
    return this.numbering.peek(CLIENT_ENTITY);
  }

  /** A short list for pickers (relations, and later employees and contracts): the best matches plus the ids already chosen. */
  async lookup(query: ClientLookupQuery) {
    const search = fold(query.search ?? '');
    const where: Prisma.ClientWhereInput = search ? { OR: [{ number: { startsWith: search.toUpperCase() } }, { searchText: { contains: search } }] } : {};
    const [matches, chosen] = await Promise.all([
      this.prisma.client.findMany({ where, select: { id: true, number: true, name: true, isActive: true }, orderBy: [{ isActive: 'desc' }, { number: 'asc' }], take: query.limit }),
      query.ids?.length ? this.prisma.client.findMany({ where: { id: { in: query.ids } }, select: { id: true, number: true, name: true, isActive: true } }) : [],
    ]);
    const seen = new Set<string>();
    return [...chosen, ...matches].filter(client => !seen.has(client.id) && seen.add(client.id));
  }

  /* ── Saving ───────────────────────────────────────────────────────────────────────────────────────────────────── */

  async create(input: SaveClientDto, user: AuthenticatedUser) {
    const { doc } = await this.forms.live(CLIENT_ENTITY);
    const patch = { ...input.values };
    // The number: what was typed (in the sequence's format) or the next free one.
    const typed = typeof patch.number === 'string' ? patch.number.trim() : '';
    patch.number = typed ? await this.numbering.normalize(CLIENT_ENTITY, typed) : (await this.numbering.peek(CLIENT_ENTITY)).formatted;

    const { values, errors } = await this.validation.check(CLIENT_ENTITY, patch, {}, user.matrix);
    if (typeof values.number === 'string' && !NUMBER_PATTERN.test(values.number)) errors.number = 'clients.numberInvalid';
    const unique = await this.records.checkUnique(CLIENT_ENTITY, null, doc, values, {});
    await this.failIfInvalid({ ...errors, ...unique.errors }, unique.conflicts);

    const { columns, data } = splitValues(CLIENT_COLUMNS, values);
    const searchText = await this.records.searchText(doc, values, [String(values.number), String(values.name)]);
    const row = await this.prisma
      .$transaction(async tx => {
        const created = await tx.client.create({
          data: {
            number: String(values.number),
            name: String(values.name),
            legalForm: columns.legalForm ?? null,
            kvk: columns.kvk ?? null,
            vatNumber: columns.vatNumber ?? null,
            responsibleUserId: columns.responsibleUserId ?? null,
            // A field left empty is simply not stored (a form sends `null` for every empty field).
            data: FormRecordsService.merge({}, this.records.encode(doc, data)) as Prisma.InputJsonObject,
            searchText,
            createdById: user.id,
          },
        });
        await this.records.claim(tx, CLIENT_ENTITY, created.id, doc, values);
        await this.folders.createFor(tx, created);
        return created;
      })
      .catch((error: unknown) => this.translateConflict(error));

    await this.files.link(this.fileIds(doc, values), CLIENT_ENTITY, row.id);
    await this.audit.log({ action: 'created', entityType: 'client', entityId: row.id, entityLabel: displayLabel(row), after: this.records.auditSnapshot(doc, values) });
    return this.get(row.id, user, { audit: false });
  }

  /** Saves what was sent; fields that were left out keep their value (so hidden fields and fields this person may not see survive). */
  async update(id: string, input: SaveClientDto, user: AuthenticatedUser) {
    const row = await this.findOrThrow(id);
    const { doc } = await this.forms.live(CLIENT_ENTITY);
    const existing = this.values(row);
    const patch = { ...input.values };
    if (typeof patch.number === 'string' && patch.number.trim()) patch.number = await this.numbering.normalize(CLIENT_ENTITY, patch.number);

    const { values, errors } = await this.validation.check(CLIENT_ENTITY, patch, existing, user.matrix);
    if (typeof values.number === 'string' && !NUMBER_PATTERN.test(values.number)) errors.number = 'clients.numberInvalid';
    const unique = await this.records.checkUnique(CLIENT_ENTITY, id, doc, values, existing);
    await this.failIfInvalid({ ...errors, ...unique.errors }, unique.conflicts);

    const keys = Object.keys(values);
    const diff = this.records.auditChange(doc, Object.fromEntries(keys.map(key => [key, existing[key] ?? null])), Object.fromEntries(keys.map(key => [key, values[key] ?? null])));
    if (!Object.keys(diff.after).length) return this.get(id, user, { audit: false });

    const { columns, data } = splitValues(CLIENT_COLUMNS, values);
    const nextValues = { ...existing };
    for (const [key, value] of Object.entries(values)) {
      if (value === null) delete nextValues[key];
      else nextValues[key] = value;
    }
    const people = await this.peopleNames(id);
    const searchText = await this.records.searchText(doc, nextValues, [String(nextValues.number ?? row.number), String(nextValues.name ?? row.name), ...people]);
    const stored = FormRecordsService.merge(asRecord(row.data), this.records.encode(doc, data));

    const updated = await this.prisma
      .$transaction(async tx => {
        const saved = await tx.client.update({
          where: { id },
          data: {
            ...(typeof values.number === 'string' && { number: values.number }),
            ...(typeof values.name === 'string' && { name: values.name }),
            ...('legalForm' in columns && { legalForm: columns.legalForm }),
            ...('kvk' in columns && { kvk: columns.kvk }),
            ...('vatNumber' in columns && { vatNumber: columns.vatNumber }),
            ...('responsibleUserId' in columns && { responsibleUserId: columns.responsibleUserId }),
            data: stored as Prisma.InputJsonObject,
            searchText,
          },
        });
        await this.records.claim(tx, CLIENT_ENTITY, id, doc, nextValues);
        if (saved.number !== row.number || saved.name !== row.name) await this.folders.renameRoot(tx, saved);
        return saved;
      })
      .catch((error: unknown) => this.translateConflict(error));

    await this.files.link(this.fileIds(doc, values), CLIENT_ENTITY, id);
    await this.audit.log({ action: 'updated', entityType: 'client', entityId: id, entityLabel: displayLabel(updated), before: diff.before, after: diff.after });
    return this.get(id, user, { audit: false });
  }

  /** Stops a client (with the day and a reason) or takes a stopped client back. Nothing is deleted. */
  async setStatus(id: string, dto: SetClientStatusDto, user: AuthenticatedUser) {
    const row = await this.findOrThrow(id);
    const stopping = dto.status === 'stopped';
    if (dto.date !== undefined && !isValidDay(dto.date)) throw invalid({ date: 'validation.invalidDate' });
    if (stopping === !row.isActive) return this.get(id, user, { audit: false });

    const reason = dto.reason?.trim() ?? '';
    const stoppedOn = stopping ? (dto.date ?? todayInAmsterdam()) : null;
    const updated = await this.prisma.client.update({
      where: { id },
      data: stopping
        ? { isActive: false, stoppedOn: parseDay(stoppedOn!), deactivatedAt: new Date(), deactivatedById: user.id, deactivationReason: reason }
        : { isActive: true, stoppedOn: null, deactivatedAt: null, deactivatedById: null, deactivationReason: '' },
    });
    await this.audit.log({
      action: stopping ? 'deactivated' : 'activated',
      entityType: 'client',
      entityId: id,
      entityLabel: displayLabel(updated),
      meta: stopping ? { stoppedOn, ...(reason && { reason }) } : { previousStoppedOn: day(row.stoppedOn), ...(row.deactivationReason && { previousReason: row.deactivationReason }) },
    });
    // The client's workers leave with it, when the person stopping the client asked for that (and may stop workers).
    if (stopping && dto.stopWorkers && matrixAllows(user.matrix, 'employees.delete')) await this.employees.stopAllOf(id, stoppedOn!, reason, user);
    return this.get(id, user, { audit: false });
  }

  /* ── Export ───────────────────────────────────────────────────────────────────────────────────────────────────── */

  /** The list (same search, filters and sorting; every page) as a table: every field the form marks "export" that this person may see. */
  async exportTable(query: ClientExportQuery, filters: Record<string, string>, user: AuthenticatedUser, locale: AppLocale, format: ExportFormat): Promise<{ table: ExportTable; count: number }> {
    const { doc } = await this.forms.live(CLIENT_ENTITY);
    const plan = this.plan(query, filters, doc, user.matrix, locale);
    const ids = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT c."id" FROM "Client" c ${plan.join} WHERE ${plan.where} ORDER BY ${plan.order} LIMIT ${MAX_EXPORT_ROWS + 1}`);
    const rows = await this.prisma.client.findMany({ where: { id: { in: ids.map(row => row.id) } } });
    const position = new Map(ids.map((row, index) => [row.id, index]));
    rows.sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));

    const nl = locale === 'nl';
    const exportable = doc.fields
      .filter(field => field.active && !isEncryptedField(field) && canViewField(field, user.matrix))
      .sort((a, b) => this.sectionOrder(doc, a) - this.sectionOrder(doc, b) || a.order - b.order);
    const asked = splitList(query.columns);
    const byKey = new Map(exportable.map(field => [field.key, field]));
    // The grid's own columns when it says which; otherwise Excel gets every "export" field and a page (PDF, Word) the "list" fields.
    const fields = asked.length ? asked.flatMap(key => (byKey.has(key) ? [byKey.get(key)!] : [])) : exportable.filter(field => (format === 'xlsx' ? field.flags.export : field.flags.list));
    const builtins = asked.length ? asked.filter(key => BUILT_IN_COLUMNS.includes(key)) : format === 'xlsx' ? BUILT_IN_COLUMNS : ['@people', '@status'];
    const listKeys = [...new Set(fields.filter(field => (field.type === 'select' || field.type === 'multiselect') && field.list).map(field => field.list as string))];
    const [lookups, people, userNames] = await Promise.all([
      this.lists.lookups([...listKeys, 'client_status', 'person_role'], locale),
      this.peopleOf(rows.map(row => row.id)),
      this.userNames(rows.flatMap(row => (row.responsibleUserId ? [row.responsibleUserId] : []))),
    ]);
    const names = (key: string) => new Map((lookups[key]?.items ?? []).map(item => [item.code, item.name]));
    const named = new Map(listKeys.map(key => [key, names(key)]));
    const statusNames = names('client_status');

    const builtIn: Record<string, ExportColumn> = {
      '@people': { key: '@people', header: nl ? 'Personen' : 'People', width: 30 },
      '@status': { key: '@status', header: 'Status', width: 12 },
      '@stoppedOn': { key: '@stoppedOn', header: nl ? 'Gestopt op' : 'Stopped on', type: 'date' },
    };
    const columns: ExportColumn[] = [
      ...fields.map(field => ({ key: field.key, header: field.labels[locale] || field.labels.nl, type: exportType(field), width: exportWidth(field) })),
      ...builtins.flatMap(key => (builtIn[key] ? [builtIn[key]] : [])),
    ];
    const roleNames = names('person_role');
    const table: ExportTable = {
      title: nl ? 'Klanten' : 'Clients',
      subtitle: this.describeFilters(query, filters, doc, locale, statusNames) || undefined,
      locale,
      columns,
      rows: rows.slice(0, MAX_EXPORT_ROWS).map(row => {
        const values = this.values(row);
        const cells: Record<string, unknown> = {};
        for (const field of fields) cells[field.key] = exportValue(field, values[field.key], named, userNames, locale);
        cells['@people'] = (people.get(row.id) ?? []).map(person => `${person.name} (${roleNames.get(person.role) ?? person.role})`).join('; ');
        cells['@status'] = statusNames.get(row.isActive ? 'active' : 'stopped') ?? (row.isActive ? 'active' : 'stopped');
        cells['@stoppedOn'] = day(row.stoppedOn);
        return cells;
      }),
    };
    return { table, count: rows.length };
  }

  /* ── Derived data ─────────────────────────────────────────────────────────────────────────────────────────────── */

  /** Rebuilds the search text and the unique values of every client (after the form changed). */
  async reindex(): Promise<void> {
    const { doc } = await this.forms.live(CLIENT_ENTITY);
    const rows = await this.prisma.client.findMany();
    const peopleByClient = new Map<string, string[]>();
    const links = await this.prisma.clientPerson.findMany({ select: { clientId: true, person: { select: { firstName: true, lastName: true, data: true } } } });
    for (const link of links) peopleByClient.set(link.clientId, [...(peopleByClient.get(link.clientId) ?? []), personName(link.person)]);

    const claims: Array<{ entity: string; fieldKey: string; value: string; recordId: string }> = [];
    for (const row of rows) {
      const values = this.values(row);
      const searchText = await this.records.searchText(doc, values, [row.number, row.name, ...(peopleByClient.get(row.id) ?? [])]);
      if (searchText !== row.searchText) await this.prisma.client.update({ where: { id: row.id }, data: { searchText } });
      claims.push(...(await this.records.uniqueClaims(CLIENT_ENTITY, row.id, doc, values)));
    }
    await this.prisma.$transaction([this.prisma.uniqueFieldValue.deleteMany({ where: { entity: CLIENT_ENTITY } }), this.prisma.uniqueFieldValue.createMany({ data: claims, skipDuplicates: true })]);
    this.logger.log(`Reindexed ${rows.length} clients.`);
  }

  /** The client's search text again, after its people changed. */
  async refreshSearch(clientId: string): Promise<void> {
    const row = await this.prisma.client.findUnique({ where: { id: clientId } });
    if (!row) return;
    const { doc } = await this.forms.live(CLIENT_ENTITY);
    const searchText = await this.records.searchText(doc, this.values(row), [row.number, row.name, ...(await this.peopleNames(clientId))]);
    if (searchText !== row.searchText) await this.prisma.client.update({ where: { id: clientId }, data: { searchText } });
  }

  /* ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  /** The record as form values: its columns and its decrypted `data`. */
  values(row: Client): Record<string, unknown> {
    return { ...this.records.decode(asRecord(row.data)), ...columnValues(CLIENT_COLUMNS, row) };
  }

  async findOrThrow(id: string): Promise<Client> {
    const row = await this.prisma.client.findUnique({ where: { id } });
    if (!row) throw new NotFoundException({ code: 'not_found', message: 'Client not found' });
    return row;
  }

  /** WHERE / JOIN / ORDER BY of a list or export request. */
  private plan(query: ClientListQuery, filters: Record<string, string>, doc: FormDoc, matrix: PermissionMatrix, locale: AppLocale) {
    const context: QueryContext = { alias: 'c', columns: CLIENT_COLUMNS, locale };
    const usable = (field: FieldDef) => field.active && !isEncryptedField(field) && canViewField(field, matrix);
    const conditions: Prisma.Sql[] = [];

    const statuses = splitList(query.status).filter(status => status === 'active' || status === 'stopped');
    if (statuses.length === 1) conditions.push(Prisma.sql`c."isActive" = ${statuses[0] === 'active'}`);
    const search = searchCondition(context, query.search);
    if (search) conditions.push(search);
    const filterable = new Map(doc.fields.filter(field => field.flags.filter && usable(field)).map(field => [field.key, field]));
    for (const [key, raw] of Object.entries(filters)) {
      const field = filterable.get(key);
      const condition = field ? fieldFilter(context, field, raw) : null;
      if (condition) conditions.push(condition);
    }

    let join: Prisma.Sql = Prisma.empty;
    let order: Prisma.Sql = Prisma.sql`${NATURAL_NUMBER} ASC`;
    const sort = parseSort(query.sort);
    const dir = sort?.dir === 'desc' ? Prisma.raw('DESC') : Prisma.raw('ASC');
    if (sort) {
      if (sort.key === 'number') order = Prisma.sql`${NATURAL_NUMBER} ${dir}`;
      else if (sort.key === 'status') order = Prisma.sql`c."isActive" ${dir}, ${NATURAL_NUMBER} ASC`;
      else if (sort.key === 'updatedAt') order = Prisma.sql`c."updatedAt" ${dir}, ${NATURAL_NUMBER} ASC`;
      else if (sort.key === 'createdAt') order = Prisma.sql`c."createdAt" ${dir}, ${NATURAL_NUMBER} ASC`;
      else {
        const field = doc.fields.find(candidate => candidate.key === sort.key && usable(candidate));
        const planned = field ? fieldOrder(context, field, sort.dir) : null;
        if (planned) {
          join = planned.join;
          order = Prisma.sql`${planned.order}, ${NATURAL_NUMBER} ASC`;
        }
      }
    } else if (query.search?.trim()) {
      // A search puts the exact number first, then numbers and names that start with what was typed.
      const term = fold(query.search);
      const like = escapeLike(term);
      const digits = /^\d+$/.test(term) ? term.replace(/^0+/, '') : null;
      order = Prisma.sql`
        CASE WHEN ${digits !== null ? Prisma.sql`ltrim(c."number", '0') = ${digits}` : Prisma.sql`lower(c."number") = ${term}`} THEN 0
             WHEN lower(c."number") LIKE ${`${like}%`} THEN 1
             WHEN lower(unaccent(c."name")) LIKE ${`${like}%`} THEN 2
             ELSE 3 END, ${NATURAL_NUMBER} ASC`;
    }

    return { where: conditions.length ? Prisma.join(conditions, ' AND ') : Prisma.sql`TRUE`, join, order };
  }

  private async stats() {
    const [groups, incomplete] = await Promise.all([this.prisma.client.groupBy({ by: ['isActive'], _count: { _all: true } }), this.quality.incompleteCount()]);
    const active = groups.find(group => group.isActive)?._count._all ?? 0;
    const stopped = groups.find(group => !group.isActive)?._count._all ?? 0;
    return { total: active + stopped, active, stopped, incomplete };
  }

  private async highestNumber(): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ highest: number | null }>>`SELECT MAX((regexp_match("number", '([0-9]{1,9})$'))[1]::bigint)::int AS "highest" FROM "Client"`;
    return rows[0]?.highest ?? 0;
  }

  /** Current people of the given clients: their names and roles (for the list and the export). */
  private async peopleOf(clientIds: string[]): Promise<Map<string, Array<{ id: string; name: string; role: string }>>> {
    const links = clientIds.length
      ? await this.prisma.clientPerson.findMany({ where: { clientId: { in: clientIds }, endedOn: null }, include: { person: { select: { id: true, firstName: true, lastName: true, data: true } } }, orderBy: { createdAt: 'asc' } })
      : [];
    const byClient = new Map<string, Array<{ id: string; name: string; role: string }>>();
    for (const link of links) byClient.set(link.clientId, [...(byClient.get(link.clientId) ?? []), { id: link.person.id, name: personName(link.person), role: link.role }]);
    return byClient;
  }

  private async peopleNames(clientId: string): Promise<string[]> {
    const links = await this.prisma.clientPerson.findMany({ where: { clientId }, select: { person: { select: { firstName: true, lastName: true, data: true } } } });
    return links.map(link => personName(link.person));
  }

  private async userNames(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map();
    const users = await this.prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
    return new Map(users.map(user => [user.id, user.name]));
  }

  private fileIds(doc: FormDoc, values: Record<string, unknown>): string[] {
    return doc.fields
      .filter(field => field.type === 'file')
      .map(field => (values[field.key] as { id?: unknown } | null | undefined)?.id)
      .filter((id): id is string => typeof id === 'string');
  }

  private sectionOrder(doc: FormDoc, field: FieldDef): number {
    return doc.sections.find(section => section.key === field.section)?.order ?? 0;
  }

  /** A 422 with the fields that are wrong; when a "unique" value is taken, it names the client who holds it. */
  private async failIfInvalid(fields: Record<string, string>, conflicts: Record<string, string>): Promise<void> {
    if (!Object.keys(fields).length) return;
    const ids = [...new Set(Object.values(conflicts))];
    const holders = ids.length ? await this.prisma.client.findMany({ where: { id: { in: ids } }, select: { id: true, number: true, name: true } }) : [];
    const labels = new Map(holders.map(holder => [holder.id, displayLabel(holder)]));
    throw invalid(fields, Object.keys(conflicts).length ? { conflicts: Object.fromEntries(Object.entries(conflicts).map(([key, id]) => [key, { id, label: labels.get(id) ?? '' }])) } : undefined);
  }

  /** Two people saving the same number at once: the database says no — answer like any other validation error. */
  private translateConflict(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw invalid({ number: 'validation.alreadyExists' });
    throw error;
  }

  private describeFilters(query: ClientListQuery, filters: Record<string, string>, doc: FormDoc, locale: AppLocale, statusNames: Map<string, string>): string {
    const nl = locale === 'nl';
    const parts: string[] = [];
    if (query.search?.trim()) parts.push(`${nl ? 'Zoekterm' : 'Search'}: ${query.search.trim()}`);
    const statuses = splitList(query.status);
    if (statuses.length === 1) parts.push(`Status: ${statusNames.get(statuses[0]!) ?? statuses[0]}`);
    for (const [key, raw] of Object.entries(filters)) {
      const field = doc.fields.find(candidate => candidate.key === key);
      if (field) parts.push(`${field.labels[locale] || field.labels.nl}: ${raw.split(',').join(', ')}`);
    }
    return parts.join(' · ');
  }
}
