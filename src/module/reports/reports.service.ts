import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { validationFailed } from '../../common/validation/failure.js';
import { Prisma, type ExportPreset } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import type { ExportFormat, ExportTable } from '../../lib/exports/export.types.js';
import { matrixAllows } from '../roles/permission-catalog.js';
import type { CreatePresetDto, UpdatePresetDto } from './dto/reports.dto.js';
import { ReportsCatalogService } from './reports-catalog.service.js';
import type { ReportDefinition, ReportOutput } from './reports.types.js';

export const PRESET_ENTITY = 'export_preset';
/** The most rows a report shows on screen (a person narrows it down, or exports it: files hold everything). */
const SCREEN_ROWS = 2000;
const MAX_PARAM_LENGTH = 100;

const COLUMN_ALIGN = new Set(['number', 'money']);

/**
 * The reports centre: the catalog of reports a person may open, running one on screen (a summary, a chart and the table) and as a file (Excel, PDF or Word), and the saved
 * export presets. A report is a table: what is on screen is exactly what is in the file.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly catalog: ReportsCatalogService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /* ── Which reports ────────────────────────────────────────────────────────────────────────────────────────────── */

  private allowed(definition: ReportDefinition, user: AuthenticatedUser): boolean {
    return matrixAllows(user.matrix, 'reports.view') && [definition.area, ...(definition.alsoNeeds ?? [])].every(area => matrixAllows(user.matrix, `${area}.view`));
  }

  private definitionOrThrow(key: string, user: AuthenticatedUser): ReportDefinition {
    const definition = this.catalog.definitions().find(entry => entry.key === key);
    if (!definition) throw new NotFoundException({ code: 'not_found', message: 'Report not found' });
    if (!this.allowed(definition, user)) throw new ForbiddenException({ code: 'forbidden', message: 'You do not have access to this report.' });
    return definition;
  }

  /** The reports this person may open, with the inputs each one asks for. */
  list(user: AuthenticatedUser, locale: AppLocale) {
    return this.catalog
      .definitions()
      .filter(definition => this.allowed(definition, user))
      .map(definition => ({ key: definition.key, group: definition.group, title: definition.names[locale], description: definition.descriptions[locale], params: definition.params.map(param => this.catalog.localizeParam(param, locale)) }));
  }

  /* ── Running ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  /** The inputs that belong to the report, as text, with the defaults filled in; anything else in the query is ignored. */
  private cleanParams(definition: ReportDefinition, query: Record<string, unknown>): Record<string, string> {
    const wanted = new Set(definition.params.map(param => param.key));
    if (definition.params.some(param => param.type === 'period')) {
      wanted.add('from');
      wanted.add('to');
    }
    const values: Record<string, string> = {};
    for (const param of definition.params) if ((param.type === 'select' || param.type === 'period') && param.default !== undefined) values[param.key] = param.default;
    for (const [key, value] of Object.entries(query)) {
      if (!wanted.has(key) || typeof value !== 'string') continue;
      const text = value.trim().slice(0, MAX_PARAM_LENGTH);
      if (text) values[key] = text;
      else delete values[key];
    }
    return values;
  }

  private async execute(definition: ReportDefinition, params: Record<string, string>, user: AuthenticatedUser, locale: AppLocale, format: ExportFormat | 'screen'): Promise<ReportOutput> {
    return definition.run({ params, user, locale, format });
  }

  /** The report for the screen: summary, chart, columns and rows. */
  async run(key: string, query: Record<string, unknown>, user: AuthenticatedUser, locale: AppLocale) {
    const definition = this.definitionOrThrow(key, user);
    const params = this.cleanParams(definition, query);
    const { table, summary, chart } = await this.execute(definition, params, user, locale, 'screen');
    const nl = locale === 'nl';
    return {
      key: definition.key,
      group: definition.group,
      title: definition.names[locale],
      description: definition.descriptions[locale],
      params: definition.params.map(param => this.catalog.localizeParam(param, locale)),
      values: params,
      generatedAt: new Date().toISOString(),
      subtitle: table.subtitle ?? '',
      summary: summary ?? [{ label: nl ? 'Rijen' : 'Rows', value: table.rows.length, format: 'number' }],
      columns: table.columns.map(column => ({ id: column.key, header: column.header, type: column.type ?? 'text', ...(COLUMN_ALIGN.has(column.type ?? '') && { align: 'end' }) })),
      rows: table.rows.slice(0, SCREEN_ROWS).map((row, index) => ({ ...row, id: String(index) })),
      total: table.rows.length,
      truncated: table.rows.length > SCREEN_ROWS,
      chart: chart ?? null,
    };
  }

  /** The report as a table ready to be written as a file: with the preset applied when one is asked for. */
  async fileTable(key: string, query: Record<string, unknown>, user: AuthenticatedUser, locale: AppLocale): Promise<{ table: ExportTable; format: ExportFormat }> {
    const definition = this.definitionOrThrow(key, user);
    let source = query;
    let columns: string[] = [];
    let format: ExportFormat | undefined;
    const presetId = typeof query.preset === 'string' ? query.preset : undefined;
    if (presetId) {
      const preset = await this.presetOrThrow(presetId);
      if (preset.reportKey !== key) throw validationFailed({ preset: 'validation.invalid' });
      source = { ...this.presetParams(preset), ...query };
      columns = preset.columns;
      format = preset.format as ExportFormat;
    }
    const params = this.cleanParams(definition, source);
    const wanted = (typeof query.format === 'string' ? query.format : format ?? 'xlsx') as ExportFormat;
    const { table } = await this.execute(definition, params, user, locale, wanted);
    if (typeof query.columns === 'string' && query.columns) columns = query.columns.split(',').map(part => part.trim()).filter(Boolean);
    const kept = columns.length ? table.columns.filter(column => columns.includes(column.key)) : table.columns;
    return { table: { ...table, columns: kept.length ? kept : table.columns }, format: wanted };
  }

  /* ── Presets ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  private presetParams(preset: ExportPreset): Record<string, string> {
    const stored = (preset.params ?? {}) as Record<string, unknown>;
    const params: Record<string, string> = Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    if (preset.period !== 'none') params.period = preset.period;
    return params;
  }

  private async presetOrThrow(id: string): Promise<ExportPreset> {
    const preset = await this.prisma.exportPreset.findUnique({ where: { id } });
    if (!preset) throw new NotFoundException({ code: 'not_found', message: 'Preset not found' });
    return preset;
  }

  private presetView(preset: ExportPreset) {
    return { id: preset.id, name: preset.name, reportKey: preset.reportKey, format: preset.format, period: preset.period, params: this.presetParams(preset), columns: preset.columns, createdAt: preset.createdAt.toISOString() };
  }

  /** The presets of the reports this person may open (all of them, or one report's). */
  async presets(user: AuthenticatedUser, reportKey?: string) {
    const rows = await this.prisma.exportPreset.findMany({ where: reportKey ? { reportKey } : {}, orderBy: [{ reportKey: 'asc' }, { name: 'asc' }] });
    const open = new Set(this.catalog.definitions().filter(definition => this.allowed(definition, user)).map(definition => definition.key));
    return rows.filter(row => open.has(row.reportKey)).map(row => this.presetView(row));
  }

  private checkPreset(input: { name?: string; period?: string; params?: Record<string, unknown>; columns?: string[] }, definition: ReportDefinition | undefined): { params: Record<string, string>; problems: Record<string, string> } {
    const problems: Record<string, string> = {};
    if (input.name !== undefined && !input.name.trim()) problems.name = 'validation.required';
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.params ?? {})) {
      if (typeof value !== 'string' || value.length > MAX_PARAM_LENGTH) problems.params = 'validation.invalid';
      else if (value) params[key] = value;
    }
    if (definition && input.params) {
      const known = new Set([...definition.params.map(param => param.key), 'from', 'to']);
      for (const key of Object.keys(params)) if (!known.has(key) || key === 'period') delete params[key];
    }
    return { params, problems };
  }

  async createPreset(dto: CreatePresetDto, user: AuthenticatedUser) {
    const definition = this.definitionOrThrow(dto.reportKey, user);
    const { params, problems } = this.checkPreset(dto, definition);
    if (!dto.name.trim()) problems.name = 'validation.required';
    if (Object.keys(problems).length) throw validationFailed(problems);
    const created = await this.prisma.exportPreset.create({
      data: { name: dto.name.trim(), reportKey: dto.reportKey, format: dto.format ?? 'xlsx', period: dto.period ?? 'none', params: params as Prisma.InputJsonObject, columns: dto.columns ?? [], createdById: user.id },
    });
    await this.audit.log({ action: 'created', entityType: PRESET_ENTITY, entityId: created.id, entityLabel: created.name, after: this.presetView(created) });
    return this.presetView(created);
  }

  async updatePreset(id: string, dto: UpdatePresetDto, user: AuthenticatedUser) {
    const preset = await this.presetOrThrow(id);
    const definition = this.definitionOrThrow(preset.reportKey, user);
    const { params, problems } = this.checkPreset(dto, definition);
    if (Object.keys(problems).length) throw validationFailed(problems);
    const updated = await this.prisma.exportPreset.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name.trim() }),
        ...(dto.format !== undefined && { format: dto.format }),
        ...(dto.period !== undefined && { period: dto.period }),
        ...(dto.params !== undefined && { params: params as Prisma.InputJsonObject }),
        ...(dto.columns !== undefined && { columns: dto.columns }),
      },
    });
    const diff = AuditService.changes(this.presetView(preset) as unknown as Record<string, unknown>, this.presetView(updated) as unknown as Record<string, unknown>);
    if (Object.keys(diff.after).length) await this.audit.log({ action: 'updated', entityType: PRESET_ENTITY, entityId: id, entityLabel: updated.name, before: diff.before, after: diff.after });
    return this.presetView(updated);
  }

  async removePreset(id: string, user: AuthenticatedUser) {
    const preset = await this.presetOrThrow(id);
    this.definitionOrThrow(preset.reportKey, user);
    await this.prisma.exportPreset.delete({ where: { id } });
    await this.audit.log({ action: 'deleted', entityType: PRESET_ENTITY, entityId: id, entityLabel: preset.name, before: this.presetView(preset) });
    return { id };
  }
}
