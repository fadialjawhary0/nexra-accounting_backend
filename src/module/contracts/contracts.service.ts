import { Injectable, Logger, NotFoundException, UnprocessableEntityException, type OnModuleInit } from '@nestjs/common';
import { paged, type ApiResult } from '../../common/api-result.js';
import { addDays, daysBetween, formatDay, isValidDay, parseDay, todayInAmsterdam } from '../../common/dates.js';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import { pageMeta } from '../../common/pagination.js';
import { asRecord, columnValues, day, splitValues } from '../../common/record-values.js';
import { fold } from '../../common/text.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { validationFailed } from '../../common/validation/failure.js';
import { Prisma, type Client, type Contract, type Employee, type Person } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { MAX_EXPORT_ROWS, type ExportColumn, type ExportFormat, type ExportTable } from '../../lib/exports/export.types.js';
import { DocumentsService } from '../../lib/documents/documents.service.js';
import { SettingsService } from '../../lib/settings/settings.service.js';
import { canViewField, valuesFor } from '../forms/field-access.js';
import { exportType, exportValue, exportWidth } from '../forms/field-export.js';
import { fieldFilter, fieldOrder, parseSort, searchAcross, type QueryContext } from '../forms/dynamic-query.js';
import { isEncryptedField, type FieldDef, type FormDoc } from '../forms/form-doc.js';
import { FormRecordsService } from '../forms/form-records.service.js';
import { FormValidationService } from '../forms/form-validation.service.js';
import { FormsService } from '../forms/forms.service.js';
import { ListsService } from '../lists/lists.service.js';
import { personName } from '../people/person-record.js';
import { TemplatesService } from '../templates/templates.service.js';
import { ContractDocumentsService } from './contract-documents.service.js';
import { ContractWarningsService, type ContractWarning } from './contract-warnings.service.js';
import {
  CONTRACT_COLUMNS,
  CONTRACT_DATE_COLUMNS,
  CONTRACT_ENTITY,
  CONTRACT_STATUSES,
  FIELD,
  OPEN_STATUSES,
  TYPE_RULES,
  endAfterMonths,
  exactMonths,
  isContractType,
  monthsBetween,
} from './contract-record.js';
import { CONTRACTS_NAMESPACE } from './contracts.settings.js';
import type { CheckContractDto, ContractExportQuery, ContractListQuery, CreateContractDto, UpdateContractDto } from './dto/contract.dto.js';

const splitList = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);

/** Padded so numbers sort the way people count: 7 < 42 < 146. */
const CLIENT_NUMBER = Prisma.raw(`lpad(c."number", 12, '0')`);
const LAST_NAME = Prisma.raw(`lower(unaccent(p."lastName"))`);
const FIRST_NAME = Prisma.raw(`lower(unaccent(p."firstName"))`);

export type ContractRow = Contract & { client: Client; employee: Employee & { person: Person } };
const WITH_PARTIES = { client: true, employee: { include: { person: true } } } as const satisfies Prisma.ContractInclude;

/**
 * Contracts: the list across clients (search, filters on every form field, sorting, counters, export), reading one contract with its documents,
 * warnings and renewal chain, and saving the contract form. What happens to a contract over time — sending, signing, terminating, renewing — is
 * `ContractLifecycleService`; the Word and PDF documents are `ContractDocumentsService`.
 */
@Injectable()
export class ContractsService implements OnModuleInit {
  private readonly logger = new Logger(ContractsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly forms: FormsService,
    private readonly validation: FormValidationService,
    private readonly records: FormRecordsService,
    private readonly lists: ListsService,
    private readonly settings: SettingsService,
    private readonly templates: TemplatesService,
    private readonly warnings: ContractWarningsService,
    private readonly documents: ContractDocumentsService,
    private readonly pdf: DocumentsService,
  ) {}

  onModuleInit(): void {
    this.forms.onPublish(CONTRACT_ENTITY, () => this.reindex());
  }

