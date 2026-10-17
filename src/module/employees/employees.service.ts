import { ForbiddenException, Injectable, Logger, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { paged, type ApiResult } from '../../common/api-result.js';
import { asRecord, columnValues, day, splitValues } from '../../common/record-values.js';
import { addDays, formatDay, isValidDay, parseDay, todayInAmsterdam } from '../../common/dates.js';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import { pageMeta } from '../../common/pagination.js';
import { escapeLike, fold } from '../../common/text.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { conflictDetails, validationFailed } from '../../common/validation/failure.js';
import { Prisma, type Employee, type Person } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { SettingsService } from '../../lib/settings/settings.service.js';
import { MAX_EXPORT_ROWS, type ExportColumn, type ExportFormat, type ExportTable } from '../../lib/exports/export.types.js';
import { DOCUMENT_PURPOSES, viewableAreas } from '../files/files.constants.js';
import { canEditField, canViewField, valuesFor } from '../forms/field-access.js';
import { exportType, exportValue, exportWidth } from '../forms/field-export.js';
import { fieldFilter, fieldOrder, parseSort, searchAcross, type QueryContext } from '../forms/dynamic-query.js';
import { isEncryptedField, type FieldDef, type FormDoc } from '../forms/form-doc.js';
import { FormRecordsService } from '../forms/form-records.service.js';
import { FormValidationService } from '../forms/form-validation.service.js';
import { FormsService } from '../forms/forms.service.js';
import { ListsService } from '../lists/lists.service.js';
import { PeopleService, type PersonPlan } from '../people/people.service.js';
import { PERSON_COLUMNS, PERSON_ENTITY, personName } from '../people/person-record.js';
import type { PermissionMatrix } from '../roles/permission-catalog.js';
import { DocumentTypesService } from '../document-settings/document-types.service.js';
import { EmployeeFoldersService } from './employee-folders.service.js';
import { EmployeeRatesService } from './employee-rates.service.js';
import { EMPLOYEE_COLUMNS, EMPLOYEE_DATE_COLUMNS, EMPLOYEE_ENTITY, PERSON_PREFIX, RATE_FIELD, currentRateSql } from './employee-record.js';
import type { CreateEmployeeDto, EmployeeExportQuery, EmployeeListQuery, EmployeeLookupQuery, SetEmployeeStatusDto, UpdateEmployeeDto } from './dto/employee.dto.js';

/** In a page-wide export the name is one column, so the two name fields of the person form are not repeated. */
const NAME_FIELDS: ReadonlySet<string> = new Set([`${PERSON_PREFIX}first_name`, `${PERSON_PREFIX}last_name`]);

const splitList = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);

/** Padded so numbers sort the way people count: 7 < 42 < 146. */
const CLIENT_NUMBER = Prisma.raw(`lpad(c."number", 12, '0')`);
const LAST_NAME = Prisma.raw(`lower(unaccent(p."lastName"))`);
const FIRST_NAME = Prisma.raw(`lower(unaccent(p."firstName"))`);

/** What a module that reacts to a worker leaving is told. */
export interface StopEvent {
  employeeId: string;
  /** The last day of the employment (`YYYY-MM-DD`). */
  endDate: string;
  reason: string;
  user: AuthenticatedUser;
}
export type StopListener = (event: StopEvent) => Promise<void>;

type EmployeeWithPeople = Employee & { person: Person; client: { id: string; number: string; name: string; isActive: boolean } };
const WITH_PEOPLE = { person: true, client: { select: { id: true, number: true, name: true, isActive: true } } } as const;

/**
 * Workers: one person employed by one client. The list covers both forms — the employment (client, function, days in and out of service,
 * hourly rate …) and the person (name, address, ID document …) — with search, filters, sorting, paging and counters. Saving a worker saves
 * both forms together; the person is created (or an existing person is used) in the same transaction, the worker's folder is made, and the
 * hourly rate goes into the rate history. Workers are never deleted: they are stopped.
 */
@Injectable()
export class EmployeesService implements OnModuleInit {
  private readonly logger = new Logger(EmployeesService.name);
  private readonly stopListeners: StopListener[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly forms: FormsService,
    private readonly validation: FormValidationService,
    private readonly records: FormRecordsService,
    private readonly lists: ListsService,
    private readonly people: PeopleService,
    private readonly rates: EmployeeRatesService,
    private readonly folders: EmployeeFoldersService,
    private readonly settings: SettingsService,
    private readonly types: DocumentTypesService,
  ) {}

  /** Other modules that must react when a worker leaves (Contracts ends the worker's open contracts) register here. */
  onStopped(listener: StopListener): void {
    this.stopListeners.push(listener);
  }

  onModuleInit(): void {
    this.forms.onPublish(EMPLOYEE_ENTITY, () => this.reindex());
    // The worker's folder follows the person's name.
    this.people.onChanged(async personId => {
      const employees = await this.prisma.employee.findMany({ where: { personId }, include: { person: true } });
      for (const employee of employees) await this.prisma.$transaction(tx => this.folders.rename(tx, employee, personName(employee.person)));
    });
  }

