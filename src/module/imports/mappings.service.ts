import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { validationFailed } from '../../common/validation/failure.js';
import type { ImportMapping, Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import type { SaveMappingDto, UpdateMappingDto } from './dto/imports.dto.js';
import type { SheetTarget } from './imports.constants.js';
import { headerOverlap, normalizeHeader, type SavedColumn } from './sheet-mapping.js';

/** A saved layout must look this much like a sheet (the share of headings they have in common) before it is suggested for it. */
const SUGGEST_FROM = 0.6;

const json = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;
const asColumns = (value: unknown): SavedColumn[] => (Array.isArray(value) ? (value as SavedColumn[]).filter(column => column && typeof column.header === 'string') : []);

export const serializeMapping = (row: ImportMapping) => ({
  id: row.id,
  name: row.name,
  target: row.target as SheetTarget,
  columns: asColumns(row.columns),
  options: (row.options ?? {}) as Record<string, unknown>,
  isSystem: row.isSystem,
  isActive: row.isActive,
  updatedAt: row.updatedAt.toISOString(),
});

/**
 * The column layouts of the office's spreadsheets, remembered by their headings: the next sheet with the same headings is read with the same
 * mapping, whatever the order of its columns. The mappings that ship with the system (the `KLANTEN` layout) cannot be removed, only switched off.
 */
@Injectable()
export class MappingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(target?: SheetTarget) {
    const rows = await this.prisma.importMapping.findMany({ where: { ...(target && { target }) }, orderBy: [{ isSystem: 'desc' }, { name: 'asc' }] });
    return rows.map(serializeMapping);
  }

  /** The active mappings of this target, the ones that look most like these headings first (and how much they look like them, 0–1). */
  async ranked(target: SheetTarget, headers: readonly string[]) {
    const rows = await this.prisma.importMapping.findMany({ where: { target, isActive: true } });
    return rows
      .map(mapping => ({ mapping, score: headerOverlap(headers, asColumns(mapping.columns).map(column => column.header)) }))
      .sort((a, b) => b.score - a.score || a.mapping.name.localeCompare(b.mapping.name));
  }

  /** The mapping that looks enough like these headings to be suggested, when one does. */
  async best(target: SheetTarget, headers: readonly string[]): Promise<{ mapping: ImportMapping; score: number } | null> {
    const [first] = await this.ranked(target, headers);
    return first && first.score >= SUGGEST_FROM ? first : null;
  }

  async create(dto: SaveMappingDto, userId: string) {
    const name = dto.name.trim();
    if (!name) throw validationFailed({ name: 'validation.required' });
    const columns = this.columnsOf(dto.columns);
    const existing = await this.prisma.importMapping.findUnique({ where: { target_name: { target: dto.target, name } } });
    if (existing) throw new ConflictException({ code: 'mapping_exists', message: 'A mapping with this name exists already.', fields: { name: 'validation.alreadyExists' } });
    const row = await this.prisma.importMapping.create({
      data: { name, target: dto.target, headers: columns.map(column => normalizeHeader(column.header)), columns: json(columns), options: json(dto.options ?? {}), createdById: userId },
    });
    await this.audit.log({ action: 'created', entityType: 'import_mapping', entityId: row.id, entityLabel: `${row.target}: ${row.name}`, after: { columns: columns.length } });
    return serializeMapping(row);
  }

  /** Saves a mapping under a name: a new one, or the one with this name replaced (the setup of an import has a "remember this layout" choice). */
  async remember(target: SheetTarget, name: string, columns: SavedColumn[], options: Record<string, unknown>, userId: string) {
    const clean = this.columnsOf(columns);
    const row = await this.prisma.importMapping.upsert({
      where: { target_name: { target, name: name.trim() } },
      create: { name: name.trim(), target, headers: clean.map(column => normalizeHeader(column.header)), columns: json(clean), options: json(options), createdById: userId },
      update: { headers: clean.map(column => normalizeHeader(column.header)), columns: json(clean), options: json(options), isActive: true },
    });
    await this.audit.log({ action: 'updated', entityType: 'import_mapping', entityId: row.id, entityLabel: `${row.target}: ${row.name}`, meta: { columns: clean.length } });
    return serializeMapping(row);
  }

  async update(id: string, dto: UpdateMappingDto) {
    const row = await this.findOrThrow(id);
    if (row.isSystem && (dto.name !== undefined || dto.columns !== undefined)) throw new ForbiddenException({ code: 'mapping_system', message: 'A mapping that comes with the system can only be switched off.' });
    const columns = dto.columns ? this.columnsOf(dto.columns) : null;
    const name = dto.name?.trim();
    if (name && name !== row.name && (await this.prisma.importMapping.findUnique({ where: { target_name: { target: row.target, name } } }))) {
      throw new ConflictException({ code: 'mapping_exists', message: 'A mapping with this name exists already.', fields: { name: 'validation.alreadyExists' } });
    }
    const updated = await this.prisma.importMapping.update({
      where: { id },
      data: {
        ...(name && { name }),
        ...(columns && { columns: json(columns), headers: columns.map(column => normalizeHeader(column.header)) }),
        ...(dto.options && { options: json(dto.options) }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
    });
    await this.audit.log({ action: dto.isActive === undefined ? 'updated' : dto.isActive ? 'activated' : 'deactivated', entityType: 'import_mapping', entityId: id, entityLabel: `${updated.target}: ${updated.name}` });
    return serializeMapping(updated);
  }

  async remove(id: string) {
    const row = await this.findOrThrow(id);
    if (row.isSystem) throw new ForbiddenException({ code: 'mapping_system', message: 'A mapping that comes with the system can only be switched off.' });
    await this.prisma.importMapping.delete({ where: { id } });
    await this.audit.log({ action: 'deleted', entityType: 'import_mapping', entityId: id, entityLabel: `${row.target}: ${row.name}` });
    return { id };
  }

  private async findOrThrow(id: string): Promise<ImportMapping> {
    const row = await this.prisma.importMapping.findUnique({ where: { id } });
    if (!row) throw new NotFoundException({ code: 'not_found', message: 'Mapping not found' });
    return row;
  }

  private columnsOf(columns: ReadonlyArray<{ header: string; field: string | null }>): SavedColumn[] {
    return columns.filter(column => column.header.trim()).map(column => ({ header: column.header.trim(), field: column.field }));
  }
}
