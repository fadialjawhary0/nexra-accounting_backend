import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { ApiResult, paged } from '../../common/api-result.js';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import { pageMeta, toOrderBy, toSkipTake } from '../../common/pagination.js';
import { asRecord, columnValues, splitValues } from '../../common/record-values.js';
import { fold } from '../../common/text.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { validationFailed } from '../../common/validation/failure.js';
import type { Counterparty, Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import type { ExportTable } from '../../lib/exports/export.types.js';
import { ExportsService } from '../../lib/exports/exports.service.js';
import { valuesFor } from '../forms/field-access.js';
import { FormRecordsService } from '../forms/form-records.service.js';
import { FormValidationService } from '../forms/form-validation.service.js';
import { FormsService } from '../forms/forms.service.js';
import { COUNTERPARTY_COLUMNS, COUNTERPARTY_ENTITY } from '../invoices/invoices.constants.js';
import type { CounterpartyExportQuery, CounterpartyListQuery, CounterpartyStatusDto, SaveCounterpartyDto } from './dto/counterparty.dto.js';

type Row = Counterparty & { _count: { invoices: number } };

/**
 * The companies that are not clients but sit in the staffing chain: staffing agencies that supply workers, companies that hire them. A company is entered
 * once and reused on every invoice (and in the invoice template as `{recipient.name}` …). It is switched off, never deleted, because invoices point at it.
 */
@Injectable()
export class CounterpartiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly forms: FormsService,
    private readonly validation: FormValidationService,
    private readonly records: FormRecordsService,
    private readonly exports: ExportsService,
  ) {}

  private view(row: Row) {
    const data = this.records.publicValues(asRecord(row.data));
    const text = (key: string) => (typeof data[key] === 'string' ? (data[key] as string) : '');
    return {
      id: row.id,
      name: row.name,
      kvk: row.kvk,
      vatNumber: row.vatNumber,
      city: text('city'),
      contactPerson: text('contact_person'),
      email: text('email'),
      phone: text('phone'),
      isActive: row.isActive,
      invoices: row._count.invoices,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private where(query: Pick<CounterpartyListQuery, 'search' | 'status'>): Prisma.CounterpartyWhereInput {
    const terms = fold(query.search ?? '').split(' ').filter(Boolean);
    const status = query.status ?? 'active';
    return { ...(status !== 'all' && { isActive: status === 'active' }), ...(terms.length && { AND: terms.map(term => ({ searchText: { contains: term } })) }) };
  }

  async list(query: CounterpartyListQuery): Promise<ApiResult> {
    const where = this.where(query);
    const orderBy = toOrderBy(query.sort, ['name', 'kvk', 'createdAt'], [{ name: 'asc' }]) as Prisma.CounterpartyOrderByWithRelationInput[];
    const [total, rows, counts] = await Promise.all([
      this.prisma.counterparty.count({ where }),
      this.prisma.counterparty.findMany({ where, orderBy, include: { _count: { select: { invoices: true } } }, ...toSkipTake(query) }),
      query.stats ? this.prisma.counterparty.groupBy({ by: ['isActive'], where: this.where({ search: query.search, status: 'all' }), _count: { _all: true } }) : Promise.resolve(null),
    ]);
    return paged(
      rows.map(row => this.view(row)),
      pageMeta(total, query, counts ? { counts: { active: counts.find(row => row.isActive)?._count._all ?? 0, inactive: counts.find(row => !row.isActive)?._count._all ?? 0 } } : {}),
    );
  }

  private async rowOrThrow(id: string): Promise<Row> {
    const row = await this.prisma.counterparty.findUnique({ where: { id }, include: { _count: { select: { invoices: true } } } });
    if (!row) throw new NotFoundException({ code: 'not_found', message: 'Company not found' });
    return row;
  }

  async one(id: string, user: AuthenticatedUser) {
    const row = await this.rowOrThrow(id);
    const { doc } = await this.forms.live(COUNTERPARTY_ENTITY);
    return {
      ...this.view(row),
      deactivationReason: row.deactivationReason,
      deactivatedAt: row.deactivatedAt?.toISOString() ?? null,
      values: valuesFor(doc, { ...this.records.publicValues(asRecord(row.data)), ...columnValues(COUNTERPARTY_COLUMNS, row) }, user.matrix),
    };
  }

  /** A company with the same KvK number (or, without one, the same name) is the same company. */
  private async assertNew(columns: { name?: string | null; kvk?: string | null }, exceptId?: string): Promise<void> {
    const same = columns.kvk ? { kvk: columns.kvk } : { name: { equals: columns.name ?? '', mode: 'insensitive' as const } };
    const duplicate = await this.prisma.counterparty.findFirst({ where: { ...same, ...(exceptId && { id: { not: exceptId } }) }, select: { id: true, name: true } });
    if (duplicate) throw new ConflictException({ code: 'counterparty_duplicate', message: `${duplicate.name} is already in the list.`, fields: { [columns.kvk ? 'kvk' : 'name']: 'validation.numberInUse' }, details: { id: duplicate.id, name: duplicate.name } });
  }

  async create(dto: SaveCounterpartyDto, user: AuthenticatedUser) {
    const { doc } = await this.forms.live(COUNTERPARTY_ENTITY);
    const { values, errors } = await this.validation.check(COUNTERPARTY_ENTITY, dto.values, {}, user.matrix, doc);
    if (Object.keys(errors).length) throw new UnprocessableEntityException({ code: 'validation_failed', message: 'Validation failed', fields: errors });
    const { columns, data } = splitValues(COUNTERPARTY_COLUMNS, values);
    if (!columns.name?.trim()) throw validationFailed({ name: 'validation.required' });
    await this.assertNew(columns);
    const row = await this.prisma.counterparty.create({
      data: {
        name: columns.name.trim(),
        kvk: columns.kvk ?? null,
        vatNumber: columns.vatNumber ?? null,
        data: FormRecordsService.merge({}, this.records.encode(doc, data)) as Prisma.InputJsonObject,
        searchText: await this.records.searchText(doc, values, [columns.name]),
        createdById: user.id,
      },
    });
    await this.audit.log({ action: 'created', entityType: 'counterparty', entityId: row.id, entityLabel: row.name, after: this.records.auditSnapshot(doc, values) });
    return this.one(row.id, user);
  }

  async update(id: string, dto: SaveCounterpartyDto, user: AuthenticatedUser) {
    const row = await this.rowOrThrow(id);
    const { doc } = await this.forms.live(COUNTERPARTY_ENTITY);
    const existing = { ...this.records.decode(asRecord(row.data)), ...columnValues(COUNTERPARTY_COLUMNS, row) };
    const { values, errors } = await this.validation.check(COUNTERPARTY_ENTITY, dto.values, existing, user.matrix, doc);
    if (Object.keys(errors).length) throw new UnprocessableEntityException({ code: 'validation_failed', message: 'Validation failed', fields: errors });
    const { columns, data } = splitValues(COUNTERPARTY_COLUMNS, values);
    const name = columns.name === undefined ? row.name : (columns.name ?? '').trim();
    if (!name) throw validationFailed({ name: 'validation.required' });
    const kvk = columns.kvk === undefined ? row.kvk : columns.kvk;
    if (name !== row.name || kvk !== row.kvk) await this.assertNew({ name, kvk }, id);

    const keys = Object.keys(values);
    const diff = this.records.auditChange(doc, Object.fromEntries(keys.map(key => [key, existing[key] ?? null])), Object.fromEntries(keys.map(key => [key, values[key] ?? null])));
    if (!Object.keys(diff.after).length) return this.one(id, user);
    const stored = FormRecordsService.merge(asRecord(row.data), this.records.encode(doc, data));
    const all = { ...this.records.publicValues(stored), name, kvk, vat_number: columns.vatNumber === undefined ? row.vatNumber : columns.vatNumber };
    await this.prisma.counterparty.update({
      where: { id },
      data: {
        name,
        kvk: kvk ?? null,
        vatNumber: columns.vatNumber === undefined ? row.vatNumber : columns.vatNumber,
        data: stored as Prisma.InputJsonObject,
        searchText: await this.records.searchText(doc, all, [name]),
      },
    });
    await this.audit.log({ action: 'updated', entityType: 'counterparty', entityId: id, entityLabel: name, before: diff.before, after: diff.after });
    return this.one(id, user);
  }

  /** Switches a company on or off (it stays for the invoices that point at it). */
  async setStatus(id: string, dto: CounterpartyStatusDto, user: AuthenticatedUser) {
    const row = await this.rowOrThrow(id);
    if (row.isActive === dto.isActive) return this.one(id, user);
    await this.prisma.counterparty.update({
      where: { id },
      data: dto.isActive ? { isActive: true, deactivatedAt: null, deactivatedById: null, deactivationReason: '' } : { isActive: false, deactivatedAt: new Date(), deactivatedById: user.id, deactivationReason: dto.reason?.trim() ?? '' },
    });
    await this.audit.log({ action: dto.isActive ? 'activated' : 'deactivated', entityType: 'counterparty', entityId: id, entityLabel: row.name, ...(dto.reason?.trim() && { meta: { reason: dto.reason.trim() } }) });
    return this.one(id, user);
  }

  /** The companies a list shows, as a table for Excel, PDF or Word. */
  async listTable(query: CounterpartyExportQuery, locale: AppLocale): Promise<ExportTable> {
    const where = this.where(query);
    this.exports.assertSize(await this.prisma.counterparty.count({ where }));
    const rows = await this.prisma.counterparty.findMany({ where, orderBy: { name: 'asc' }, include: { _count: { select: { invoices: true } } } });
    const nl = locale === 'nl';
    return {
      title: nl ? 'Bedrijven (uitzendbureaus en inleners)' : 'Companies (staffing companies and hirers)',
      locale,
      columns: [
        { key: 'name', header: nl ? 'Bedrijf' : 'Company', width: 30 },
        { key: 'kvk', header: 'KvK', width: 12 },
        { key: 'vat', header: nl ? 'BTW-nummer' : 'VAT number', width: 16 },
        { key: 'city', header: nl ? 'Plaats' : 'City', width: 18 },
        { key: 'contact', header: nl ? 'Contactpersoon' : 'Contact person', width: 22 },
        { key: 'email', header: 'E-mail', width: 26 },
        { key: 'phone', header: nl ? 'Telefoon' : 'Phone', width: 16 },
        { key: 'invoices', header: nl ? 'Facturen' : 'Invoices', type: 'number', width: 9 },
        { key: 'active', header: nl ? 'Actief' : 'Active', type: 'boolean', width: 8 },
      ],
      rows: rows.map(row => {
        const view = this.view(row);
        return { name: view.name, kvk: view.kvk ?? '', vat: view.vatNumber ?? '', city: view.city, contact: view.contactPerson, email: view.email, phone: view.phone, invoices: view.invoices, active: view.isActive };
      }),
    };
  }
}
