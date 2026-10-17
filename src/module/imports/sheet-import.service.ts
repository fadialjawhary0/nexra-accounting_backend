import { ConflictException, Injectable, UnprocessableEntityException, UnsupportedMediaTypeException } from '@nestjs/common';
import { isValidDay } from '../../common/dates.js';
import { fold } from '../../common/text.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { validationFailed } from '../../common/validation/failure.js';
import type { ImportJob } from '../../generated/prisma/client.js';
import { AiService } from '../../lib/ai/ai.service.js';
import { AiError } from '../../lib/ai/ai.types.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { DocumentsService } from '../../lib/documents/documents.service.js';
import { QueueService } from '../../lib/queue/queue.service.js';
import { SettingsService } from '../../lib/settings/settings.service.js';
import { canEditField } from '../forms/field-access.js';
import { extensionOf } from '../files/files.constants.js';
import { FilesService } from '../files/files.service.js';
import { MappingsService } from './mappings.service.js';
import type { SheetQuery, SheetSetupDto } from './dto/imports.dto.js';
import { IMPORTS_NAMESPACE, IMPORT_FILE_PURPOSE, QUEUE_SHEET, SHEET_PREVIEW_ROWS, SHEET_TARGETS, type DuplicatePolicy, type SheetTarget } from './imports.constants.js';
import { ImportsService } from './imports.service.js';
import { ItemDataService } from './item-data.service.js';
import { autoMap, applySaved, normalizeHeader, type MappingColumn, type TargetField } from './sheet-mapping.js';
import { detectHeaderRow, headersOf, readSheets, type RawSheet } from './sheet-reader.js';
import { cellText, isBlank, parseDutchDate } from './value-coercion.js';

/** Everything an import of a spreadsheet remembers about how to read it (stored in the job's options). */
export interface SheetSetup {
  target: SheetTarget;
  sheet: string;
  headerRow: number;
  mapping: MappingColumn[];
  duplicates: DuplicatePolicy;
  stopped: boolean;
  clientId: string | null;
  defaults: Record<string, unknown>;
  layout: 'list' | 'grid';
  weekStart: string | null;
  personRole: string | null;
}

const SHEET_EXTENSIONS = new Set(['xlsx', 'xls', 'ods', 'csv', 'txt']);
/** Parsed workbooks are kept for a little while: the wizard asks for the same sheet many times. */
const KEEP_PARSED_MS = 10 * 60_000;
const KEEP_PARSED_COUNT = 4;

/** The fixed fields of the hours import (a sheet of hours is not a form). */
const HOURS_FIELDS = ['worker', 'client', 'date', 'hours', 'start', 'end', 'break', 'workplace', 'note'] as const;

const WEEKDAYS: Array<[string, number]> = [
  ['ma', 0], ['maandag', 0], ['mon', 0], ['monday', 0],
  ['di', 1], ['dinsdag', 1], ['tue', 1], ['tuesday', 1],
  ['wo', 2], ['woensdag', 2], ['wed', 2], ['wednesday', 2],
  ['do', 3], ['donderdag', 3], ['thu', 3], ['thursday', 3],
  ['vr', 4], ['vrijdag', 4], ['fri', 4], ['friday', 4],
  ['za', 5], ['zaterdag', 5], ['sat', 5], ['saturday', 5],
  ['zo', 6], ['zondag', 6], ['sun', 6], ['sunday', 6],
];

const special = (field: string, section: string): TargetField => ({ field, section, labels: { nl: '', en: '' }, type: 'composite', required: false, special: true });

/** A column heading that is a day of the week ("ma", "Dinsdag 03-03") → 0 (Monday) … 6; `null` otherwise. */
export function weekdayOf(header: string): number | null {
  const word = fold(header).replace(/[^a-z]/g, ' ').trim().split(' ')[0] ?? '';
  return WEEKDAYS.find(([name]) => name === word)?.[1] ?? null;
}