  /* ── Reading ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  async list(query: EmployeeListQuery, filters: Record<string, string>, user: AuthenticatedUser, locale: AppLocale): Promise<ApiResult> {
    const docs = await this.docs();
    const expiryFields = await this.types.fieldKeys();
    const plan = this.plan(query, filters, docs, user.matrix, locale, expiryFields);
    const skip = (query.page - 1) * query.pageSize;

    const [ids, totals, stats] = await Promise.all([
      this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT e."id" ${plan.from} ${plan.join} WHERE ${plan.where} ORDER BY ${plan.order} LIMIT ${query.pageSize} OFFSET ${skip}`),
      this.prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`SELECT count(*) AS "count" ${plan.from} WHERE ${plan.where}`),
      query.stats ? this.stats(user, docs, expiryFields) : undefined,
    ]);
    const total = Number(totals[0]?.count ?? 0);
    const rows = await this.inOrder(ids.map(row => row.id));
    const [rates, userNames] = await Promise.all([this.rates.currentRates(rows.map(row => row.id)), this.userNames(rows, docs)]);

    const data = rows.map(row => {
      const view = this.view(row, rates.get(row.id) ?? null, docs, user.matrix);
      return {
        id: row.id,
        isActive: row.isActive,
        startDate: day(row.startDate),
        endDate: day(row.endDate),
        client: row.client,
        person: { id: row.person.id, name: personName(row.person), values: view.person.values },
        values: view.values,
        updatedAt: row.updatedAt.toISOString(),
      };
    });
    return paged(data, pageMeta(total, query, { users: Object.fromEntries(userNames), ...(stats && { stats }) }));
  }

  async get(id: string, user: AuthenticatedUser) {
    const row = await this.findOrThrow(id);
    const docs = await this.docs();
    const rate = this.mayDo(docs.employee, 'view', user.matrix) ? await this.rates.current(id) : null;
    const view = this.view(row, rate, docs, user.matrix);
    const [folder, belongs, documents, contracts] = await Promise.all([this.folders.describe(id), this.people.belongsTo(row.personId), this.countDocuments(id, row.personId, user.matrix), this.countContracts(id)]);
    return {
      id: row.id,
      isActive: row.isActive,
      startDate: day(row.startDate),
      endDate: day(row.endDate),
      deactivationReason: row.deactivationReason,
      deactivatedAt: row.deactivatedAt?.toISOString() ?? null,
      client: row.client,
      person: { ...this.people.serialize(row.person, docs.person, user.matrix, false), clients: belongs.clients, employments: belongs.employments.filter(entry => entry.id !== id) },
      values: view.values,
      rate,
      folder,
      counts: { documents, contracts },
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** The hourly rate is a field of the employee form: whoever may not see (or change) it there may not see (or change) its history either. */
  async assertRateAccess(user: AuthenticatedUser, action: 'view' | 'edit'): Promise<void> {
    const { doc } = await this.forms.live(EMPLOYEE_ENTITY);
    if (!this.mayDo(doc, action, user.matrix)) throw new ForbiddenException({ code: 'forbidden', message: 'You do not have access to this.' });
  }


  /** A short list for pickers (contracts, hours …): workers matching a name, optionally of one client. */
  async lookup(query: EmployeeLookupQuery) {
    const search = fold(query.search ?? '');
    const rows = await this.prisma.employee.findMany({
      where: {
        ...(query.clientId && { clientId: query.clientId }),
        ...(query.includeStopped !== 'true' && { isActive: true }),
        ...(search && { OR: [{ person: { searchText: { contains: search } } }, { client: { searchText: { contains: search } } }] }),
      },
      include: WITH_PEOPLE,
      orderBy: [{ person: { lastName: 'asc' } }, { person: { firstName: 'asc' } }],
      take: query.limit,
    });
    return rows.map(row => ({ id: row.id, name: personName(row.person), isActive: row.isActive, client: row.client }));
  }

  /* ── Saving ───────────────────────────────────────────────────────────────────────────────────────────────────── */

