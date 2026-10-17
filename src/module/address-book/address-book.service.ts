import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ApiResult, paged } from '../../common/api-result.js';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import { pageMeta, toOrderBy, toSkipTake } from '../../common/pagination.js';
import { fold } from '../../common/text.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { validationFailed } from '../../common/validation/failure.js';
import type { AddressBookEntry, Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import type { ExportTable } from '../../lib/exports/export.types.js';
import { ExportsService } from '../../lib/exports/exports.service.js';
import { ADDRESS_ENTITY } from './address-book.constants.js';
import type { AddressExportQuery, AddressListQuery, AddressStatusDto, SaveAddressDto } from './dto/address-book.dto.js';

type Row = AddressBookEntry & { _count: { forms: number; submissions: number } };

/** What an address is saved with, after the checks. */
interface CleanAddress {
  name: string;
  department: string;
  street: string;
  houseNumber: string;
  houseNumberSuffix: string;
  box: string;
  boxKind: string;
  postalCode: string;
  city: string;
  country: string;
  category: string;
  note: string;
}

const POSTCODE_NL = /^(\d{4})\s?([A-Za-z]{2})$/;
const BOX_WORD: Record<string, { nl: string; en: string }> = { po_box: { nl: 'Postbus', en: 'P.O. Box' }, freepost: { nl: 'Antwoordnummer', en: 'Freepost' } };

/** The lines of an address as they are written on an envelope. A street address gets "Straat 12a", a box "Postbus 9048"; the country follows when it is not the Netherlands. */
export function addressLines(entry: Pick<AddressBookEntry, 'name' | 'department' | 'street' | 'houseNumber' | 'houseNumberSuffix' | 'box' | 'boxKind' | 'postalCode' | 'city' | 'country'>, locale: AppLocale = 'nl'): string[] {
  const number = [entry.houseNumber.trim(), entry.houseNumberSuffix.trim()].filter(Boolean).join('');
  const where = entry.box.trim() ? `${(BOX_WORD[entry.boxKind] ?? BOX_WORD.po_box!)[locale]} ${entry.box.trim()}` : [entry.street.trim(), number].filter(Boolean).join(' ');
  const country = entry.country && entry.country !== 'NL' ? new Intl.DisplayNames([locale], { type: 'region' }).of(entry.country) : '';
  return [entry.name.trim(), entry.department.trim(), where, [entry.postalCode.trim(), entry.city.trim()].filter(Boolean).join(' '), country ?? ''].filter(Boolean);
}

/**
 * The address book: the people and offices the office sends post to (the tax office, banks …). An address is entered once; a form of the library suggests its recipient
 * and an envelope label is printed from it. Addresses are switched off, never deleted, because the log of sent forms keeps pointing at them.
 */
@Injectable()
export class AddressBookService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly exports: ExportsService,
  ) {}

  view(row: Row, locale: AppLocale = 'nl') {
    return {
      id: row.id,
      name: row.name,
      department: row.department,
      street: row.street,
      houseNumber: row.houseNumber,
      houseNumberSuffix: row.houseNumberSuffix,
      box: row.box,
      boxKind: row.boxKind,
      postalCode: row.postalCode,
      city: row.city,
      country: row.country,
      category: row.category,
      note: row.note,
      lines: addressLines(row, locale),
      isActive: row.isActive,
      forms: row._count.forms,
      sent: row._count.submissions,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private where(query: Pick<AddressListQuery, 'search' | 'category' | 'status'>): Prisma.AddressBookEntryWhereInput {
    const terms = fold(query.search ?? '').split(' ').filter(Boolean);
    const status = query.status ?? 'active';
    return {
      ...(status !== 'all' && { isActive: status === 'active' }),
      ...(query.category && { category: query.category }),
      ...(terms.length && { AND: terms.map(term => ({ searchText: { contains: term } })) }),
    };
  }

  async list(query: AddressListQuery, locale: AppLocale): Promise<ApiResult> {
    const where = this.where(query);
    const orderBy = toOrderBy(query.sort, ['name', 'city', 'category', 'createdAt'], [{ sortOrder: 'asc' }, { name: 'asc' }]) as Prisma.AddressBookEntryOrderByWithRelationInput[];
    const [total, rows, counts] = await Promise.all([
      this.prisma.addressBookEntry.count({ where }),
      this.prisma.addressBookEntry.findMany({ where, orderBy, include: { _count: { select: { forms: true, submissions: true } } }, ...toSkipTake(query) }),
      query.stats ? this.prisma.addressBookEntry.groupBy({ by: ['isActive'], where: this.where({ search: query.search, category: query.category, status: 'all' }), _count: { _all: true } }) : Promise.resolve(null),
    ]);
    return paged(
      rows.map(row => this.view(row, locale)),
      pageMeta(total, query, counts ? { counts: { active: counts.find(row => row.isActive)?._count._all ?? 0, inactive: counts.find(row => !row.isActive)?._count._all ?? 0 } } : {}),
    );
  }

  async rowOrThrow(id: string): Promise<Row> {
    const row = await this.prisma.addressBookEntry.findUnique({ where: { id }, include: { _count: { select: { forms: true, submissions: true } } } });
    if (!row) throw new NotFoundException({ code: 'not_found', message: 'Address not found' });
    return row;
  }

  async one(id: string, locale: AppLocale) {
    return this.view(await this.rowOrThrow(id), locale);
  }

  /** Checks and tidies what was typed; the problems are named per field. */
  private async clean(dto: SaveAddressDto): Promise<CleanAddress> {
    const text = (value: string | undefined) => (value ?? '').trim();
    const problems: Record<string, string> = {};
    const name = text(dto.name);
    if (!name) problems.name = 'validation.required';
    const country = (dto.country ?? 'NL').toUpperCase();
    const box = text(dto.box);
    const street = text(dto.street);
    const houseNumber = text(dto.houseNumber);
    if (!box && !street) problems.street = 'validation.required';
    if (!box && street && !houseNumber) problems.houseNumber = 'validation.required';
    const city = text(dto.city);
    if (!city) problems.city = 'validation.required';
    let postalCode = text(dto.postalCode);
    if (country === 'NL') {
      const match = POSTCODE_NL.exec(postalCode);
      if (!match) problems.postalCode = postalCode ? 'validation.invalidPostcode' : 'validation.required';
      else postalCode = `${match[1]} ${match[2]!.toUpperCase()}`;
    } else if (!postalCode) problems.postalCode = 'validation.required';
    const category = text(dto.category) || 'other';
    if (!(await this.prisma.listItem.findFirst({ where: { code: category, isActive: true, list: { key: 'address_category' } }, select: { id: true } }))) problems.category = 'validation.selectOption';
    if (Object.keys(problems).length) throw validationFailed(problems);
    return {
      name,
      department: text(dto.department),
      street: box ? '' : street,
      houseNumber: box ? '' : houseNumber,
      houseNumberSuffix: box ? '' : text(dto.houseNumberSuffix),
      box,
      boxKind: box ? (dto.boxKind ?? 'po_box') : 'po_box',
      postalCode,
      city,
      country,
      category,
      note: text(dto.note),
    };
  }

  private searchText(values: CleanAddress): string {
    const pieces = [values.name, values.department, values.street, values.houseNumber, values.box, values.postalCode, values.postalCode.replace(/\s+/g, ''), values.city, values.note];
    return [...new Set(pieces.map(fold).filter(Boolean))].join(' ');
  }

  private async assertNew(values: CleanAddress, exceptId?: string): Promise<void> {
    const same = await this.prisma.addressBookEntry.findFirst({
      where: { name: { equals: values.name, mode: 'insensitive' }, postalCode: values.postalCode, box: values.box, street: { equals: values.street, mode: 'insensitive' }, houseNumber: values.houseNumber, houseNumberSuffix: values.houseNumberSuffix, ...(exceptId && { id: { not: exceptId } }) },
      select: { id: true, name: true },
    });
    if (same) throw new ConflictException({ code: 'address_duplicate', message: `${same.name} is in the address book already.`, details: { id: same.id, name: same.name } });
  }

  async create(dto: SaveAddressDto, user: AuthenticatedUser, locale: AppLocale) {
    const values = await this.clean(dto);
    await this.assertNew(values);
    const count = await this.prisma.addressBookEntry.count();
    const row = await this.prisma.addressBookEntry.create({ data: { ...values, sortOrder: (count + 1) * 10, searchText: this.searchText(values), createdById: user.id } });
    await this.audit.log({ action: 'created', entityType: ADDRESS_ENTITY, entityId: row.id, entityLabel: row.name, after: values });
    return this.one(row.id, locale);
  }

  async update(id: string, dto: SaveAddressDto, user: AuthenticatedUser, locale: AppLocale) {
    const row = await this.rowOrThrow(id);
    const values = await this.clean(dto);
    await this.assertNew(values, id);
    const before = Object.fromEntries(Object.keys(values).map(key => [key, (row as unknown as Record<string, unknown>)[key]]));
    const diff = AuditService.changes(before, { ...values });
    if (!Object.keys(diff.after).length) return this.view(row, locale);
    await this.prisma.addressBookEntry.update({ where: { id }, data: { ...values, searchText: this.searchText(values) } });
    await this.audit.log({ action: 'updated', entityType: ADDRESS_ENTITY, entityId: id, entityLabel: values.name, before: diff.before, after: diff.after });
    return this.one(id, locale);
  }

  /** Switches an address on or off (it stays for the forms and the log that point at it). */
  async setStatus(id: string, dto: AddressStatusDto, user: AuthenticatedUser, locale: AppLocale) {
    const row = await this.rowOrThrow(id);
    if (row.isActive === dto.isActive) return this.view(row, locale);
    await this.prisma.addressBookEntry.update({
      where: { id },
      data: dto.isActive ? { isActive: true, deactivatedAt: null, deactivatedById: null } : { isActive: false, deactivatedAt: new Date(), deactivatedById: user.id },
    });
    await this.audit.log({ action: dto.isActive ? 'activated' : 'deactivated', entityType: ADDRESS_ENTITY, entityId: id, entityLabel: row.name, ...(dto.reason?.trim() && { meta: { reason: dto.reason.trim() } }) });
    return this.one(id, locale);
  }

  /** The addresses a list shows, as a table for Excel, PDF or Word. */
  async exportTable(query: AddressExportQuery, locale: AppLocale): Promise<ExportTable> {
    const where = this.where(query);
    this.exports.assertSize(await this.prisma.addressBookEntry.count({ where }));
    const rows = await this.prisma.addressBookEntry.findMany({ where, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], include: { _count: { select: { forms: true, submissions: true } } } });
    const categories = await this.prisma.listItem.findMany({ where: { list: { key: 'address_category' } }, select: { code: true, nameNl: true, nameEn: true } });
    const nl = locale === 'nl';
    const categoryName = new Map(categories.map(item => [item.code, nl ? item.nameNl : item.nameEn]));
    return {
      title: nl ? 'Adresboek' : 'Address book',
      locale,
      columns: [
        { key: 'name', header: nl ? 'Naam' : 'Name', width: 32 },
        { key: 'department', header: nl ? 'Afdeling' : 'Department', width: 22 },
        { key: 'address', header: nl ? 'Adres' : 'Address', width: 30 },
        { key: 'postalCode', header: nl ? 'Postcode' : 'Postal code', width: 11 },
        { key: 'city', header: nl ? 'Plaats' : 'City', width: 18 },
        { key: 'category', header: nl ? 'Soort' : 'Kind', width: 16 },
        { key: 'sent', header: nl ? 'Verstuurd' : 'Sent', type: 'number', width: 10 },
        { key: 'active', header: nl ? 'Actief' : 'Active', type: 'boolean', width: 8 },
      ],
      rows: rows.map(row => {
        const lines = addressLines(row, locale);
        const number = [row.houseNumber, row.houseNumberSuffix].filter(Boolean).join('');
        return {
          name: row.name,
          department: row.department,
          address: row.box ? lines.find(line => line.endsWith(row.box)) ?? '' : [row.street, number].filter(Boolean).join(' '),
          postalCode: row.postalCode,
          city: row.city,
          category: categoryName.get(row.category) ?? row.category,
          sent: row._count.submissions,
          active: row.isActive,
        };
      }),
    };
  }
}