  /* ── Reading ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  async list(query: ContractListQuery, filters: Record<string, string>, user: AuthenticatedUser, locale: AppLocale): Promise<ApiResult> {
    const doc = await this.doc();
    const plan = this.plan(query, filters, doc, user.matrix, locale);
    const skip = (query.page - 1) * query.pageSize;

    const [ids, totals, stats] = await Promise.all([
      this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT k."id" ${plan.from} ${plan.join} WHERE ${plan.where} ORDER BY ${plan.order} LIMIT ${query.pageSize} OFFSET ${skip}`),
      this.prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`SELECT count(*) AS "count" ${plan.from} WHERE ${plan.where}`),
      query.stats ? this.stats() : undefined,
    ]);
    const rows = await this.inOrder(ids.map(row => row.id));
    const [signed, userNames] = await Promise.all([this.signedIds(rows.map(row => row.id)), this.userNames(rows, doc)]);
    const today = todayInAmsterdam();
    const data = rows.map(row => this.brief(row, doc, user.matrix, signed.has(row.id), today));
    return paged(data, pageMeta(Number(totals[0]?.count ?? 0), query, { users: Object.fromEntries(userNames), ...(stats && { stats }) }));
  }

  async get(id: string, user: AuthenticatedUser) {
    const row = await this.findOrThrow(id);
    const doc = await this.doc();
    const values = valuesFor(doc, this.values(row), user.matrix);
    const [documents, chain, template, warnings, pdfAvailable] = await Promise.all([
      this.documents.list(id),
      this.chain(row),
      this.templateOf(row),
      this.warningsFor(row),
      this.pdf.pdfAvailable(),
    ]);
    const current = documents.find(entry => entry.kind === 'contract') ?? null;
    const created = current ? new Date(current.createdAt) : null;
    const today = todayInAmsterdam();
    return {
      ...this.brief(row, doc, user.matrix, documents.some(entry => entry.kind === 'signed'), today),
      values,
      sentOn: day(row.sentOn),
      terminatedOn: day(row.terminatedOn),
      terminationReason: row.terminationReason,
      terminationNote: row.terminationNote,
      deactivatedAt: row.deactivatedAt?.toISOString() ?? null,
      template,
      documents,
      // The terms changed after the Word document was made: it no longer says what the contract says.
      documentOutdated: Boolean(created && row.termsChangedAt.getTime() > created.getTime() + 1000),
      chain,
      warnings,
      pdfAvailable,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** What the screen says about the contract as it is now (for the contract's page; only for contracts that are still open). */
  async warningsFor(row: ContractRow): Promise<ContractWarning[]> {
    if (!(OPEN_STATUSES as readonly string[]).includes(row.status)) return [];
    return this.warnings.check({
      clientId: row.clientId,
      employeeId: row.employeeId,
      type: row.type,
      startDate: formatDay(row.startDate),
      endDate: row.endDate ? formatDay(row.endDate) : null,
      probationMonths: Number(asRecord(row.data)[FIELD.probationMonths] ?? 0),
      hourlyRate: typeof asRecord(row.data)[FIELD.hourlyRate] === 'number' ? (asRecord(row.data)[FIELD.hourlyRate] as number) : null,
      monthlySalary: typeof asRecord(row.data)[FIELD.monthlySalary] === 'number' ? (asRecord(row.data)[FIELD.monthlySalary] as number) : null,
      excludeId: row.id,
    });
  }