/**
 * Setting up the import of a spreadsheet: the file is uploaded and read (an old `.xls` is converted first), the person chooses the sheet, the row of
 * the headings and what the rows are (clients, workers or hours), and the columns are matched with the fields of the forms — suggested from a saved
 * layout or from the headings, never silently. Nothing is read into records here; the rows are checked and saved by the next steps.
 */
@Injectable()
export class SheetImportService {
  private readonly parsed = new Map<string, { at: number; sheets: RawSheet[] }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly files: FilesService,
    private readonly documents: DocumentsService,
    private readonly settings: SettingsService,
    private readonly mappings: MappingsService,
    private readonly imports: ImportsService,
    private readonly data: ItemDataService,
    private readonly ai: AiService,
    private readonly queue: QueueService,
  ) {}

  /* ── Upload ───────────────────────────────────────────────────────────────────────────────────────────────────── */

  async upload(upload: Express.Multer.File | undefined, user: AuthenticatedUser) {
    if (!upload) throw new UnprocessableEntityException({ code: 'file_missing', message: 'Choose a file to upload.' });
    // The browser sends the name as latin1 bytes; turn it back into the text the person saw.
    let name = Buffer.from(upload.originalname, 'latin1').toString('utf8').replace(/[\\/]/g, '_').slice(0, 150);
    let extension = extensionOf(name);
    if (!SHEET_EXTENSIONS.has(extension)) throw new UnsupportedMediaTypeException({ code: 'file_type_not_allowed', message: 'Upload an Excel or CSV file.' });
    let bytes = upload.buffer;
    if (extension === 'xls' || extension === 'ods') {
      const converted = await this.documents.toModernFormat(bytes, extension);
      if (!converted) throw new UnprocessableEntityException({ code: 'import_sheet_convert_failed', message: 'This old Excel file could not be opened. Save it as .xlsx or .csv and try again.' });
      bytes = converted;
      name = `${name.replace(/\.[^.]+$/, '')}.xlsx`;
      extension = 'xlsx';
    }
    const sheets = await readSheets(bytes, extension === 'xlsx' ? 'xlsx' : 'csv', name);
    const first = sheets[0]!;
    const stored = await this.files.store(bytes, { name, purpose: IMPORT_FILE_PURPOSE, userId: user.id });
    const job = await this.prisma.importJob.create({
      data: { kind: 'spreadsheet', name: name.slice(0, 150), status: 'draft', fileId: stored.id, options: { sheet: first.name, headerRow: detectHeaderRow(first.rows) }, createdById: user.id },
    });
    this.keep(stored.id, sheets);
    await this.audit.log({ action: 'created', entityType: 'import', entityId: job.id, entityLabel: job.name, after: { kind: job.kind, sheets: sheets.length } });
    return this.imports.get(job.id);
  }

  private keep(fileId: string, sheets: RawSheet[]): void {
    this.parsed.set(fileId, { at: Date.now(), sheets });
    for (const [key, entry] of this.parsed) if (Date.now() - entry.at > KEEP_PARSED_MS) this.parsed.delete(key);
    while (this.parsed.size > KEEP_PARSED_COUNT) this.parsed.delete(this.parsed.keys().next().value!);
  }

  /** The sheets of the job's file (read again when they are no longer remembered). */
  async sheets(job: ImportJob): Promise<RawSheet[]> {
    const hit = job.fileId ? this.parsed.get(job.fileId) : undefined;
    if (hit) return hit.sheets;
    if (!job.fileId) throw new UnprocessableEntityException({ code: 'file_missing', message: 'This import has no file.' });
    const { file, buffer } = await this.files.bytes(job.fileId);
    const extension = extensionOf(file.name);
    const sheets = await readSheets(buffer, extension === 'xlsx' ? 'xlsx' : 'csv', file.name);
    this.keep(job.fileId, sheets);
    return sheets;
  }

  /* ── The fields a column can be read into ─────────────────────────────────────────────────────────────────────── */

  /** Every field a column of this target can fill: the fields of the forms, address and name columns that hold several values, and the fixed fields of an hours sheet. */
  async targetFields(target: SheetTarget, user: AuthenticatedUser): Promise<Array<TargetField & { blocked: boolean }>> {
    const docs = await this.data.docs();
    const fromForm = (section: 'client' | 'person' | 'employee'): Array<TargetField & { blocked: boolean }> =>
      (docs[section]?.fields ?? [])
        .filter(field => field.active && field.type !== 'file')
        .map(field => ({ field: `${section}.${field.key}`, section, labels: field.labels, type: field.type, required: field.required && field.locked, blocked: !canEditField(field, user.matrix) }));
    const plain = (fields: TargetField[]) => fields.map(field => ({ ...field, blocked: false }));
    switch (target) {
      case 'client':
        return [...fromForm('client'), ...plain([special('client.@address', 'client'), special('client.@postcode_city', 'client')]), ...fromForm('person'), ...plain([special('person.@full_name', 'person'), special('person.@address', 'person')])];
      case 'employee':
        return [...fromForm('employee'), ...fromForm('person'), ...plain([special('person.@full_name', 'person'), special('person.@address', 'person')])];
      case 'hours':
        return plain(HOURS_FIELDS.map(key => ({ ...special(`hours.${key}`, 'hours'), type: 'composite' as const, required: key === 'worker' })));
    }
  }

  /** `hours.day:2026-03-02` / `hours.weekday:0` are valid for the hours of a grid (a column per day). */
  private isDayField(field: string): boolean {
    return /^hours\.day:\d{4}-\d{2}-\d{2}$/.test(field) || /^hours\.weekday:[0-6]$/.test(field);
  }

  /* ── What the wizard shows ────────────────────────────────────────────────────────────────────────────────────── */

  async analyse(jobId: string, query: SheetQuery, user: AuthenticatedUser) {
    const job = await this.sheetJob(jobId);
    const sheets = await this.sheets(job);
    const options = (job.options ?? {}) as Partial<SheetSetup>;
    const sheet = sheets.find(entry => entry.name === (query.sheet ?? options.sheet)) ?? sheets[0]!;
    const headerRow = Math.min(query.headerRow ?? (sheet.name === options.sheet ? options.headerRow : undefined) ?? detectHeaderRow(sheet.rows), Math.max(0, sheet.rows.length - 1));
    const headers = headersOf(sheet.rows, headerRow);
    const body = sheet.rows.slice(headerRow + 1);
    const rowCount = body.filter(row => row.some(cell => !isBlank(cell))).length;
    const sample = body.slice(0, SHEET_PREVIEW_ROWS).map(row => headers.map((_header, column) => cellText(row[column])));

    const target = query.target ?? options.target ?? (await this.suggestTarget(headers, user));
    const fields = await this.targetFields(target, user);
    const grid = target === 'hours' ? this.gridColumns(headers) : null;
    const layout = options.layout ?? (grid && grid.length >= 5 ? 'grid' : 'list');

    let suggestedBy: 'job' | 'saved' | 'headers';
    let savedMapping: { id: string; name: string; options: Record<string, unknown> } | null = null;
    let columns: Array<string | null>;
    const sameShape = options.target === target && options.sheet === sheet.name && options.headerRow === headerRow && options.mapping?.length;
    if (sameShape) {
      suggestedBy = 'job';
      columns = headers.map((_header, index) => options.mapping!.find(entry => entry.index === index)?.field ?? null);
    } else {
      const chosen = query.mappingId ? await this.prisma.importMapping.findFirst({ where: { id: query.mappingId, target, isActive: true } }) : null;
      const saved = chosen ? { mapping: chosen, score: 1 } : await this.mappings.best(target, headers);
      if (saved) {
        suggestedBy = 'saved';
        savedMapping = { id: saved.mapping.id, name: saved.mapping.name, options: (saved.mapping.options ?? {}) as Record<string, unknown> };
        const known = new Set(fields.map(field => field.field));
        const fromSaved = applySaved(headers, (saved.mapping.columns as Array<{ header: string; field: string | null }>) ?? []).map(field => (field && (known.has(field) || this.isDayField(field)) ? field : field === undefined ? undefined : null));
        // A heading the saved layout does not know (a column added since) is matched by its name, among the fields the layout left free.
        const used = new Set(fromSaved.filter((field): field is string => Boolean(field)));
        const rest = autoMap(headers, fields.filter(field => !used.has(field.field)), target);
        columns = fromSaved.map((field, index) => (field === undefined ? (rest[index] ?? null) : field));
      } else {
        suggestedBy = 'headers';
        columns = autoMap(headers, fields, target);
      }
      if (target === 'hours' && layout === 'grid' && grid) for (const day of grid) if (!columns[day.index]) columns[day.index] = day.field;
    }
    return {
      sheets: sheets.map(entry => ({ name: entry.name, rows: entry.rows.length })),
      sheet: sheet.name,
      headerRow,
      headers,
      sample,
      rowCount,
      target,
      fields,
      mapping: headers.map((header, index) => ({ index, header, field: columns[index] ?? null })),
      suggestedBy,
      savedMapping,
      saved: (await this.mappings.ranked(target, headers)).filter(entry => entry.score > 0).slice(0, 8).map(entry => ({ id: entry.mapping.id, name: entry.mapping.name, score: Math.round(entry.score * 100) / 100, options: (entry.mapping.options ?? {}) as Record<string, unknown> })),
      layout,
      dayColumns: grid ?? [],
      setup: this.setupOf(job),
      aiMapping: this.ai.isEnabled('mapping'),
    };
  }

  /** The columns of a sheet of hours that are days: a date in the heading, or a weekday name. */
  private gridColumns(headers: readonly string[]): Array<{ index: number; field: string; label: string }> {
    const columns: Array<{ index: number; field: string; label: string }> = [];
    headers.forEach((header, index) => {
      const date = parseDutchDate(header.trim());
      if (date) columns.push({ index, field: `hours.day:${date}`, label: date });
      else {
        const weekday = weekdayOf(header);
        if (weekday !== null && header.trim().length <= 12) columns.push({ index, field: `hours.weekday:${weekday}`, label: header });
      }
    });
    return columns;
  }

  /** What the rows probably are, from how well the headings fit each kind of record. */
  private async suggestTarget(headers: readonly string[], user: AuthenticatedUser): Promise<SheetTarget> {
    let best: SheetTarget = 'client';
    let bestScore = -1;
    for (const target of SHEET_TARGETS) {
      const fields = await this.targetFields(target, user);
      const score = autoMap(headers, fields, target).filter(Boolean).length + (target === 'hours' ? Math.min(3, this.gridColumns(headers).length) : 0);
      if (score > bestScore) {
        best = target;
        bestScore = score;
      }
    }
    return best;
  }

  /* ── The setup ────────────────────────────────────────────────────────────────────────────────────────────────── */

  setupOf(job: ImportJob): SheetSetup | null {
    const options = (job.options ?? {}) as Partial<SheetSetup>;
    return options.target && options.mapping ? (options as SheetSetup) : null;
  }

  async saveSetup(jobId: string, dto: SheetSetupDto, user: AuthenticatedUser) {
    const job = await this.sheetJob(jobId);
    const sheets = await this.sheets(job);
    const sheet = sheets.find(entry => entry.name === dto.sheet);
    const problems: Record<string, string> = {};
    if (!sheet) problems.sheet = 'validation.selectOption';
    if (sheet && dto.headerRow >= sheet.rows.length) problems.headerRow = 'validation.invalid';
    const fields = await this.targetFields(dto.target, user);
    const known = new Map(fields.map(field => [field.field, field]));

    const used = new Set<string>();
    const mapping: MappingColumn[] = [];
    for (const column of dto.mapping) {
      const field = column.field;
      if (field) {
        const definition = known.get(field);
        if (!definition && !(dto.target === 'hours' && this.isDayField(field))) problems[`mapping.${column.index}`] = 'validation.selectOption';
        else if (definition?.blocked) problems[`mapping.${column.index}`] = 'imports.fieldForbidden';
        else if (used.has(field)) problems[`mapping.${column.index}`] = 'imports.fieldTwice';
        used.add(field);
      }
      mapping.push({ index: column.index, header: column.header, field });
    }
    const has = (field: string) => used.has(field);
    const anyDay = [...used].some(field => this.isDayField(field));
    const layout = dto.layout ?? 'list';
    if (dto.target === 'client' && !has('client.name')) problems['mapping.required'] = 'imports.nameRequired';
    if (dto.target === 'employee') {
      if (!has('person.@full_name') && !(has('person.first_name') && has('person.last_name'))) problems['mapping.required'] = 'imports.workerNameRequired';
      if (!has('employee.client') && !dto.clientId) problems.clientId = 'imports.clientRequired';
    }
    if (dto.target === 'hours') {
      if (!has('hours.worker')) problems['mapping.required'] = 'imports.workerColumnRequired';
      else if (layout === 'list' && !(has('hours.date') && (has('hours.hours') || (has('hours.start') && has('hours.end'))))) problems['mapping.hours'] = 'imports.hoursColumnsRequired';
      else if (layout === 'grid' && !anyDay) problems['mapping.hours'] = 'imports.dayColumnsRequired';
      if (layout === 'grid' && [...used].some(field => field.startsWith('hours.weekday:')) && !(dto.weekStart && isValidDay(dto.weekStart))) problems.weekStart = 'validation.invalidDate';
      if (!has('hours.client') && !dto.clientId) problems.clientId = 'imports.clientRequired';
    }
    if (dto.clientId && !(await this.prisma.client.findUnique({ where: { id: dto.clientId }, select: { id: true } }))) problems.clientId = 'validation.invalid';
    for (const field of Object.keys(dto.defaults ?? {})) {
      const definition = known.get(field);
      if (!definition || definition.special) problems[`defaults.${field}`] = 'validation.selectOption';
      else if (definition.blocked) problems[`defaults.${field}`] = 'imports.fieldForbidden';
    }
    if (Object.keys(problems).length) throw validationFailed(problems);

    const setup: SheetSetup = {
      target: dto.target,
      sheet: dto.sheet,
      headerRow: dto.headerRow,
      mapping,
      duplicates: dto.duplicates ?? this.settings.get<DuplicatePolicy>(`${IMPORTS_NAMESPACE}.duplicates`),
      stopped: dto.stopped ?? false,
      clientId: dto.clientId ?? null,
      defaults: dto.defaults ?? {},
      layout,
      weekStart: dto.weekStart ?? null,
      personRole: dto.personRole ?? null,
    };
    // A changed setup makes the rows that were checked before out of date.
    await this.prisma.$transaction([
      this.prisma.importItem.deleteMany({ where: { jobId } }),
      this.prisma.importJob.update({ where: { id: jobId }, data: { target: dto.target, status: 'draft', activity: null, note: '', options: setup as unknown as object } }),
    ]);
    if (dto.saveAs?.trim()) {
      await this.mappings.remember(dto.target, dto.saveAs, mapping.map(column => ({ header: column.header, field: column.field })), { headerRow: dto.headerRow, stopped: setup.stopped, duplicates: setup.duplicates, layout, defaults: setup.defaults }, user.id);
    }
    await this.audit.log({ action: 'updated', entityType: 'import', entityId: jobId, entityLabel: job.name, meta: { target: dto.target, columns: mapping.filter(column => column.field).length } });
    return this.imports.get(jobId);
  }

  /** Reads the rows and checks them (in the background): the result is the list of rows with what is wrong with them. */
  async check(jobId: string) {
    const job = await this.sheetJob(jobId);
    if (!this.setupOf(job)) throw new UnprocessableEntityException({ code: 'import_no_setup', message: 'Set up the columns first.' });
    this.imports.assertQueue();
    await this.prisma.importJob.update({ where: { id: jobId }, data: { status: 'processing', activity: 'checking', note: '', startedAt: new Date() } });
    await this.queue.send(QUEUE_SHEET, { jobId, step: 'check' });
    return this.imports.get(jobId);
  }

  /** Saves the rows that are ready (in the background). */
  async commit(jobId: string, user: AuthenticatedUser) {
    const job = await this.sheetJob(jobId);
    if (job.status !== 'ready') throw new ConflictException({ code: 'import_not_ready', message: 'Check the rows first.' });
    const ready = await this.prisma.importItem.count({ where: { jobId, status: 'ready' } });
    if (!ready) throw new UnprocessableEntityException({ code: 'import_nothing_ready', message: 'There are no rows to save.' });
    this.imports.assertQueue();
    await this.prisma.importJob.update({ where: { id: jobId }, data: { status: 'processing', activity: 'committing', options: { ...((job.options ?? {}) as object), runBy: user.id } } });
    await this.queue.send(QUEUE_SHEET, { jobId, step: 'commit' });
    await this.audit.log({ action: 'committed', entityType: 'import', entityId: jobId, entityLabel: job.name, meta: { rows: ready } });
    return this.imports.get(jobId);
  }

  /* ── The AI's suggestion for the columns (only the headings go to it) ─────────────────────────────────────────── */

  async suggest(jobId: string, query: SheetQuery, user: AuthenticatedUser) {
    const job = await this.sheetJob(jobId);
    const sheets = await this.sheets(job);
    const options = (job.options ?? {}) as Partial<SheetSetup>;
    const sheet = sheets.find(entry => entry.name === (query.sheet ?? options.sheet)) ?? sheets[0]!;
    const headerRow = query.headerRow ?? (sheet.name === options.sheet ? options.headerRow : undefined) ?? detectHeaderRow(sheet.rows);
    const headers = headersOf(sheet.rows, headerRow);
    const target = query.target ?? options.target ?? (await this.suggestTarget(headers, user));
    const fields = (await this.targetFields(target, user)).filter(field => !field.blocked);
    const keys = fields.map(field => field.field);

    const list = fields.map(field => `- ${field.field}: ${field.labels.en || field.labels.nl || field.field}${field.labels.nl && field.labels.en !== field.labels.nl ? ` (${field.labels.nl})` : ''}`).join('\n');
    const result = await this.ai
      .extract<{ columns: Array<{ heading: string; field: string; confidence: number }> }>({
        feature: 'mapping',
        tier: 'light',
        instructions: 'A Dutch accounting office has a spreadsheet. For each column heading, say which field it holds, or "none" when it holds none of them. Use each field at most once. Judge only by the heading.',
        text: `Spreadsheet headings, in order:\n${headers.map((header, index) => `${index + 1}. ${header}`).join('\n')}\n\nFields:\n${list}`,
        schemaName: 'column_mapping',
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['columns'],
          properties: {
            columns: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['heading', 'field', 'confidence'],
                properties: { heading: { type: 'string' }, field: { type: 'string', enum: [...keys, 'none'] }, confidence: { type: 'number', description: 'How sure you are, 0 to 100' } },
              },
            },
          },
        },
        maxOutputTokens: 3000,
        userId: user.id,
      })
      .catch((error: unknown) => {
        // The AI being off, out of budget or unreachable is something the person can read and act on, not a server error.
        if (error instanceof AiError) throw new UnprocessableEntityException({ code: error.code, message: 'The AI could not suggest the columns.' });
        throw error;
      });
    const used = new Set<string>();
    const mapping = headers.map((header, index) => {
      const answer = result.data.columns.find(entry => normalizeHeader(entry.heading) === normalizeHeader(header) && !used.has(entry.field));
      const field = answer && answer.field !== 'none' && keys.includes(answer.field) ? answer.field : null;
      if (field) used.add(field);
      return { index, header, field, confidence: field && answer ? Math.min(1, Math.max(0, answer.confidence / 100)) : 0 };
    });
    return { target, mapping };
  }

  /* ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  private async sheetJob(jobId: string): Promise<ImportJob> {
    const job = await this.imports.findOrThrow(jobId);
    if (job.kind !== 'spreadsheet') throw new ConflictException({ code: 'import_not_spreadsheet', message: 'This import is not a spreadsheet.' });
    return job;
  }
}