  async create(input: CreateEmployeeDto, user: AuthenticatedUser) {
    const docs = await this.docs();
    const { values, errors } = await this.validation.check(EMPLOYEE_ENTITY, input.values ?? {}, {}, user.matrix);
    const unique = await this.records.checkUnique(EMPLOYEE_ENTITY, null, docs.employee, values, {});
    const problems: Record<string, string> = { ...errors, ...unique.errors };
    await this.checkDays(values, {}, problems);
    await this.checkClient(values.client, problems);

    // The person: somebody who is already known, or the person form for a new one.
    let existing: Person | null = null;
    let plan: PersonPlan | null = null;
    if (input.person?.personId) {
      existing = await this.people.findOrThrow(input.person.personId);
      // The same person cannot work for the same client twice at once (a worker who came back is taken back instead).
      const employed = typeof values.client === 'string' ? await this.prisma.employee.count({ where: { personId: existing.id, clientId: values.client, isActive: true } }) : 0;
      if (employed) problems.client = 'employees.alreadyEmployed';
    } else if (input.person?.values) plan = await this.people.planCreate(input.person.values, user);
    else problems.person = 'validation.required';
    if (plan) this.mergePersonProblems(problems, plan);
    this.failIfInvalid(problems, plan?.conflicts);

    const { columns, data } = splitValues(EMPLOYEE_COLUMNS, values);
    const { [RATE_FIELD]: rate, ...rest } = data;
    const searchText = await this.records.searchText(docs.employee, values, []);
    // The first hourly rate applies from the first day of work (when that is in the past), so hours already worked are priced too.
    const today = todayInAmsterdam();
    const rateFrom = typeof columns.startDate === 'string' && columns.startDate < today ? columns.startDate : today;
    const created = await this.prisma.$transaction(async tx => {
      const saved = plan ? await plan.commit(tx) : { person: existing as Person, after: async () => undefined };
      const row = await tx.employee.create({
        data: {
          personId: saved.person.id,
          clientId: String(columns.clientId),
          functionCode: columns.functionCode ?? null,
          startDate: columns.startDate ? parseDay(columns.startDate) : null,
          endDate: columns.endDate ? parseDay(columns.endDate) : null,
          // A field left empty is simply not stored (a form sends `null` for every empty field).
          data: FormRecordsService.merge({}, this.records.encode(docs.employee, rest)) as Prisma.InputJsonObject,
          searchText,
          createdById: user.id,
        },
      });
      await this.records.claim(tx, EMPLOYEE_ENTITY, row.id, docs.employee, values);
      if (typeof rate === 'number') await this.rates.setFrom(tx, row.id, rate, rateFrom, user.id);
      await this.folders.createFor(tx, row, personName(saved.person));
      return { row, person: saved.person, after: saved.after };
    });
    await created.after();

    const snapshot: Record<string, unknown> = { ...this.records.auditSnapshot(docs.employee, values), person: personName(created.person) };
    await this.nameClients(docs.employee, snapshot);
    await this.audit.log({ action: 'created', entityType: 'employee', entityId: created.row.id, entityLabel: await this.label(created.row.id), after: snapshot });
    return this.get(created.row.id, user);
  }

  /** Saves what was sent: the employment and / or the person's own details. Fields that were left out keep their value. */
  async update(id: string, input: UpdateEmployeeDto, user: AuthenticatedUser) {
    const row = await this.findOrThrow(id);
    const docs = await this.docs();
    const currentRate = await this.rates.current(id);
    const existing = this.values(row, currentRate);

    const { values, errors } = await this.validation.check(EMPLOYEE_ENTITY, input.values ?? {}, existing, user.matrix);
    const unique = await this.records.checkUnique(EMPLOYEE_ENTITY, id, docs.employee, values, existing);
    const problems: Record<string, string> = { ...errors, ...unique.errors };
    await this.checkDays(values, existing, problems);
    if (typeof values.client === 'string' && values.client !== row.clientId) await this.checkClient(values.client, problems);

    const plan = input.person?.values ? await this.people.planUpdate(row.personId, input.person.values, user) : null;
    if (plan) this.mergePersonProblems(problems, plan);
    this.failIfInvalid(problems, plan?.conflicts);

    const keys = Object.keys(values);
    const diff = this.records.auditChange(docs.employee, Object.fromEntries(keys.map(key => [key, existing[key] ?? null])), Object.fromEntries(keys.map(key => [key, values[key] ?? null])));
    // An empty rate field never removes a rate (that is done in the rate history); a rate that equals today's is no change.
    const rate = typeof values[RATE_FIELD] === 'number' && values[RATE_FIELD] !== currentRate ? (values[RATE_FIELD] as number) : null;
    if (typeof values[RATE_FIELD] !== 'number' || values[RATE_FIELD] === currentRate) {
      delete diff.before[RATE_FIELD];
      delete diff.after[RATE_FIELD];
    }
    const employmentChanged = Object.keys(diff.after).length > 0;
    if (!employmentChanged && (!plan || plan.unchanged)) return this.get(id, user);

    const { columns, data } = splitValues(EMPLOYEE_COLUMNS, values);
    // The hourly rate lives in the rate history, not in the worker's own data.
    const rest = { ...data };
    delete rest[RATE_FIELD];
    const nextValues = { ...existing };
    for (const [key, value] of Object.entries(values)) {
      if (value === null) delete nextValues[key];
      else nextValues[key] = value;
    }
    const searchText = await this.records.searchText(docs.employee, nextValues, []);
    const stored = FormRecordsService.merge(asRecord(row.data), this.records.encode(docs.employee, rest));
    const changedClient = typeof columns.clientId === 'string' && columns.clientId !== row.clientId;

    const saved = await this.prisma.$transaction(async tx => {
      const person = plan ? await plan.commit(tx) : null;
      const updated = await tx.employee.update({
        where: { id },
        data: {
          ...(typeof columns.clientId === 'string' && { clientId: columns.clientId }),
          ...('functionCode' in columns && { functionCode: columns.functionCode ?? null }),
          ...('startDate' in columns && { startDate: columns.startDate ? parseDay(columns.startDate) : null }),
          ...('endDate' in columns && { endDate: columns.endDate ? parseDay(columns.endDate) : null }),
          data: stored as Prisma.InputJsonObject,
          searchText,
        },
      });
      await this.records.claim(tx, EMPLOYEE_ENTITY, id, docs.employee, nextValues);
      if (rate !== null) await this.rates.setFrom(tx, id, rate, todayInAmsterdam(), user.id);
      if (changedClient) await this.folders.moveToClient(tx, updated, !updated.isActive);
      return { updated, after: person?.after };
    });
    await saved.after?.();

    if (employmentChanged) {
      await this.nameClients(docs.employee, diff.before, diff.after);
      await this.audit.log({ action: 'updated', entityType: 'employee', entityId: id, entityLabel: await this.label(id), before: diff.before, after: diff.after });
    }
    return this.get(id, user);
  }