  /** The same advice for a contract that is not saved (yet): the contract form while it is filled in. */
  async check(dto: CheckContractDto, user: AuthenticatedUser): Promise<ContractWarning[]> {
    await this.parties(dto.clientId, dto.employeeId);
    const doc = await this.doc();
    const existing = dto.excludeId ? this.values(await this.findOrThrow(dto.excludeId)) : {};
    const { values } = await this.validation.check(CONTRACT_ENTITY, dto.values ?? {}, existing, user.matrix, doc);
    const all = { ...existing, ...Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null)) } as Record<string, unknown>;
    this.alignLength(all, {});
    const text = (key: string) => (typeof all[key] === 'string' && isValidDay(all[key]) ? (all[key] as string) : null);
    const number = (key: string) => (typeof all[key] === 'number' ? (all[key] as number) : null);
    return this.warnings.check({
      clientId: dto.clientId,
      employeeId: dto.employeeId,
      type: typeof all.type === 'string' ? all.type : null,
      startDate: text('start_date'),
      endDate: text('end_date'),
      probationMonths: number(FIELD.probationMonths) ?? 0,
      hourlyRate: number(FIELD.hourlyRate),
      monthlySalary: number(FIELD.monthlySalary),
      excludeId: dto.excludeId ?? null,
    });
  }

  async findOrThrow(id: string): Promise<ContractRow> {
    const row = await this.prisma.contract.findUnique({ where: { id }, include: WITH_PARTIES });
    if (!row) throw new NotFoundException({ code: 'not_found', message: 'Contract not found' });
    return row;
  }

  /** The contract form values of a contract: the columns and the decrypted data. */
  values(row: Contract): Record<string, unknown> {
    return { ...this.records.decode(asRecord(row.data)), ...columnValues(CONTRACT_COLUMNS, row) };
  }

  /* ── Saving ───────────────────────────────────────────────────────────────────────────────────────────────────── */

  /** Saves a new contract as a draft. The client and the worker are fixed from here on. */
  async create(dto: CreateContractDto, user: AuthenticatedUser): Promise<ContractRow> {
    const { client, employee } = await this.parties(dto.clientId, dto.employeeId);
    const doc = await this.doc();

    const patch: Record<string, unknown> = { ...dto.values };
    const template = dto.templateId ? await this.templates.findOrThrow(dto.templateId) : null;
    const problems: Record<string, string> = {};
    if (template) {
      if (template.kind !== 'contract' || !template.isActive || (template.scope === 'client' && template.clientId !== client.id)) problems.templateId = 'validation.invalid';
      if (!patch.type && template.contractType) patch.type = template.contractType;
      else if (patch.type && template.contractType && patch.type !== template.contractType) problems.templateId = 'contracts.templateType';
    }
    if (patch.function === undefined && employee.functionCode) patch.function = employee.functionCode;

    const { values, errors } = await this.validation.check(CONTRACT_ENTITY, patch, {}, user.matrix);
    Object.assign(problems, errors);
    this.alignLength(values, {});
    this.checkTerms(values, {}, problems);
    const unique = await this.records.checkUnique(CONTRACT_ENTITY, null, doc, values, {});
    Object.assign(problems, unique.errors);

    let renewalOf: Contract | null = null;
    if (dto.renewalOfId) {
      renewalOf = await this.prisma.contract.findUnique({ where: { id: dto.renewalOfId } });
      if (!renewalOf || renewalOf.employeeId !== employee.id) problems.renewalOfId = 'validation.invalid';
    }
    if (Object.keys(problems).length) throw validationFailed(problems);

    const type = String(values.type);
    if (TYPE_RULES[type as keyof typeof TYPE_RULES]?.end === 'none') values.end_date = null;
    const { columns, data } = splitValues(CONTRACT_COLUMNS, values);
    const start = String(columns.startDate);
    const end = columns.endDate ?? null;
    const searchText = await this.records.searchText(doc, values, [client.number, client.name, personName(employee.person)]);

    const created = await this.prisma.$transaction(async tx => {
      const row = await tx.contract.create({
        data: {
          clientId: client.id,
          employeeId: employee.id,
          type,
          startDate: parseDay(start),
          endDate: end ? parseDay(end) : null,
          durationMonths: monthsBetween(start, end),
          templateId: template?.id ?? null,
          templateVersionId: template ? (template.versions[0]?.id ?? null) : null,
          renewalOfId: renewalOf?.id ?? null,
          data: FormRecordsService.merge({}, this.records.encode(doc, data)) as Prisma.InputJsonObject,
          searchText,
          createdById: user.id,
        },
      });
      await this.records.claim(tx, CONTRACT_ENTITY, row.id, doc, values);
      return row;
    });
    await this.audit.log({
      action: 'created',
      entityType: 'contract',
      entityId: created.id,
      entityLabel: this.label(client, employee.person, start),
      after: { ...this.records.auditSnapshot(doc, values), client: `${client.number} – ${client.name}`, employee: personName(employee.person), ...(template && { template: template.name }) },
    });
    return this.findOrThrow(created.id);
  }

  /** Changes the terms of a contract that is not history yet. The type is fixed once it has been saved as a draft; the client and the worker never change. */
  async update(id: string, dto: UpdateContractDto, user: AuthenticatedUser) {
    const row = await this.findOrThrow(id);
    if (!(OPEN_STATUSES as readonly string[]).includes(row.status)) throw new UnprocessableEntityException({ code: 'contract_locked', message: 'This contract is history and can no longer be changed.' });
    const doc = await this.doc();
    const existing = this.values(row);
    const patch = { ...dto.values };
    if (row.status !== 'draft') delete patch.type;
    const { values, errors } = await this.validation.check(CONTRACT_ENTITY, patch, existing, user.matrix);
    const problems: Record<string, string> = { ...errors };
    this.alignLength(values, existing);
    this.checkTerms(values, existing, problems);
    const unique = await this.records.checkUnique(CONTRACT_ENTITY, id, doc, values, existing);
    Object.assign(problems, unique.errors);
    if (Object.keys(problems).length) throw validationFailed(problems);

    const keys = Object.keys(values);
    const diff = this.records.auditChange(doc, Object.fromEntries(keys.map(key => [key, existing[key] ?? null])), Object.fromEntries(keys.map(key => [key, values[key] ?? null])));
    if (!Object.keys(diff.after).length) return this.get(id, user);

    const nextValues = { ...existing };
    for (const [key, value] of Object.entries(values)) {
      if (value === null) delete nextValues[key];
      else nextValues[key] = value;
    }
    const type = String(nextValues.type ?? row.type);
    if (TYPE_RULES[type as keyof typeof TYPE_RULES]?.end === 'none') {
      values.end_date = null;
      delete nextValues.end_date;
    }
    const { columns, data } = splitValues(CONTRACT_COLUMNS, values);
    const start = typeof nextValues.start_date === 'string' ? nextValues.start_date : formatDay(row.startDate);
    const end = typeof nextValues.end_date === 'string' ? nextValues.end_date : null;
    const searchText = await this.records.searchText(doc, nextValues, [row.client.number, row.client.name, personName(row.employee.person)]);
    const stored = FormRecordsService.merge(asRecord(row.data), this.records.encode(doc, data));

    await this.prisma.$transaction(async tx => {
      await tx.contract.update({
        where: { id },
        data: {
          ...(typeof columns.type === 'string' && { type: columns.type }),
          ...(typeof columns.startDate === 'string' && { startDate: parseDay(columns.startDate) }),
          ...('endDate' in columns && { endDate: columns.endDate ? parseDay(columns.endDate) : null }),
          durationMonths: monthsBetween(start, end),
          data: stored as Prisma.InputJsonObject,
          searchText,
          termsChangedAt: new Date(),
        },
      });
      await this.records.claim(tx, CONTRACT_ENTITY, id, doc, nextValues);
    });
    await this.audit.log({ action: 'updated', entityType: 'contract', entityId: id, entityLabel: this.label(row.client, row.employee.person, formatDay(row.startDate)), before: diff.before, after: diff.after });
    return this.get(id, user);
  }

  /* ── Export ───────────────────────────────────────────────────────────────────────────────────────────────────── */

  /** The list (same search, filters and sorting; every page) as a table. */
  async exportTable(query: ContractExportQuery, filters: Record<string, string>, user: AuthenticatedUser, locale: AppLocale, format: ExportFormat): Promise<{ table: ExportTable; count: number }> {
    const doc = await this.doc();
    const plan = this.plan(query, filters, doc, user.matrix, locale);
    const ids = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT k."id" ${plan.from} ${plan.join} WHERE ${plan.where} ORDER BY ${plan.order} LIMIT ${MAX_EXPORT_ROWS + 1}`);
    const rows = await this.inOrder(ids.map(row => row.id));

    const nl = locale === 'nl';
    const fields = doc.fields
      .filter(field => field.active && !isEncryptedField(field) && canViewField(field, user.matrix) && field.type !== 'client' && field.type !== 'file')
      .sort((a, b) => (doc.sections.find(s => s.key === a.section)?.order ?? 0) - (doc.sections.find(s => s.key === b.section)?.order ?? 0) || a.order - b.order);
    const byKey = new Map(fields.map(field => [field.key, field]));
    const builtIn: Record<string, ExportColumn> = {
      '@client': { key: '@client', header: nl ? 'Klant' : 'Client', width: 30 },
      '@clientNumber': { key: '@clientNumber', header: nl ? 'Klantnummer' : 'Client number', width: 14 },
      '@clientName': { key: '@clientName', header: nl ? 'Klantnaam' : 'Client name', width: 28 },
      '@worker': { key: '@worker', header: nl ? 'Werknemer' : 'Employee', width: 26 },
      '@status': { key: '@status', header: 'Status', width: 14 },
      '@duration': { key: '@duration', header: nl ? 'Duur (maanden)' : 'Length (months)', type: 'number', width: 12 },
      '@signed': { key: '@signed', header: nl ? 'Ondertekend op' : 'Signed on', type: 'date', width: 14 },
    };
    const asked = splitList(query.columns);
    const defaults =
      format === 'xlsx'
        ? ['@clientNumber', '@clientName', '@worker', ...fields.filter(field => field.flags.export || field.flags.list).map(field => field.key), '@duration', '@signed', '@status']
        : ['@client', '@worker', ...fields.filter(field => field.flags.list).map(field => field.key), '@duration', '@status'];
    const order = [...new Set(asked.length ? asked : defaults)].filter(key => key in builtIn || byKey.has(key));
    const chosen = order.flatMap(key => (byKey.has(key) ? [byKey.get(key)!] : []));

    const listKeys = [...new Set(chosen.filter(field => (field.type === 'select' || field.type === 'multiselect') && field.list).map(field => field.list as string))];
    const [lookups, userNames] = await Promise.all([this.lists.lookups([...listKeys, 'contract_status', 'contract_type'], locale), this.userNames(rows, doc)]);
    const names = (key: string) => new Map((lookups[key]?.items ?? []).map(item => [item.code, item.name]));
    const named = new Map(listKeys.map(key => [key, names(key)]));
    const statusNames = names('contract_status');

    const columns: ExportColumn[] = order.map(key => {
      const field = byKey.get(key);
      return field ? { key, header: field.labels[locale] || field.labels.nl, type: exportType(field), width: exportWidth(field) } : builtIn[key]!;
    });
    const table: ExportTable = {
      title: nl ? 'Contracten' : 'Contracts',
      subtitle: this.describeFilters(query, filters, doc, locale, statusNames) || undefined,
      locale,
      columns,
      rows: rows.slice(0, MAX_EXPORT_ROWS).map(row => {
        const values: Record<string, unknown> = { ...this.records.publicValues(asRecord(row.data)), ...columnValues(CONTRACT_COLUMNS, row) };
        const cells: Record<string, unknown> = {
          '@client': `${row.client.number} – ${row.client.name}`,
          '@clientNumber': row.client.number,
          '@clientName': row.client.name,
          '@worker': personName(row.employee.person),
          '@status': statusNames.get(row.status) ?? row.status,
          '@duration': row.durationMonths,
          '@signed': day(row.signedOn),
        };
        for (const field of chosen) cells[field.key] = exportValue(field, values[field.key], named, userNames, locale);
        return cells;
      }),
    };
    return { table, count: rows.length };
  }

  /* ── Derived data ─────────────────────────────────────────────────────────────────────────────────────────────── */

  /** Rebuilds the search text and the unique values of every contract (after the contract form changed). */
  async reindex(): Promise<void> {
    const doc = await this.doc();
    const rows = await this.prisma.contract.findMany({ include: WITH_PARTIES });
    const claims: Array<{ entity: string; fieldKey: string; value: string; recordId: string }> = [];
    for (const row of rows) {
      const values = this.values(row);
      const searchText = await this.records.searchText(doc, values, [row.client.number, row.client.name, personName(row.employee.person)]);
      if (searchText !== row.searchText) await this.prisma.contract.update({ where: { id: row.id }, data: { searchText } });
      claims.push(...this.records.uniqueClaims(CONTRACT_ENTITY, row.id, doc, values));
    }
    await this.prisma.$transaction([this.prisma.uniqueFieldValue.deleteMany({ where: { entity: CONTRACT_ENTITY } }), this.prisma.uniqueFieldValue.createMany({ data: claims, skipDuplicates: true })]);
    this.logger.log(`Reindexed ${rows.length} contracts.`);
  }

  /** The counters above the list. */
  async stats() {
    const today = todayInAmsterdam();
    const limit = addDays(today, this.settings.get<number>(`${CONTRACTS_NAMESPACE}.expiringDays`));
    const [groups, expiring, unsigned] = await Promise.all([
      this.prisma.contract.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.contract.count({ where: { status: 'active', endDate: { gte: parseDay(today), lte: parseDay(limit) } } }),
      this.prisma.contract.count({ where: { status: 'active', documents: { none: { kind: 'signed', isActive: true } } } }),
    ]);
    const counts = Object.fromEntries(CONTRACT_STATUSES.map(status => [status, groups.find(group => group.status === status)?._count._all ?? 0]));
    return { total: groups.reduce((sum, group) => sum + group._count._all, 0), ...counts, expiring, expiringDays: this.settings.get<number>(`${CONTRACTS_NAMESPACE}.expiringDays`), withoutScan: unsigned };
  }

  /* ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  async doc(): Promise<FormDoc> {
    return (await this.forms.live(CONTRACT_ENTITY)).doc;
  }

  /** The client and the worker must exist, the worker must work for this client. */
  async parties(clientId: string, employeeId: string): Promise<{ client: Client; employee: Employee & { person: Person } }> {
    const [client, employee] = await Promise.all([
      this.prisma.client.findUnique({ where: { id: clientId } }),
      this.prisma.employee.findUnique({ where: { id: employeeId }, include: { person: true } }),
    ]);
    const problems: Record<string, string> = {};
    if (!client) problems.clientId = 'validation.invalid';
    if (!employee) problems.employeeId = 'validation.invalid';
    else if (client && employee.clientId !== client.id) problems.employeeId = 'contracts.workerOtherClient';
    if (Object.keys(problems).length) throw validationFailed(problems);
    return { client: client!, employee: employee! };
  }

  label(client: Pick<Client, 'number'>, person: Pick<Person, 'firstName' | 'lastName' | 'data'>, start: string): string {
    return `${client.number} – ${personName(person)} (${start})`;
  }

  /**
   * The length in months and the end date go together (Ahmad, 17-10-2026): a length given with the start date (or a moved start) and no end date of its own fills in
   * the end date — the day before the same date that many months later; an end date sets the length to its whole months, or empties it for a part month. A contract
   * without an end (permanent) has neither. Changes `values` (the patch) in place.
   */
  private alignLength(values: Record<string, unknown>, existing: Record<string, unknown>): void {
    const pick = (key: string) => (key in values ? values[key] : existing[key]);
    const type = pick('type');
    const months = pick(FIELD.durationMonths);
    if (isContractType(type) && TYPE_RULES[type].end === 'none') {
      if (months !== undefined && months !== null) values[FIELD.durationMonths] = null;
      return;
    }
    const start = pick('start_date');
    if (typeof start !== 'string' || !isValidDay(start)) return;
    const endGiven = 'end_date' in values && typeof values.end_date === 'string' && values.end_date !== '';
    if (typeof months === 'number' && Number.isInteger(months) && months > 0 && (FIELD.durationMonths in values || 'start_date' in values) && !endGiven) {
      values.end_date = endAfterMonths(start, months);
      return;
    }
    const end = pick('end_date');
    if (typeof end !== 'string' || !isValidDay(end)) return;
    const exact = exactMonths(start, end);
    if ((months ?? null) !== exact) values[FIELD.durationMonths] = exact;
  }

  /** The rules between the fields: the type decides whether there must be an end date, and an end cannot come before the start. */
  private checkTerms(values: Record<string, unknown>, existing: Record<string, unknown>, problems: Record<string, string>): void {
    const pick = (key: string) => (key in values ? values[key] : existing[key]);
    const type = pick('type');
    const start = pick('start_date');
    const end = pick('end_date');
    if (isContractType(type) && TYPE_RULES[type].end === 'required' && !end && !problems.end_date) problems.end_date = 'contracts.endRequired';
    if (typeof start === 'string' && typeof end === 'string' && end < start && !problems.end_date) problems.end_date = 'validation.endBeforeStart';
  }

  private async templateOf(row: ContractRow) {
    if (!row.templateId) return null;
    const [template, version] = await Promise.all([
      this.prisma.template.findUnique({ where: { id: row.templateId }, select: { id: true, name: true, isActive: true, versions: { select: { version: true }, orderBy: { version: 'desc' }, take: 1 } } }),
      row.templateVersionId ? this.prisma.templateVersion.findUnique({ where: { id: row.templateVersionId }, select: { version: true } }) : null,
    ]);
    return template ? { id: template.id, name: template.name, isActive: template.isActive, version: version?.version ?? null, latestVersion: template.versions[0]?.version ?? null } : null;
  }

  /** The chain of contracts this one belongs to: the earliest first, with this one marked. */
  private async chain(row: ContractRow) {
    let rootId = row.id;
    let cursor: string | null = row.renewalOfId;
    for (let depth = 0; cursor && depth < 30; depth += 1) {
      rootId = cursor;
      const parent: { renewalOfId: string | null } | null = await this.prisma.contract.findUnique({ where: { id: cursor }, select: { renewalOfId: true } });
      cursor = parent?.renewalOfId ?? null;
    }
    const members: Contract[] = [];
    let frontier = [rootId];
    for (let depth = 0; frontier.length && depth < 30; depth += 1) {
      const found = await this.prisma.contract.findMany({ where: { id: { in: frontier } } });
      members.push(...found);
      const next = await this.prisma.contract.findMany({ where: { renewalOfId: { in: frontier } }, select: { id: true } });
      frontier = next.map(entry => entry.id);
    }
    if (members.length < 2) return [];
    return members
      .sort((a, b) => a.startDate.getTime() - b.startDate.getTime())
      .map(member => ({ id: member.id, status: member.status, type: member.type, startDate: formatDay(member.startDate), endDate: day(member.endDate), terminatedOn: day(member.terminatedOn), current: member.id === row.id }));
  }

  private brief(row: ContractRow, doc: FormDoc, matrix: AuthenticatedUser['matrix'], signed: boolean, today: string) {
    const end = row.endDate ? formatDay(row.endDate) : null;
    return {
      id: row.id,
      status: row.status,
      type: row.type,
      isActive: row.isActive,
      startDate: formatDay(row.startDate),
      endDate: end,
      durationMonths: row.durationMonths,
      signedOn: day(row.signedOn),
      terminatedOn: day(row.terminatedOn),
      signed,
      endsInDays: row.status === 'active' && end ? daysBetween(today, end) : null,
      renewalOfId: row.renewalOfId,
      client: { id: row.client.id, number: row.client.number, name: row.client.name, isActive: row.client.isActive },
      employee: { id: row.employee.id, name: personName(row.employee.person), isActive: row.employee.isActive },
      values: valuesFor(doc, { ...this.records.publicValues(asRecord(row.data)), ...columnValues(CONTRACT_COLUMNS, row) }, matrix),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async inOrder(ids: string[]): Promise<ContractRow[]> {
    const rows = await this.prisma.contract.findMany({ where: { id: { in: ids } }, include: WITH_PARTIES });
    const position = new Map(ids.map((id, index) => [id, index]));
    return rows.sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));
  }

  /** The contracts of this page that have a signed copy. */
  private async signedIds(ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const rows = await this.prisma.contractDocument.findMany({ where: { contractId: { in: ids }, kind: 'signed', isActive: true }, select: { contractId: true } });
    return new Set(rows.map(row => row.contractId));
  }

  private async userNames(rows: ContractRow[], doc: FormDoc): Promise<Map<string, string>> {
    const keys = doc.fields.filter(field => field.type === 'user').map(field => field.key);
    const found = new Set<string>();
    for (const row of rows) {
      const own = asRecord(row.data);
      for (const key of keys) if (typeof own[key] === 'string') found.add(own[key]);
    }
    if (!found.size) return new Map();
    const users = await this.prisma.user.findMany({ where: { id: { in: [...found] } }, select: { id: true, name: true } });
    return new Map(users.map(entry => [entry.id, entry.name]));
  }

  private describeFilters(query: ContractListQuery, filters: Record<string, string>, doc: FormDoc, locale: AppLocale, statusNames: Map<string, string>): string {
    const nl = locale === 'nl';
    const parts: string[] = [];
    if (query.search?.trim()) parts.push(`${nl ? 'Zoekterm' : 'Search'}: ${query.search.trim()}`);
    const statuses = splitList(query.status);
    if (statuses.length) parts.push(`Status: ${statuses.map(status => statusNames.get(status) ?? status).join(', ')}`);
    if (query.expiring === 'true') parts.push(nl ? 'Loopt binnenkort af' : 'Ends soon');
    if (query.unsigned === 'true') parts.push(nl ? 'Zonder getekende kopie' : 'Without signed copy');
    for (const [key, raw] of Object.entries(filters)) {
      const field = doc.fields.find(candidate => candidate.key === key);
      if (field) parts.push(`${field.labels[locale] || field.labels.nl}: ${raw.split(',').join(', ')}`);
    }
    return parts.join(' · ');
  }

  /* ── Queries ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  /** FROM / JOIN / WHERE / ORDER BY of a list or export request. */
  private plan(query: ContractListQuery, filters: Record<string, string>, doc: FormDoc, matrix: AuthenticatedUser['matrix'], locale: AppLocale) {
    const context: QueryContext = { alias: 'k', columns: CONTRACT_COLUMNS, locale, dateColumns: CONTRACT_DATE_COLUMNS };
    const usable = (field: FieldDef) => field.active && !isEncryptedField(field) && canViewField(field, matrix);
    const filterable = new Map(doc.fields.filter(field => usable(field) && field.flags.filter).map(field => [field.key, field]));
    const conditions: Prisma.Sql[] = [];

    const statuses = splitList(query.status).filter(status => (CONTRACT_STATUSES as readonly string[]).includes(status));
    if (statuses.length) conditions.push(Prisma.sql`k."status" IN (${Prisma.join(statuses)})`);
    const types = splitList(query.type);
    if (types.length) conditions.push(Prisma.sql`k."type" IN (${Prisma.join(types)})`);
    if (query.clientId) conditions.push(Prisma.sql`k."clientId" = ${query.clientId}`);
    if (query.employeeId) conditions.push(Prisma.sql`k."employeeId" = ${query.employeeId}`);
    if (query.isActive === 'true' || query.isActive === 'false') conditions.push(Prisma.sql`k."isActive" = ${query.isActive === 'true'}`);
    if (query.expiring === 'true') {
      const today = todayInAmsterdam();
      const limit = addDays(today, this.settings.get<number>(`${CONTRACTS_NAMESPACE}.expiringDays`));
      conditions.push(Prisma.sql`(k."status" = 'active' AND k."endDate" BETWEEN ${today}::date AND ${limit}::date)`);
    }
    if (query.unsigned === 'true') {
      conditions.push(Prisma.sql`(k."status" = 'active' AND NOT EXISTS (SELECT 1 FROM "ContractDocument" d WHERE d."contractId" = k."id" AND d."kind" = 'signed' AND d."isActive"))`);
    }
    const search = searchAcross(['k', 'p', 'c'], query.search);
    if (search) conditions.push(search);
    for (const [key, raw] of Object.entries(filters)) {
      const field = filterable.get(key);
      const condition = field ? fieldFilter(context, field, raw) : null;
      if (condition) conditions.push(condition);
    }

    let join: Prisma.Sql = Prisma.empty;
    const name = Prisma.sql`${LAST_NAME} ASC, ${FIRST_NAME} ASC`;
    // What needs attention comes first: running contracts that end soonest, then sent ones, drafts and, last, the history.
    let order: Prisma.Sql = Prisma.sql`CASE k."status" WHEN 'active' THEN 0 WHEN 'sent' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END ASC, k."endDate" ASC NULLS LAST, ${CLIENT_NUMBER} ASC, ${name}, k."id" ASC`;
    const sort = parseSort(query.sort);
    const dir = sort?.dir === 'desc' ? Prisma.raw('DESC') : Prisma.raw('ASC');
    if (sort) {
      const simple: Record<string, Prisma.Sql> = {
        client: Prisma.sql`${CLIENT_NUMBER} ${dir}`,
        worker: Prisma.sql`${LAST_NAME} ${dir}, ${FIRST_NAME} ${dir}`,
        status: Prisma.sql`k."status" ${dir}`,
        type: Prisma.sql`k."type" ${dir}`,
        startDate: Prisma.sql`k."startDate" ${dir}`,
        endDate: Prisma.sql`k."endDate" ${dir} NULLS LAST`,
        duration: Prisma.sql`k."durationMonths" ${dir} NULLS LAST`,
        updatedAt: Prisma.sql`k."updatedAt" ${dir}`,
        createdAt: Prisma.sql`k."createdAt" ${dir}`,
      };
      const chosen = simple[sort.key];
      if (chosen) order = Prisma.sql`${chosen}, ${CLIENT_NUMBER} ASC, ${name}, k."id" ASC`;
      else {
        const field = doc.fields.find(candidate => candidate.key === sort.key && usable(candidate));
        const planned = field ? fieldOrder(context, field, sort.dir) : null;
        if (planned) {
          join = planned.join;
          order = Prisma.sql`${planned.order}, ${CLIENT_NUMBER} ASC, ${name}, k."id" ASC`;
        }
      }
    } else if (query.search?.trim()) {
      // A search puts workers and client numbers that start with what was typed first.
      const term = fold(query.search);
      order = Prisma.sql`CASE WHEN ${LAST_NAME} LIKE ${`${term}%`} OR ${FIRST_NAME} LIKE ${`${term}%`} THEN 0 WHEN lower(c."number") = ${term} THEN 1 ELSE 2 END, k."endDate" ASC NULLS LAST, ${name}, k."id" ASC`;
    }

    return {
      from: Prisma.sql`FROM "Contract" k JOIN "Employee" e ON e."id" = k."employeeId" JOIN "Person" p ON p."id" = e."personId" JOIN "Client" c ON c."id" = k."clientId"`,
      join,
      where: conditions.length ? Prisma.join(conditions, ' AND ') : Prisma.sql`TRUE`,
      order,
    };
  }
}
