import { HttpException, Injectable, Logger } from '@nestjs/common';
import { addDays, isValidDay, parseDay, todayInAmsterdam } from '../../common/dates.js';
import { asRecord } from '../../common/record-values.js';
import { fold } from '../../common/text.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import type { ImportItem, ImportJob, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { ClientPeopleService } from '../clients/client-people.service.js';
import { ClientsService } from '../clients/clients.service.js';
import { EmployeesService } from '../employees/employees.service.js';
import { isEmptyValue, type FieldDef, type FormDoc } from '../forms/form-doc.js';
import { FormRecordsService } from '../forms/form-records.service.js';
import { FormValidationService } from '../forms/form-validation.service.js';
import { HoursService } from '../hours/hours.service.js';
import { PeopleService } from '../people/people.service.js';
import { matrixAllows } from '../roles/permission-catalog.js';
import { failureOf } from './document-accept.service.js';
import { DocumentMatcherService, nameTokens, type WorkerRef } from './document-matcher.service.js';
import { ImportActorService } from './import-actor.service.js';
import { ImportLookupsService } from './import-lookups.service.js';
import { type ItemResult, type ItemSections, type ItemWarning } from './imports.constants.js';
import { ImportsService } from './imports.service.js';
import { ItemDataService } from './item-data.service.js';
import { splitAddress, splitFullName, splitPostcodeCity } from './sheet-composites.js';
import { SheetImportService, type SheetSetup } from './sheet-import.service.js';
import { cellText, coerce, isBlank, parseDuration, parseDutchDate, type CoerceContext } from './value-coercion.js';

/** What checking one row of the sheet found: what it would do, and what is wrong with it. */
export interface RowResult {
  status: 'ready' | 'invalid' | 'skipped';
  action: 'create' | 'update' | 'skip';
  data: ItemSections;
  errors: Record<string, string>;
  warnings: ItemWarning[];
  summary: string;
  clientId: string | null;
  employeeId: string | null;
  personId: string | null;
  message: string;
}

/** One day of a row of hours. */
export interface HoursDay {
  date: string;
  minutes: number | null;
  start: string | null;
  end: string | null;
  break_minutes: number | null;
  note: string | null;
  workplace: string | null;
  /** The day has hours already and the import replaces them. */
  replace?: boolean;
}

const BATCH = 100;
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const warn = (code: string, level: ItemWarning['level'], field?: string, params?: ItemWarning['params']): ItemWarning => ({ code, level, ...(field && { field }), ...(params && { params }) });
const prefixed = (section: string, errors: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(errors).map(([key, message]) => [`${section}.${key}`, message]));
const personLabel = (values: Record<string, unknown>): string => [values.first_name, values.infix, values.last_name].map(text).filter(Boolean).join(' ');
const defsOf = (docs: Record<string, FormDoc>): Record<string, Map<string, FieldDef>> => Object.fromEntries(Object.entries(docs).map(([section, doc]) => [section, new Map(doc.fields.filter(field => field.active).map(field => [field.key, field]))]));