  /** Stops a worker (with the last day and a reason) or takes a stopped worker back. Nothing is deleted; the folder moves to `0-GESTOPT` and back. */
  async setStatus(id: string, dto: SetEmployeeStatusDto, user: AuthenticatedUser) {
    const row = await this.findOrThrow(id);
    const stopping = dto.status === 'stopped';
    if (dto.date !== undefined && !isValidDay(dto.date)) throw validationFailed({ date: 'validation.invalidDate' });
    if (stopping === !row.isActive) return this.get(id, user);

    const reason = dto.reason?.trim() ?? '';
    const endDate = stopping ? (dto.date ?? todayInAmsterdam()) : null;
    // The last day cannot be before the first day; a worker cannot come back to a client that has stopped.
    if (endDate && row.startDate && endDate < formatDay(row.startDate)) throw validationFailed({ date: 'validation.endBeforeStart' });
    if (!stopping && !row.client.isActive) throw validationFailed({ status: 'employees.clientStopped' });
    await this.prisma.$transaction(async tx => {
      await tx.employee.update({
        where: { id },
        data: stopping
          ? { isActive: false, endDate: parseDay(endDate!), deactivatedAt: new Date(), deactivatedById: user.id, deactivationReason: reason }
          : { isActive: true, endDate: null, deactivatedAt: null, deactivatedById: null, deactivationReason: '' },
      });
      await this.folders.moveForStatus(tx, row, stopping);
    });
    await this.audit.log({
      action: stopping ? 'deactivated' : 'activated',
      entityType: 'employee',
      entityId: id,
      entityLabel: await this.label(id),
      meta: stopping ? { endDate, ...(reason && { reason }) } : { previousEndDate: day(row.endDate), ...(row.deactivationReason && { previousReason: row.deactivationReason }) },
    });
    if (stopping) for (const listener of this.stopListeners) await listener({ employeeId: id, endDate: endDate!, reason, user });
    return this.get(id, user);
  }

  /** A client stopped: its active workers leave with it (their last day is the client's last day, or their first day when that is later). */
  async stopAllOf(clientId: string, lastDay: string, reason: string, user: AuthenticatedUser): Promise<void> {
    const active = await this.prisma.employee.findMany({ where: { clientId, isActive: true }, select: { id: true, startDate: true } });
    for (const worker of active) {
      const start = worker.startDate ? formatDay(worker.startDate) : null;
      await this.setStatus(worker.id, { status: 'stopped', date: start && start > lastDay ? start : lastDay, reason }, user);
    }
  }

  /* ── Export ───────────────────────────────────────────────────────────────────────────────────────────────────── */