/** The clock time in a cell: an Excel time (a fraction of a day, or a date with a time), or "07:30" text. */
function clockOf(raw: unknown): string | null {
  const minutes = typeof raw === 'string' && /^\d{1,2}[:.]\d{2}$/.test(raw.trim()) ? Number(raw.trim().slice(0, raw.trim().length - 3)) * 60 + Number(raw.trim().slice(-2)) : raw instanceof Date ? raw.getUTCHours() * 60 + raw.getUTCMinutes() : typeof raw === 'number' && raw > 0 && raw < 1 ? Math.round(raw * 1440) : null;
  return minutes === null ? null : `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

const clockMinutes = (value: string | null): number | null => {
  const match = /^(\d{2}):(\d{2})$/.exec(value ?? '');
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

/** A break written in a sheet: `0:30`, `30` (minutes) or `0,5` (hours). */
function breakMinutes(raw: unknown): number | null {
  if (isBlank(raw)) return null;
  if (typeof raw === 'string' && raw.includes(':')) return parseDuration(raw);
  const value = typeof raw === 'number' ? raw : Number(String(raw).replace(',', '.'));
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value <= 4 ? value * 60 : value);
}

/**
 * The rows of an imported spreadsheet: reading each row into values (Dutch dates and numbers, "ja / nee", pick-list names, an address in one
 * column), checking them with the same forms and rules the screens use — against what exists already, with the policy the person chose for
 * duplicates — and, after the person agreed, saving them through the same services as a click would.
 */
@Injectable()
export class SheetRowsService {
  private readonly logger = new Logger(SheetRowsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly imports: ImportsService,
    private readonly sheetImport: SheetImportService,
    private readonly actors: ImportActorService,
    private readonly lookups: ImportLookupsService,
    private readonly data: ItemDataService,
    private readonly validation: FormValidationService,
    private readonly records: FormRecordsService,
    private readonly matcher: DocumentMatcherService,
    private readonly clients: ClientsService,
    private readonly clientPeople: ClientPeopleService,
    private readonly people: PeopleService,
    private readonly employees: EmployeesService,
    private readonly hours: HoursService,
  ) {}

  /* ── Reading a row ────────────────────────────────────────────────────────────────────────────────────────────── */

  /** The cells of a row as typed values per record; what a cell holds that does not fit its field is an error on that field (and stays visible). */
  private readRow(row: unknown[], setup: SheetSetup, defs: Record<string, Map<string, FieldDef>>, context: CoerceContext): { raw: ItemSections; errors: Record<string, string>; warnings: ItemWarning[]; filled: boolean } {
    const raw: ItemSections = {};
    const errors: Record<string, string> = {};
    const warnings: ItemWarning[] = [];
    const direct = new Set(setup.mapping.filter(column => column.field && !column.field.includes('.@')).map(column => column.field));
    const put = (section: string, key: string, value: unknown): void => {
      if (direct.has(`${section}.${key}`) && raw[section]?.[key] !== undefined) return;
      (raw[section] ??= {})[key] = value;
    };
    let filled = false;
    for (const column of setup.mapping) {
      if (!column.field) continue;
      const cell = row[column.index];
      if (isBlank(cell)) continue;
      filled = true;
      const dot = column.field.indexOf('.');
      const section = column.field.slice(0, dot);
      const key = column.field.slice(dot + 1);
      if (key.startsWith('@')) {
        const textValue = cellText(cell);
        if (key === '@address') {
          const parts = splitAddress(textValue);
          if (parts) for (const [part, value] of Object.entries(parts)) if (!direct.has(`${section}.${part}`)) put(section, part, value);
        } else if (key === '@postcode_city') {
          const parts = splitPostcodeCity(textValue);
          if (parts) for (const [part, value] of Object.entries(parts)) if (!direct.has(`${section}.${part}`)) put(section, part, value);
          else errors[`${section}.postal_code`] = 'validation.invalidPostcode';
        } else if (key === '@full_name') {
          const parts = splitFullName(textValue);
          if (parts) {
            for (const [part, value] of Object.entries({ first_name: parts.first_name, infix: parts.infix, last_name: parts.last_name })) if (value && !direct.has(`${section}.${part}`)) put(section, part, value);
            if (parts.guessed) warnings.push(warn('name_guessed', 'attention', `${section}.last_name`, { name: textValue }));
          }
        }
        continue;
      }
      const def = defs[section]?.get(key);
      if (!def) continue;
      const result = coerce(def, cell, context);
      if ('error' in result) {
        errors[`${section}.${key}`] = result.error;
        (raw[section] ??= {})[key] = cellText(cell);
      } else if (result.value !== null) {
        (raw[section] ??= {})[key] = result.value;
      }
    }
    for (const [field, value] of Object.entries(setup.defaults)) {
      const dot = field.indexOf('.');
      const section = field.slice(0, dot);
      const key = field.slice(dot + 1);
      const def = defs[section]?.get(key);
      if (!def || raw[section]?.[key] !== undefined || isBlank(value)) continue;
      const result = coerce(def, value, context);
      if (!('error' in result) && result.value !== null) (raw[section] ??= {})[key] = result.value;
    }
    return { raw, errors, warnings, filled };
  }

  /** The values of a form, normalised, with what the form refused kept next to it (so the person sees both). */
  private async check(entity: 'client' | 'person' | 'employee', patch: Record<string, unknown>, existing: Record<string, unknown>, user: AuthenticatedUser): Promise<{ values: Record<string, unknown>; errors: Record<string, string> }> {
    const { values, errors } = await this.validation.check(entity, patch, existing, user.matrix);
    return { values: Object.fromEntries(Object.entries({ ...patch, ...values }).filter(([, value]) => !isEmptyValue(value))), errors: prefixed(entity, errors) };
  }

  /** The values of a row the way the form would store them (`1234ab` → `1234 AB`), so they can be compared with what a record holds. A value the form refuses stays as it was. */
  private async normalised(entity: 'client' | 'person' | 'employee', patch: Record<string, unknown>, user: AuthenticatedUser): Promise<Record<string, unknown>> {
    const { values } = await this.validation.check(entity, patch, {}, user.matrix);
    return Object.fromEntries(Object.entries({ ...patch, ...values }).filter(([, value]) => !isEmptyValue(value)));
  }

  /** What an existing record gets from a row: nothing (`skip`), the empty fields (`fill`) or everything the row has (`overwrite`). */
  private apply(policy: SheetSetup['duplicates'], section: string, row: Record<string, unknown>, existing: Record<string, unknown>, warnings: ItemWarning[]): Record<string, unknown> {
    if (policy === 'skip') return {};
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      const current = existing[key];
      if (policy === 'overwrite' || isEmptyValue(current)) {
        if (!same(current, value)) patch[key] = value;
      } else if (!same(current, value)) {
        warnings.push(warn('kept_current', 'info', `${section}.${key}`, { value: Array.isArray(value) ? value.join(', ') : String(value) }));
      }
    }
    return patch;
  }

  /* ── Checking (in the background) ─────────────────────────────────────────────────────────────────────────────── */

  async runCheck(jobId: string): Promise<void> {
    const job = await this.prisma.importJob.findUnique({ where: { id: jobId } });
    if (!job || job.kind !== 'spreadsheet' || job.status !== 'processing' || job.activity !== 'checking') return;
    const principal = await this.actors.principal(job.createdById);
    if (!principal) return this.imports.fail(jobId, 'draft', 'user_inactive');
    try {
      await this.actors.runAs(principal, () => this.checkAll(job, principal));
      await this.prisma.importJob.update({ where: { id: jobId }, data: { status: 'ready', activity: null } });
      const counts = await this.prisma.importItem.groupBy({ by: ['status'], where: { jobId }, _count: { _all: true } });
      await this.imports.tell(job, 'import.review', { count: counts.filter(entry => entry.status !== 'skipped').reduce((total, entry) => total + entry._count._all, 0) });
    } catch (error) {
      this.logger.error(`Checking import ${jobId} failed: ${(error as Error).message}`);
      await this.imports.fail(jobId, 'draft', 'check_failed');
    }
  }

  private async checkAll(job: ImportJob, principal: AuthenticatedUser): Promise<void> {
    const setup = this.sheetImport.setupOf(job)!;
    const sheets = await this.sheetImport.sheets(job);
    const sheet = sheets.find(entry => entry.name === setup.sheet)!;
    const docs = await this.data.docs();
    const defs = defsOf(docs);
    const context = await this.lookups.context();
    await this.prisma.importItem.deleteMany({ where: { jobId: job.id } });

    const seen = new Map<string, number>();
    const workers = new Map<string, WorkerRef[]>();
    const pending: Prisma.ImportItemCreateManyInput[] = [];
    let order = 0;
    const flush = async () => {
      if (pending.length) await this.prisma.importItem.createMany({ data: pending.splice(0, pending.length) });
    };

    for (const [index, row] of sheet.rows.slice(setup.headerRow + 1).entries()) {
      const rowNumber = setup.headerRow + 2 + index;
      let result: RowResult | null;
      if (setup.target === 'client') {
        const read = this.readRow(row, setup, defs, context);
        result = read.filled ? await this.validateClient(read.raw, read.errors, read.warnings, setup, principal, { action: null, clientId: null, personId: null }, seen, rowNumber) : null;
      } else if (setup.target === 'employee') {
        const read = this.readRow(row, setup, defs, context);
        result = read.filled ? await this.validateEmployee(read.raw, read.errors, read.warnings, setup, principal, { action: null, employeeId: null, personId: null }, workers, seen, rowNumber) : null;
      } else {
        result = await this.readHours(row, setup, context, workers);
      }
      if (!result) continue;
      pending.push({
        jobId: job.id,
        sortOrder: order,
        kind: 'row',
        status: result.status,
        name: String(rowNumber),
        path: setup.sheet,
        action: result.action,
        clientId: result.clientId,
        employeeId: result.employeeId,
        personId: result.personId,
        data: (await this.data.seal(result.data)) as Prisma.InputJsonObject,
        warnings: result.warnings as unknown as Prisma.InputJsonArray,
        errors: result.errors as Prisma.InputJsonObject,
        summary: result.summary.slice(0, 300),
        message: result.message,
      });
      order += 1;
      if (pending.length >= BATCH) await flush();
    }
    await flush();
  }

  /** Clients: a row is a client, with the owner (or director) in the same row. */
  private async validateClient(
    raw: ItemSections,
    cellErrors: Record<string, string>,
    cellWarnings: ItemWarning[],
    setup: SheetSetup,
    user: AuthenticatedUser,
    forced: { action: string | null; clientId: string | null; personId: string | null },
    seen: Map<string, number> | null,
    rowNumber: number,
  ): Promise<RowResult> {
    const docs = await this.data.docs(['client', 'person']);
    const errors: Record<string, string> = { ...cellErrors };
    const warnings = [...cellWarnings];
    const client = { ...asRecord(raw.client) };
    const person = { ...asRecord(raw.person) };
    const personName = personLabel(person);

    // A client the sheet names twice is a mistake in the sheet.
    const keys = [text(client.number) && `n:${fold(text(client.number))}`, text(client.kvk) && `k:${text(client.kvk).replace(/\D/g, '')}`, !text(client.number) && !text(client.kvk) && text(client.name) && `m:${fold(text(client.name))}`].filter(Boolean) as string[];
    if (seen) {
      const earlier = keys.map(key => seen.get(key)).find(value => value !== undefined);
      if (earlier !== undefined) errors['client.number'] = 'imports.duplicateInSheet';
      for (const key of keys) if (!seen.has(key)) seen.set(key, rowNumber);
    }

    // The client that exists already: by the number, the KvK number, or — with neither — the exact name.
    let existingId = forced.clientId;
    if (!existingId) {
      const unique = await this.records.checkUnique('client', null, docs.client!, client, {});
      const holders = [...new Set(Object.values(unique.conflicts))];
      if (holders.length > 1) errors['client.number'] = 'imports.conflictingMatches';
      existingId = holders[0] ?? null;
      if (!existingId && !text(client.number) && !text(client.kvk) && text(client.name)) {
        const named = await this.matcher.clientByExactName(text(client.name));
        existingId = named?.id ?? null;
        if (named) warnings.push(warn('client_from_name', 'info', undefined, { client: `${named.number} – ${named.name}` }));
      }
    }
    const existing = existingId ? await this.clients.values(await this.clients.findOrThrow(existingId)) : {};
    const patch = existingId ? this.apply(setup.duplicates, 'client', await this.normalised('client', client, user), existing, warnings) : client;
    const checked = existingId ? await this.check('client', patch, existing, user) : await this.check('client', { ...patch, number: text(patch.number) || 'auto' }, {}, user);
    if (!existingId) {
      if (checked.values.number === 'auto') delete checked.values.number;
      delete checked.errors['client.number'];
      if (!text(checked.values.number)) warnings.push(warn('number_assigned', 'info'));
    }
    Object.assign(errors, checked.errors);
    if (existingId) for (const key of Object.keys(errors)) if (errors[key] === 'validation.alreadyExists') delete errors[key];

    // The person in the row.
    let personId = forced.personId;
    let personValues: Record<string, unknown> = {};
    if (personName) {
      if (!personId) {
        const holder = await this.matcher.personByBsn(text(person.bsn));
        personId = holder ?? (existingId ? await this.linkedPerson(existingId, person) : null);
        if (personId) warnings.push(warn('person_matched', 'info'));
      }
      const personExisting = personId ? await this.existingPerson(personId) : {};
      const personChecked = await this.check('person', personId ? this.apply(setup.duplicates, 'person', await this.normalised('person', person, user), personExisting, warnings) : person, personExisting, user);
      personValues = personChecked.values;
      Object.assign(errors, personChecked.errors);
      for (const key of Object.keys(errors)) if (key.startsWith('person.') && errors[key] === 'validation.alreadyExists') delete errors[key];
    }

    // A client that exists and has nothing to gain from the row is left alone.
    const unchanged = Boolean(existingId) && !Object.keys(checked.values).length && !Object.keys(personValues).length;
    const action = forced.action === 'skip' ? 'skip' : existingId ? (setup.duplicates === 'skip' || unchanged ? 'skip' : 'update') : 'create';
    const data: ItemSections = { client: checked.values, ...(personName && { person: personValues }) };
    if (action === 'skip') {
      if (forced.action !== 'skip' && existingId) warnings.push(warn('exists', 'info'));
      for (const key of Object.keys(errors)) delete errors[key];
    }
    return {
      status: action === 'skip' ? 'skipped' : Object.keys(errors).length ? 'invalid' : 'ready',
      action,
      data,
      errors,
      warnings,
      summary: [text(checked.values.number) || text(existing.number), text(checked.values.name) || text(existing.name)].filter(Boolean).join(' – '),
      clientId: existingId,
      employeeId: null,
      personId,
      message: action === 'skip' ? (unchanged ? 'unchanged' : 'exists') : '',
    };
  }

  /** The person already linked to this client with the same name (so the row's owner is not added a second time). */
  private async linkedPerson(clientId: string, person: Record<string, unknown>): Promise<string | null> {
    const wanted = nameTokens(personLabel(person));
    if (!wanted.length) return null;
    const links = await this.prisma.clientPerson.findMany({ where: { clientId }, include: { person: { select: { id: true, firstName: true, lastName: true } } } });
    const found = links.filter(link => {
      const tokens = nameTokens(`${link.person.firstName} ${link.person.lastName}`);
      return tokens.length > 0 && tokens.every(token => wanted.includes(token)) && wanted.every(token => tokens.includes(token));
    });
    return found.length === 1 ? found[0]!.person.id : null;
  }

  private async existingPerson(personId: string): Promise<Record<string, unknown>> {
    const person = await this.people.findOrThrow(personId);
    return { ...this.records.decode(asRecord(person.data)), first_name: person.firstName, last_name: person.lastName };
  }

  /** Workers: a row is a person with their employment at a client. */
  private async validateEmployee(
    raw: ItemSections,
    cellErrors: Record<string, string>,
    cellWarnings: ItemWarning[],
    setup: SheetSetup,
    user: AuthenticatedUser,
    forced: { action: string | null; employeeId: string | null; personId: string | null },
    workers: Map<string, WorkerRef[]>,
    seen: Map<string, number> | null,
    rowNumber: number,
  ): Promise<RowResult> {
    const errors: Record<string, string> = { ...cellErrors };
    const warnings = [...cellWarnings];
    const employee = { ...asRecord(raw.employee) };
    const person = { ...asRecord(raw.person) };
    if (!text(employee.client) && setup.clientId) employee.client = setup.clientId;
    const clientId = text(employee.client) || null;
    if (!clientId && !errors['employee.client']) errors['employee.client'] = 'validation.required';

    let personId = forced.personId;
    let employeeId = forced.employeeId;
    if (!personId) personId = await this.matcher.personByBsn(text(person.bsn));
    if (clientId && !employeeId) {
      const list = workers.get(clientId) ?? (await this.matcher.workersOf(clientId));
      workers.set(clientId, list);
      if (personId) employeeId = list.find(worker => worker.personId === personId)?.employeeId ?? null;
      else {
        const found = await this.matcher.workerByName(clientId, personLabel(person), list);
        if (found === 'ambiguous') warnings.push(warn('worker_ambiguous', 'attention', undefined, { name: personLabel(person) }));
        else if (found) {
          employeeId = found.employeeId;
          personId = found.personId;
          warnings.push(warn('worker_matched', 'info', undefined, { worker: found.name }));
        }
      }
    }
    if (seen) {
      const key = `${clientId ?? ''}|${text(person.bsn) || fold(personLabel(person))}`;
      if (seen.has(key)) errors['person.last_name'] = 'imports.duplicateInSheet';
      else seen.set(key, rowNumber);
    }

    const existingEmployee = employeeId ? await this.prisma.employee.findUnique({ where: { id: employeeId }, select: { clientId: true, startDate: true, endDate: true, functionCode: true, data: true } }) : null;
    const existingValues: Record<string, unknown> = existingEmployee
      ? { ...this.records.decode(asRecord(existingEmployee.data)), client: existingEmployee.clientId, ...(existingEmployee.functionCode && { function: existingEmployee.functionCode }), ...(existingEmployee.startDate && { start_date: existingEmployee.startDate.toISOString().slice(0, 10) }), ...(existingEmployee.endDate && { end_date: existingEmployee.endDate.toISOString().slice(0, 10) }) }
      : {};
    const employeePatch = employeeId ? this.apply(setup.duplicates, 'employee', await this.normalised('employee', employee, user), existingValues, warnings) : employee;
    const checkedEmployee = await this.check('employee', employeePatch, existingValues, user);
    Object.assign(errors, checkedEmployee.errors);

    const personExisting = personId ? await this.existingPerson(personId) : {};
    const personPatch = personId ? this.apply(setup.duplicates, 'person', await this.normalised('person', person, user), personExisting, warnings) : person;
    const checkedPerson = await this.check('person', personPatch, personExisting, user);
    Object.assign(errors, checkedPerson.errors);
    for (const key of Object.keys(errors)) if (errors[key] === 'validation.alreadyExists' && (personId || employeeId)) delete errors[key];

    const unchanged = Boolean(employeeId) && !Object.keys(checkedEmployee.values).length && !Object.keys(checkedPerson.values).length;
    const action = forced.action === 'skip' ? 'skip' : employeeId ? (setup.duplicates === 'skip' || unchanged ? 'skip' : 'update') : 'create';
    if (action === 'skip') for (const key of Object.keys(errors)) delete errors[key];
    return {
      status: action === 'skip' ? 'skipped' : Object.keys(errors).length ? 'invalid' : 'ready',
      action,
      data: { employee: checkedEmployee.values, person: checkedPerson.values },
      errors,
      warnings,
      summary: personLabel(checkedPerson.values) || personLabel(personExisting),
      clientId,
      employeeId,
      personId,
      message: action === 'skip' ? (unchanged ? 'unchanged' : 'exists') : '',
    };
  }

  /* ── Hours ────────────────────────────────────────────────────────────────────────────────────────────────────── */

  /** A row of hours: one day (list) or a week of days (grid) of one worker. */
  private async readHours(row: unknown[], setup: SheetSetup, context: CoerceContext, workers: Map<string, WorkerRef[]>): Promise<RowResult | null> {
    const column = (field: string) => setup.mapping.find(entry => entry.field === field);
    const cell = (field: string) => {
      const entry = column(field);
      return entry ? row[entry.index] : null;
    };
    const workerName = cellText(cell('hours.worker'));
    const dayColumns = setup.mapping.filter(entry => entry.field && (entry.field.startsWith('hours.day:') || entry.field.startsWith('hours.weekday:')));
    if (!workerName && !dayColumns.some(entry => !isBlank(row[entry.index]))) return null;
    if (!workerName) return null;

    const errors: Record<string, string> = {};
    const warnings: ItemWarning[] = [];
    // The client of the row: its own column, or the one chosen for the whole sheet.
    let clientId = setup.clientId;
    const clientCell = cell('hours.client');
    if (!isBlank(clientCell)) {
      const wanted = fold(cellText(clientCell));
      const found = context.clientsByNumber.get(wanted) ?? (context.clientsByName.get(wanted)?.length === 1 ? context.clientsByName.get(wanted)![0] : undefined);
      if (found) clientId = found;
      else errors['hours.client'] = 'imports.clientUnknown';
    }

    const days: HoursDay[] = [];
    const entry = (date: string, minutes: number | null, start: string | null, end: string | null, pause: number | null): HoursDay => ({
      date,
      minutes: minutes ?? (clockMinutes(start) !== null && clockMinutes(end) !== null ? ((clockMinutes(end)! - clockMinutes(start)! + 1440) % 1440) - (pause ?? 0) : null),
      start,
      end,
      break_minutes: pause,
      note: text(cellText(cell('hours.note'))) || null,
      workplace: text(cellText(cell('hours.workplace'))) || null,
    });
    if (setup.layout === 'grid') {
      for (const entryColumn of dayColumns) {
        const value = row[entryColumn.index];
        if (isBlank(value)) continue;
        const field = entryColumn.field!;
        const date = field.startsWith('hours.day:') ? field.slice('hours.day:'.length) : setup.weekStart ? addDays(setup.weekStart, Number(field.slice('hours.weekday:'.length))) : null;
        const minutes = parseDuration(value);
        if (!date) continue;
        if (minutes === null) errors[`hours.${date}`] = 'imports.noHours';
        else if (minutes > 0) days.push(entry(date, minutes, null, null, null));
      }
    } else {
      const date = parseDutchDate(cell('hours.date'));
      if (!date) errors['hours.date'] = 'validation.invalidDate';
      const start = clockOf(cell('hours.start'));
      const end = clockOf(cell('hours.end'));
      const minutes = isBlank(cell('hours.hours')) ? null : parseDuration(cell('hours.hours'));
      if (!isBlank(cell('hours.hours')) && minutes === null) errors['hours.hours'] = 'imports.noHours';
      if (date) days.push(entry(date, minutes, start, end, breakMinutes(cell('hours.break'))));
    }
    const today = todayInAmsterdam();
    for (const day of days) {
      if (!isValidDay(day.date) || day.date < '2000-01-01' || day.date > addDays(today, 366)) errors[`hours.${day.date}`] = 'validation.invalidDate';
      else if (day.minutes === null || day.minutes < 1 || day.minutes > 1440) errors[`hours.${day.date}`] = 'imports.noHours';
    }
    if (!days.length && !Object.keys(errors).length) return null;

    // The worker.
    let employeeId: string | null = null;
    let personId: string | null = null;
    let known = clientId ? workers.get(clientId) : undefined;
    if (clientId && !known) {
      known = await this.matcher.workersOf(clientId);
      workers.set(clientId, known);
    }
    const found = clientId ? await this.matcher.workerByName(clientId, workerName, known) : await this.matcher.workerAnywhere(workerName);
    if (found === 'ambiguous') errors['hours.worker'] = 'imports.workerAmbiguous';
    else if (!found) errors['hours.worker'] = 'imports.workerUnknown';
    else {
      employeeId = found.employeeId;
      personId = found.personId;
    }

    // Days that have hours already are left alone (unless the person chose to overwrite).
    let kept = days;
    if (employeeId && days.length) {
      const dates = days.map(day => parseDay(day.date));
      const present = new Set((await this.prisma.hourEntry.findMany({ where: { employeeId, date: { in: dates } }, select: { date: true } })).map(entry => entry.date.toISOString().slice(0, 10)));
      if (present.size) {
        if (setup.duplicates === 'overwrite') kept = days.map(day => (present.has(day.date) ? { ...day, replace: true } : day));
        else {
          kept = days.filter(day => !present.has(day.date));
          warnings.push(warn('days_exist', 'info', undefined, { count: present.size }));
        }
      }
    }
    const action = kept.length || Object.keys(errors).length ? 'create' : 'skip';
    const total = kept.reduce((sum, day) => sum + (day.minutes ?? 0), 0);
    return {
      status: action === 'skip' ? 'skipped' : Object.keys(errors).length ? 'invalid' : 'ready',
      action,
      data: { hours: { worker_name: workerName, employee_id: employeeId, entries: kept } as unknown as Record<string, unknown> },
      errors,
      warnings,
      // Days and hours with their international symbols (d, h), so the line reads the same in Dutch and English.
      summary: `${workerName} · ${kept.length} d · ${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')} h`,
      clientId: clientId ?? null,
      employeeId,
      personId,
      message: action === 'skip' ? 'exists' : '',
    };
  }

  /* ── After an edit in the review ──────────────────────────────────────────────────────────────────────────────── */

  /** A row after a person changed its values (or chose another worker, or to skip it): checked again, without reading the sheet. */
  async revalidate(item: ImportItem, job: ImportJob, user: AuthenticatedUser, change: { data?: ItemSections; action?: string | null; employeeId?: string | null; personId?: string | null; clientId?: string | null }): Promise<RowResult> {
    const setup = this.sheetImport.setupOf(job)!;
    const current = this.data.open(item.data);
    const raw = change.data ? ItemDataService.merge(current, change.data) : current;
    const action = change.action === undefined ? item.action : change.action;
    if (setup.target === 'client') {
      return this.validateClient(raw, {}, [], setup, user, { action: action === 'skip' ? 'skip' : null, clientId: change.clientId === undefined ? item.clientId : change.clientId, personId: change.personId === undefined ? item.personId : change.personId }, null, 0);
    }
    if (setup.target === 'employee') {
      return this.validateEmployee(raw, {}, [], setup, user, { action: action === 'skip' ? 'skip' : null, employeeId: change.employeeId === undefined ? item.employeeId : change.employeeId, personId: change.personId === undefined ? item.personId : change.personId }, new Map(), null, 0);
    }
    // Hours: the worker may be chosen by hand; the days stay as they were read.
    const hours = asRecord(raw.hours);
    const employeeId = change.employeeId === undefined ? item.employeeId : change.employeeId;
    const errors: Record<string, string> = {};
    const entries = Array.isArray(hours.entries) ? (hours.entries as HoursDay[]) : [];
    if (!employeeId) errors['hours.worker'] = 'imports.workerUnknown';
    for (const entry of entries) if (!entry.minutes || entry.minutes < 1 || entry.minutes > 1440) errors[`hours.${entry.date}`] = 'imports.noHours';
    return {
      status: action === 'skip' ? 'skipped' : Object.keys(errors).length ? 'invalid' : 'ready',
      action: action === 'skip' ? 'skip' : 'create',
      data: { hours: { ...hours, employee_id: employeeId } },
      errors: action === 'skip' ? {} : errors,
      warnings: [],
      summary: item.summary,
      clientId: item.clientId,
      employeeId,
      personId: item.personId,
      message: '',
    };
  }

  /* ── Saving (in the background) ───────────────────────────────────────────────────────────────────────────────── */

  async runCommit(jobId: string): Promise<void> {
    const job = await this.prisma.importJob.findUnique({ where: { id: jobId } });
    if (!job || job.kind !== 'spreadsheet' || job.status !== 'processing' || job.activity !== 'committing') return;
    const runBy = text(asRecord(job.options).runBy) || job.createdById;
    const principal = (await this.actors.principal(runBy)) ?? (await this.actors.principal(job.createdById));
    if (!principal) return this.imports.fail(jobId, 'ready', 'user_inactive');
    try {
      await this.actors.runAs(principal, () => this.commitAll(job, principal));
    } catch (error) {
      this.logger.error(`Saving import ${jobId} failed: ${(error as Error).message}`);
      await this.imports.fail(jobId, 'ready', 'commit_failed');
      return;
    }
    const [accepted, failed] = await Promise.all([this.prisma.importItem.count({ where: { jobId, status: 'accepted' } }), this.prisma.importItem.count({ where: { jobId, status: 'error' } })]);
    await this.prisma.importJob.update({ where: { id: jobId }, data: { status: 'done', activity: null, finishedAt: new Date() } });
    await this.imports.tell(job, 'import.done', { done: accepted, failed });
  }

  private async commitAll(job: ImportJob, user: AuthenticatedUser): Promise<void> {
    const setup = this.sheetImport.setupOf(job)!;
    for (;;) {
      const batch = await this.prisma.importItem.findMany({ where: { jobId: job.id, status: 'ready' }, orderBy: { sortOrder: 'asc' }, take: BATCH });
      if (!batch.length) break;
      for (const item of batch) {
        const results: ItemResult[] = [];
        try {
          if (setup.target === 'client') await this.commitClient(item, setup, user, results);
          else if (setup.target === 'employee') await this.commitEmployee(item, setup, user, results);
          else await this.commitHours(item, user, results);
          await this.imports.saveItem(item.id, { status: 'accepted', result: results, message: '', errors: {}, reviewedById: user.id });
        } catch (error) {
          const failure = failureOf(error, setup.target === 'client' ? 'client' : setup.target === 'employee' ? 'employee' : 'hours');
          await this.imports.saveItem(item.id, { status: 'error', result: results, message: failure.message, errors: failure.errors });
        }
      }
    }
  }

  private require(user: AuthenticatedUser, capability: string): void {
    if (!matrixAllows(user.matrix, capability)) throw new HttpException({ code: 'forbidden', message: 'You do not have access to this.' }, 403);
  }

  private async commitClient(item: ImportItem, setup: SheetSetup, user: AuthenticatedUser, results: ItemResult[]): Promise<void> {
    const sections = this.data.open(item.data);
    const values = asRecord(sections.client);
    const person = asRecord(sections.person);
    let clientId = item.clientId;
    if (item.action === 'create' || !clientId) {
      this.require(user, 'clients.create');
      const created = await this.clients.create({ values }, user);
      clientId = created.id;
      await this.prisma.importItem.update({ where: { id: item.id }, data: { clientId } });
      results.push({ type: 'client', id: created.id, action: 'created', label: `${created.number} – ${created.name}` });
      if (setup.stopped) await this.clients.setStatus(created.id, { status: 'stopped', reason: 'import' }, user);
    } else if (Object.keys(values).length) {
      this.require(user, 'clients.edit');
      await this.clients.update(clientId, { values }, user);
      results.push({ type: 'client', id: clientId, action: 'updated' });
    }
    if (personLabel(person) && clientId) {
      this.require(user, 'clients.edit');
      const legalForm = text(values.legal_form) || text((await this.prisma.client.findUnique({ where: { id: clientId }, select: { legalForm: true } }))?.legalForm);
      const role = setup.personRole ?? (await this.lookups.roleFor(legalForm));
      try {
        const link = await this.clientPeople.add(clientId, item.personId ? { personId: item.personId, role } : { values: person, role }, user);
        results.push({ type: 'person', id: link.person.id, action: item.personId ? 'linked' : 'created' });
      } catch (error) {
        const fields = error instanceof HttpException ? asRecord(asRecord(error.getResponse()).fields) : {};
        if (fields.role !== 'validation.alreadyExists') throw error;
      }
    }
  }

  private async commitEmployee(item: ImportItem, setup: SheetSetup, user: AuthenticatedUser, results: ItemResult[]): Promise<void> {
    const sections = this.data.open(item.data);
    const values = asRecord(sections.employee);
    const person = asRecord(sections.person);
    if (item.action === 'update' && item.employeeId) {
      this.require(user, 'employees.edit');
      await this.employees.update(item.employeeId, { values, person: { values: person } }, user);
      results.push({ type: 'employee', id: item.employeeId, action: 'updated' });
      return;
    }
    this.require(user, 'employees.create');
    if (item.personId && Object.keys(person).length) await this.people.update(item.personId, { values: person }, user);
    const created = await this.employees.create({ values, person: item.personId ? { personId: item.personId } : { values: person } }, user);
    await this.prisma.importItem.update({ where: { id: item.id }, data: { employeeId: created.id } });
    results.push({ type: 'employee', id: created.id, action: 'created' });
    if (setup.stopped) {
      const end = text(values.end_date);
      await this.employees.setStatus(created.id, { status: 'stopped', reason: 'import', ...(isValidDay(end) && { date: end }) }, user);
    }
  }

  private async commitHours(item: ImportItem, user: AuthenticatedUser, results: ItemResult[]): Promise<void> {
    this.require(user, 'hours.create');
    const hours = asRecord(this.data.open(item.data).hours);
    const employeeId = item.employeeId ?? text(hours.employee_id);
    const days = (Array.isArray(hours.entries) ? hours.entries : []) as HoursDay[];
    const failed: Record<string, string> = {};
    const cells: Array<{ employeeId: string; date: string; minutes: number }> = [];
    for (const day of days) {
      if (!day.minutes) continue;
      if (day.start && day.end && !day.replace && !(await this.prisma.hourEntry.count({ where: { employeeId, date: parseDay(day.date) } }))) {
        try {
          await this.hours.create({ employeeId, date: day.date, startTime: day.start, endTime: day.end, breakMinutes: day.break_minutes ?? 0, values: { ...(day.workplace && { workplace: day.workplace }), ...(day.note && { note: day.note }) } }, user, 'import');
        } catch (error) {
          failed[`hours.${day.date}`] = failureOf(error).message;
        }
      } else {
        cells.push({ employeeId, date: day.date, minutes: day.minutes });
      }
    }
    for (let start = 0; start < cells.length; start += 400) {
      for (const outcome of await this.hours.saveCells({ cells: cells.slice(start, start + 400) }, user, 'import')) {
        if (!outcome.ok) failed[`hours.${outcome.date}`] = `imports.hours_${outcome.error ?? 'failed'}`;
      }
    }
    results.push({ type: 'hours', id: employeeId, action: 'created', label: String(days.length - Object.keys(failed).length) });
    if (Object.keys(failed).length) throw new HttpException({ code: 'hours_partly', message: 'Some days could not be saved.', fields: failed }, 422);
  }
}