  /** The list (same search, filters and sorting; every page) as a table: the columns the person sees, from both forms. */
  async exportTable(query: EmployeeExportQuery, filters: Record<string, string>, user: AuthenticatedUser, locale: AppLocale, format: ExportFormat): Promise<{ table: ExportTable; count: number }> {
    const docs = await this.docs();
    const plan = this.plan(query, filters, docs, user.matrix, locale, await this.types.fieldKeys());
    const ids = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT e."id" ${plan.from} ${plan.join} WHERE ${plan.where} ORDER BY ${plan.order} LIMIT ${MAX_EXPORT_ROWS + 1}`);
    const rows = await this.inOrder(ids.map(row => row.id));
    const rates = await this.rates.currentRates(rows.map(row => row.id));

    const nl = locale === 'nl';
    const available = (doc: FormDoc, prefix: string) =>
      doc.fields
        // Client references are exported through the client columns (number and name), not as an id; restricted values never are.
        .filter(field => field.active && !isEncryptedField(field) && canViewField(field, user.matrix) && field.type !== 'client')
        .sort((a, b) => (doc.sections.find(s => s.key === a.section)?.order ?? 0) - (doc.sections.find(s => s.key === b.section)?.order ?? 0) || a.order - b.order)
        .map(field => ({ id: `${prefix}${field.key}`, field, personal: prefix !== '' }));
    const all = [...available(docs.employee, ''), ...available(docs.person, PERSON_PREFIX)];
    const byId = new Map(all.map(entry => [entry.id, entry]));

    const builtIn: Record<string, ExportColumn> = {
      '@name': { key: '@name', header: nl ? 'Naam' : 'Name', width: 26 },
      '@client': { key: '@client', header: nl ? 'Klant' : 'Client', width: 30 },
      '@clientNumber': { key: '@clientNumber', header: nl ? 'Klantnummer' : 'Client number', width: 14 },
      '@clientName': { key: '@clientName', header: nl ? 'Klantnaam' : 'Client name', width: 28 },
      '@status': { key: '@status', header: 'Status', width: 12 },
    };
    // The grid's own columns when it says which (in its order); otherwise Excel gets the client and every "export" field, and a page
    // (PDF, Word) the name, the client and the "list" fields (the name is one column there, so the two name fields are left out).
    const asked = splitList(query.columns);
    const defaults =
      format === 'xlsx'
        ? ['@clientNumber', '@clientName', ...all.filter(entry => entry.field.flags.export).map(entry => entry.id), '@status']
        : ['@name', '@client', ...all.filter(entry => entry.field.flags.list && !NAME_FIELDS.has(entry.id)).map(entry => entry.id), '@status'];
    const order = [...new Set(asked.length ? asked : defaults)].filter(key => key in builtIn || byId.has(key));
    const chosen = order.flatMap(key => (byId.has(key) ? [byId.get(key)!] : []));

    const listKeys = [...new Set(chosen.filter(entry => (entry.field.type === 'select' || entry.field.type === 'multiselect') && entry.field.list).map(entry => entry.field.list as string))];
    const [lookups, userNames] = await Promise.all([this.lists.lookups([...listKeys, 'employee_status'], locale), this.userNames(rows, docs)]);
    const names = (key: string) => new Map((lookups[key]?.items ?? []).map(item => [item.code, item.name]));
    const named = new Map(listKeys.map(key => [key, names(key)]));
    const statusNames = names('employee_status');

    const columns: ExportColumn[] = order.map(key => {
      const entry = byId.get(key);
      return entry ? { key, header: entry.field.labels[locale] || entry.field.labels.nl, type: exportType(entry.field), width: exportWidth(entry.field) } : builtIn[key]!;
    });
    const table: ExportTable = {
      title: nl ? 'Werknemers' : 'Employees',
      subtitle: this.describeFilters(query, filters, docs, locale, statusNames) || undefined,
      locale,
      columns,
      rows: rows.slice(0, MAX_EXPORT_ROWS).map(row => {
        const rate = rates.get(row.id) ?? null;
        const employeeValues: Record<string, unknown> = { ...this.records.publicValues(asRecord(row.data)), ...columnValues(EMPLOYEE_COLUMNS, row), ...(rate !== null && { [RATE_FIELD]: rate }) };
        const personValues: Record<string, unknown> = { ...this.records.publicValues(asRecord(row.person.data)), ...columnValues(PERSON_COLUMNS, row.person) };
        const cells: Record<string, unknown> = {
          '@name': personName(row.person),
          '@client': `${row.client.number} – ${row.client.name}`,
          '@clientNumber': row.client.number,
          '@clientName': row.client.name,
          '@status': statusNames.get(row.isActive ? 'active' : 'stopped') ?? (row.isActive ? 'active' : 'stopped'),
        };
        for (const entry of chosen) cells[entry.id] = exportValue(entry.field, (entry.personal ? personValues : employeeValues)[entry.field.key], named, userNames, locale);
        return cells;
      }),
    };
    return { table, count: rows.length };
  }

  /* ── Derived data ─────────────────────────────────────────────────────────────────────────────────────────────── */

  /** Rebuilds the search text and the unique values of every worker (after the employee form changed). */
  async reindex(): Promise<void> {
    const { doc } = await this.forms.live(EMPLOYEE_ENTITY);
    const employees = await this.prisma.employee.findMany();
    const rates = await this.rates.currentRates(employees.map(entry => entry.id));
    const claims: Array<{ entity: string; fieldKey: string; value: string; recordId: string }> = [];
    for (const row of employees) {
      const values = this.values(row, rates.get(row.id) ?? null);
      const searchText = await this.records.searchText(doc, values, []);
      if (searchText !== row.searchText) await this.prisma.employee.update({ where: { id: row.id }, data: { searchText } });
      claims.push(...this.records.uniqueClaims(EMPLOYEE_ENTITY, row.id, doc, values));
    }
    await this.prisma.$transaction([this.prisma.uniqueFieldValue.deleteMany({ where: { entity: EMPLOYEE_ENTITY } }), this.prisma.uniqueFieldValue.createMany({ data: claims, skipDuplicates: true })]);
    this.logger.log(`Reindexed ${employees.length} employees.`);
  }

  /* ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  private async docs() {
    const [employee, person] = await Promise.all([this.forms.live(EMPLOYEE_ENTITY), this.forms.live(PERSON_ENTITY)]);
    return { employee: employee.doc, person: person.doc };
  }

  /** The employment as form values: the columns, the decrypted `data` and today's hourly rate. */
  values(row: Employee, rate: number | null): Record<string, unknown> {
    return { ...this.records.decode(asRecord(row.data)), ...columnValues(EMPLOYEE_COLUMNS, row), ...(rate !== null && { [RATE_FIELD]: rate }) };
  }

  /** What this user may see of a worker: employment values and person values, without the restricted ones (those are only on the person's own record). */
  private view(row: EmployeeWithPeople, rate: number | null, docs: { employee: FormDoc; person: FormDoc }, matrix: PermissionMatrix) {
    const values = valuesFor(docs.employee, { ...this.records.publicValues(asRecord(row.data)), ...columnValues(EMPLOYEE_COLUMNS, row), ...(rate !== null && { [RATE_FIELD]: rate }) }, matrix);
    const personValues = valuesFor(docs.person, { ...this.records.publicValues(asRecord(row.person.data)), ...columnValues(PERSON_COLUMNS, row.person) }, matrix);
    return { values, person: { values: personValues } };
  }

  private mayDo(doc: FormDoc, action: 'view' | 'edit', matrix: PermissionMatrix): boolean {
    const field = doc.fields.find(candidate => candidate.key === RATE_FIELD);
    return Boolean(field?.active && (action === 'view' ? canViewField(field, matrix) : canEditField(field, matrix)));
  }

  async findOrThrow(id: string): Promise<EmployeeWithPeople> {
    const row = await this.prisma.employee.findUnique({ where: { id }, include: WITH_PEOPLE });
    if (!row) throw new NotFoundException({ code: 'not_found', message: 'Employee not found' });
    return row;
  }

  private async inOrder(ids: string[]): Promise<EmployeeWithPeople[]> {
    const rows = await this.prisma.employee.findMany({ where: { id: { in: ids } }, include: WITH_PEOPLE });
    const position = new Map(ids.map((id, index) => [id, index]));
    return rows.sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));
  }

  /** The names of the staff members that the list's "user" fields (of either form) point at. */
  private async userNames(rows: EmployeeWithPeople[], docs: { employee: FormDoc; person: FormDoc }): Promise<Map<string, string>> {
    const userKeys = (doc: FormDoc) => doc.fields.filter(field => field.type === 'user').map(field => field.key);
    const employeeKeys = userKeys(docs.employee);
    const personKeys = userKeys(docs.person);
    const found = new Set<string>();
    for (const row of rows) {
      const own = asRecord(row.data);
      const person = asRecord(row.person.data);
      for (const key of employeeKeys) if (typeof own[key] === 'string') found.add(own[key]);
      for (const key of personKeys) if (typeof person[key] === 'string') found.add(person[key]);
    }
    const ids = [...found];
    if (!ids.length) return new Map();
    const users = await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    return new Map(users.map(entry => [entry.id, entry.name]));
  }

  private async label(id: string): Promise<string> {
    const row = await this.findOrThrow(id);
    return `${personName(row.person)} (${row.client.number})`;
  }

  /** Audit entries name a client by its number and name instead of its id (changes the snapshots it is given). */
  private async nameClients(doc: FormDoc, ...snapshots: Array<Record<string, unknown>>): Promise<void> {
    const keys = doc.fields.filter(field => field.type === 'client').map(field => field.key);
    const ids = new Set<string>();
    for (const snapshot of snapshots) for (const key of keys) if (typeof snapshot[key] === 'string') ids.add(snapshot[key]);
    if (!ids.size) return;
    const clients = await this.prisma.client.findMany({ where: { id: { in: [...ids] } }, select: { id: true, number: true, name: true } });
    const labels = new Map(clients.map(client => [client.id, `${client.number} – ${client.name}`]));
    for (const snapshot of snapshots) {
      for (const key of keys) {
        const value = snapshot[key];
        if (typeof value === 'string') snapshot[key] = labels.get(value) ?? value;
      }
    }
  }

  /** The worker's contracts that are still open (draft, sent or running). */
  private countContracts(id: string): Promise<number> {
    return this.prisma.contract.count({ where: { employeeId: id, status: { in: ['draft', 'sent', 'active'] } } });
  }

  /** The worker's documents the person may open (the number on the worker's Documents tab): filed on the worker, and the copies on the person's record. */
  private countDocuments(id: string, personId: string, matrix: PermissionMatrix): Promise<number> {
    return this.prisma.storedFile.count({
      where: {
        isActive: true,
        isCurrent: true,
        purpose: { in: [...DOCUMENT_PURPOSES] },
        area: { in: viewableAreas(matrix) },
        OR: [{ entityType: 'employee', entityId: id }, { entityType: 'person', entityId: personId }],
      },
    });
  }

  /** The last day cannot be before the first day. */
  private async checkDays(values: Record<string, unknown>, existing: Record<string, unknown>, problems: Record<string, string>): Promise<void> {
    const start = (values.start_date !== undefined ? values.start_date : existing.start_date) as string | null | undefined;
    const end = (values.end_date !== undefined ? values.end_date : existing.end_date) as string | null | undefined;
    if (typeof start === 'string' && typeof end === 'string' && end < start && !problems.end_date) problems.end_date = 'validation.endBeforeStart';
  }

  /** A worker can only be added to a client that is still with the office. */
  private async checkClient(clientId: unknown, problems: Record<string, string>): Promise<void> {
    if (typeof clientId !== 'string' || problems.client) return;
    const client = await this.prisma.client.findUnique({ where: { id: clientId }, select: { isActive: true } });
    if (client && !client.isActive) problems.client = 'employees.clientStopped';
  }

  /** The person form's problems arrive on the same screen as the employee form's: their keys get a `person.` prefix. */
  private mergePersonProblems(problems: Record<string, string>, plan: PersonPlan): void {
    for (const [key, message] of Object.entries(plan.errors)) problems[`${PERSON_PREFIX}${key}`] = message;
  }

  /** 422 with every problem of both forms; a person value that is taken (a BSN) names the person who holds it, so the screen can offer to use them. */
  private failIfInvalid(problems: Record<string, string>, personConflicts?: PersonPlan['conflicts']): void {
    if (!Object.keys(problems).length) return;
    const conflicts: Record<string, { id: string; label: string }> = {};
    for (const [key, holder] of Object.entries(personConflicts ?? {})) conflicts[`${PERSON_PREFIX}${key}`] = holder;
    throw validationFailed(problems, conflictDetails(conflicts));
  }

  /* ── Queries ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  /** FROM / JOIN / WHERE / ORDER BY of a list or export request. */
  private plan(query: EmployeeListQuery, filters: Record<string, string>, docs: { employee: FormDoc; person: FormDoc }, matrix: PermissionMatrix, locale: AppLocale, expiryFields: string[]) {
    const employeeContext: QueryContext = { alias: 'e', columns: EMPLOYEE_COLUMNS, locale, dateColumns: EMPLOYEE_DATE_COLUMNS, expressions: { [RATE_FIELD]: currentRateSql('e') } };
    const personContext: QueryContext = { alias: 'p', columns: PERSON_COLUMNS, locale };
    const usable = (field: FieldDef) => field.active && !isEncryptedField(field) && canViewField(field, matrix);
    const byKey = (doc: FormDoc, predicate: (field: FieldDef) => boolean) => new Map(doc.fields.filter(field => usable(field) && predicate(field)).map(field => [field.key, field]));
    const filterable = { employee: byKey(docs.employee, field => field.flags.filter), person: byKey(docs.person, field => field.flags.filter) };
    const conditions: Prisma.Sql[] = [];

    const statuses = splitList(query.status).filter(status => status === 'active' || status === 'stopped');
    if (statuses.length === 1) conditions.push(Prisma.sql`e."isActive" = ${statuses[0] === 'active'}`);
    if (query.expiring === 'true') {
      // "Documents about to expire" — only for people who may see the dates; for everybody else the list is simply empty.
      const keys = this.expiryKeys(docs.person, matrix, expiryFields);
      conditions.push(keys.length ? Prisma.sql`(e."isActive" AND ${this.expiresSoon(keys)})` : Prisma.sql`FALSE`);
    }
    const search = searchAcross(['e', 'p', 'c'], query.search);
    if (search) conditions.push(search);
    for (const [key, raw] of Object.entries(filters)) {
      const personal = key.startsWith(PERSON_PREFIX);
      const field = (personal ? filterable.person : filterable.employee).get(personal ? key.slice(PERSON_PREFIX.length) : key);
      const condition = field ? fieldFilter(personal ? personContext : employeeContext, field, raw) : null;
      if (condition) conditions.push(condition);
    }

    let join: Prisma.Sql = Prisma.empty;
    const name = Prisma.sql`${LAST_NAME} ASC, ${FIRST_NAME} ASC`;
    let order: Prisma.Sql = Prisma.sql`${name}, e."id" ASC`;
    const sort = parseSort(query.sort);
    const dir = sort?.dir === 'desc' ? Prisma.raw('DESC') : Prisma.raw('ASC');
    if (sort) {
      if (sort.key === 'name') order = Prisma.sql`${LAST_NAME} ${dir}, ${FIRST_NAME} ${dir}, e."id" ASC`;
      else if (sort.key === 'client') order = Prisma.sql`${CLIENT_NUMBER} ${dir}, ${name}, e."id" ASC`;
      else if (sort.key === 'status') order = Prisma.sql`e."isActive" ${dir}, ${name}, e."id" ASC`;
      else if (sort.key === 'updatedAt') order = Prisma.sql`e."updatedAt" ${dir}, ${name}, e."id" ASC`;
      else if (sort.key === 'createdAt') order = Prisma.sql`e."createdAt" ${dir}, ${name}, e."id" ASC`;
      else {
        const personal = sort.key.startsWith(PERSON_PREFIX);
        const doc = personal ? docs.person : docs.employee;
        const key = personal ? sort.key.slice(PERSON_PREFIX.length) : sort.key;
        const field = doc.fields.find(candidate => candidate.key === key && usable(candidate));
        const planned = field ? fieldOrder(personal ? personContext : employeeContext, field, sort.dir) : null;
        if (planned) {
          join = planned.join;
          order = Prisma.sql`${planned.order}, ${name}, e."id" ASC`;
        }
      }
    } else if (query.search?.trim()) {
      // A search puts names (and client numbers) that start with what was typed first.
      const term = escapeLike(fold(query.search));
      order = Prisma.sql`
        CASE WHEN ${LAST_NAME} LIKE ${`${term}%`} OR ${FIRST_NAME} LIKE ${`${term}%`} THEN 0
             WHEN lower(c."number") = ${fold(query.search)} THEN 1
             ELSE 2 END, ${name}, e."id" ASC`;
    }

    return {
      from: Prisma.sql`FROM "Employee" e JOIN "Person" p ON p."id" = e."personId" JOIN "Client" c ON c."id" = e."clientId"`,
      join,
      where: conditions.length ? Prisma.join(conditions, ' AND ') : Prisma.sql`TRUE`,
      order,
    };
  }

  /** The counters above the grid; documents that expire only count for people who may see them (they are sensitive data). */
  private async stats(user: AuthenticatedUser, docs: { employee: FormDoc; person: FormDoc }, expiryFields: string[]) {
    const [groups, activeClients] = await Promise.all([
      this.prisma.employee.groupBy({ by: ['isActive'], _count: { _all: true } }),
      this.prisma.employee.findMany({ where: { isActive: true }, distinct: ['clientId'], select: { clientId: true } }),
    ]);
    const active = groups.find(group => group.isActive)?._count._all ?? 0;
    const stopped = groups.find(group => !group.isActive)?._count._all ?? 0;
    const keys = this.expiryKeys(docs.person, user.matrix, expiryFields);
    let expiring: number | null = null;
    if (keys.length) {
      const rows = await this.prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        SELECT count(*) AS "count" FROM "Employee" e JOIN "Person" p ON p."id" = e."personId" WHERE e."isActive" AND ${this.expiresSoon(keys)}`);
      expiring = Number(rows[0]?.count ?? 0);
    }
    return { total: active + stopped, active, stopped, clients: activeClients.length, documentsExpiring: expiring };
  }

  /**
   * The person-form fields that hold the end of a document's validity (`id_expiry`, `permit_expiry` …): the date fields the document types that
   * "follow the worker's record" name (Settings → Documents → Types), limited to the ones this person may see.
   */
  private expiryKeys(person: FormDoc, matrix: PermissionMatrix, expiryFields: readonly string[]): string[] {
    return person.fields.filter(field => field.active && field.type === 'date' && expiryFields.includes(field.key) && !isEncryptedField(field) && canViewField(field, matrix)).map(field => field.key);
  }

  /** "Expired, or expires within the warning period" for any of these fields (days are stored as `YYYY-MM-DD`, so text comparison is date comparison). */
  private expiresSoon(keys: string[]): Prisma.Sql {
    const limit = addDays(todayInAmsterdam(), this.settings.get<number>('documents.expiryWarningDays'));
    return Prisma.sql`(${Prisma.join(
      keys.map(key => Prisma.sql`(p."data" ->> ${key}) <= ${limit}`),
      ' OR ',
    )})`;
  }

  private describeFilters(query: EmployeeListQuery, filters: Record<string, string>, docs: { employee: FormDoc; person: FormDoc }, locale: AppLocale, statusNames: Map<string, string>): string {
    const nl = locale === 'nl';
    const parts: string[] = [];
    if (query.search?.trim()) parts.push(`${nl ? 'Zoekterm' : 'Search'}: ${query.search.trim()}`);
    const statuses = splitList(query.status);
    if (statuses.length === 1) parts.push(`Status: ${statusNames.get(statuses[0]!) ?? statuses[0]}`);
    for (const [key, raw] of Object.entries(filters)) {
      const personal = key.startsWith(PERSON_PREFIX);
      const field = (personal ? docs.person : docs.employee).fields.find(candidate => candidate.key === (personal ? key.slice(PERSON_PREFIX.length) : key));
      if (field) parts.push(`${field.labels[locale] || field.labels.nl}: ${raw.split(',').join(', ')}`);
    }
    return parts.join(' · ');
  }
}
