import { HttpException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { ApiResult, paged } from '../../common/api-result.js';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import { addDays, daysBetween, formatDay, isValidDay, parseDay, todayInAmsterdam } from '../../common/dates.js';
import { pageMeta, toSkipTake } from '../../common/pagination.js';
import { asRecord, day as dayOf } from '../../common/record-values.js';
import { fold } from '../../common/text.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { validationFailed } from '../../common/validation/failure.js';
import { Prisma, type HourEntry } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import type { ExportTable } from '../../lib/exports/export.types.js';
import { ExportsService } from '../../lib/exports/exports.service.js';
import { SettingsService } from '../../lib/settings/settings.service.js';
import { CalendarService } from '../calendar/calendar.service.js';
import { EmployeeRatesService } from '../employees/employee-rates.service.js';
import { workKindOf } from '../employees/employee-record.js';
import { valuesFor } from '../forms/field-access.js';
import type { FormDoc } from '../forms/form-doc.js';
import { FormRecordsService } from '../forms/form-records.service.js';
import { FormValidationService } from '../forms/form-validation.service.js';
import { FormsService } from '../forms/forms.service.js';
import { personName } from '../people/person-record.js';
import { matrixAllows } from '../roles/permission-catalog.js';
import type { CellDto, CopyWeekDto, CreateEntryDto, EntryExportQuery, EntryListQuery, MonthQuery, RepriceDto, SaveCellsDto, UpdateEntryDto, WeekQuery } from './dto/hours.dto.js';
import { HOUR_ENTRY_ENTITY, HOURS_AREA, HOURS_DEFINITIONS, HOURS_NAMESPACE, MAX_ENTRY_MINUTES, STATEMENTS_AREA } from './hours.constants.js';
import { HoursPayService, hirerNames, whereText } from './hours-pay.service.js';
import { daysOfWeek, firstOfMonth, formatClock, isMonth, lastOfMonth, minutesToHours, mondayOf, parseClock, spanMinutes } from './hours-time.js';
import { PeriodLocksService, type LockBrief, type LockIndex } from './period-locks.service.js';

const WITH_PARTIES = { person: true, client: { select: { id: true, number: true, name: true } } } as const;
type Worker = Prisma.EmployeeGetPayload<{ include: typeof WITH_PARTIES }>;

/** The days hours can be registered for: from the year 2000 to a year ahead. */
const EARLIEST_DAY = '2000-01-01';
const DAYS_AHEAD = 366;
/** Contracts that are in force (or were): a worker is "inside a contract" on the days they cover. */
const SIGNED = ['active', 'ended', 'terminated'];

/** Where an hour entry came from: typed by a person, or read from a spreadsheet (`import`) or a photographed timesheet (`ai`) by an import. */
export type HourSource = 'manual' | 'import' | 'ai';

export interface MonthDay {
  date: string;
  weekend: boolean;
  holiday: { name: string; paid: boolean } | null;
  weekday: number;
  minutes: number;
  entries: Array<ReturnType<typeof entryView>>;
  locked: boolean;
}

export interface CellResult {
  employeeId: string;
  date: string;
  ok: boolean;
  /** The minutes of the day after saving; the sum when the day holds several entries. */
  minutes?: number;
  entries?: number;
  /** `period_locked` · `reason_required` · `multiple_entries` · `invalid_date` · `forbidden` · `not_found`. */
  error?: string;
}

/** What one entry looks like to the screens. `rate` only goes to people who may see what is paid. */
const entryView = (row: HourEntry, doc: FormDoc, matrix: AuthenticatedUser['matrix'], records: FormRecordsService, hirers: Map<string, string>, lock: LockBrief | null, money: boolean) => {
  const values = valuesFor(doc, records.publicValues(asRecord(row.data)), matrix);
  return {
    id: row.id,
    employeeId: row.employeeId,
    clientId: row.clientId,
    date: formatDay(row.date),
    minutes: row.minutes,
    startTime: row.startTime,
    endTime: row.endTime,
    breakMinutes: row.breakMinutes,
    ...(money && { rate: row.rate?.toNumber() ?? null }),
    source: row.source,
    values,
    where: whereText(values, hirers),
    locked: Boolean(lock),
    updatedAt: row.updatedAt.toISOString(),
  };
};

/**
 * Registering hours: the week grid across workers (one cell per worker and day, typed like in Excel), the details of a day (clock times, where,
 * for which hirer), copying a week, the month of one worker, and the list of entries with its export. Hours are minutes; the hourly rate of the
 * day is kept on every entry and follows the rate history until the day is closed (a salary statement, or the office closed the period).
 */
@Injectable()
export class HoursService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly calendar: CalendarService,
    private readonly forms: FormsService,
    private readonly validation: FormValidationService,
    private readonly records: FormRecordsService,
    private readonly locks: PeriodLocksService,
    private readonly pay: HoursPayService,
    private readonly exports: ExportsService,
    rates: EmployeeRatesService,
  ) {
    settings.register(HOURS_NAMESPACE, HOURS_DEFINITIONS, { exposed: true });
    // A new or changed rate also prices the days that were entered before it was known — until those days are closed.
    rates.onChanged((tx, employeeId, from) => this.repriceFrom(tx, employeeId, from));
  }

  private money(user: AuthenticatedUser): boolean {
    return matrixAllows(user.matrix, `${STATEMENTS_AREA}.view`);
  }

  /* ── The week grid ────────────────────────────────────────────────────────────────────────────────────────────── */

  async week(query: WeekQuery, user: AuthenticatedUser, locale: AppLocale): Promise<ApiResult> {
    if (query.from !== undefined && !isValidDay(query.from)) throw validationFailed({ from: 'validation.invalidDate' });
    const start = mondayOf(query.from ?? todayInAmsterdam());
    const end = addDays(start, 6);
    const days = daysOfWeek(start);
    const range = { gte: parseDay(start), lte: parseDay(end) };
    const where = this.workerWhere(query, start, end);

    const [total, workers] = await Promise.all([
      this.prisma.employee.count({ where }),
      this.prisma.employee.findMany({ where, include: WITH_PARTIES, orderBy: [{ client: { number: 'asc' } }, { person: { lastName: 'asc' } }, { person: { firstName: 'asc' } }], ...toSkipTake(query) }),
    ]);
    const ids = workers.map(worker => worker.id);
    const [entries, locks, contracts, rated, perDay] = await Promise.all([
      ids.length ? this.prisma.hourEntry.findMany({ where: { employeeId: { in: ids }, date: range }, select: { employeeId: true, date: true, minutes: true } }) : [],
      this.locks.index(ids, start, end),
      ids.length ? this.prisma.contract.findMany({ where: { employeeId: { in: ids }, status: { in: SIGNED } }, select: { employeeId: true, startDate: true, endDate: true, terminatedOn: true } }) : [],
      ids.length ? this.prisma.rateHistory.groupBy({ by: ['employeeId'], where: { employeeId: { in: ids }, validFrom: { lte: parseDay(end) } } }) : [],
      this.prisma.hourEntry.groupBy({ by: ['date'], where: { date: range, employee: where }, _sum: { minutes: true } }),
    ]);

    const filled = new Map<string, Map<string, { minutes: number; entries: number }>>();
    for (const entry of entries) {
      const mine = filled.get(entry.employeeId) ?? new Map<string, { minutes: number; entries: number }>();
      const key = formatDay(entry.date);
      const cell = mine.get(key) ?? { minutes: 0, entries: 0 };
      cell.minutes += entry.minutes;
      cell.entries += 1;
      mine.set(key, cell);
      filled.set(entry.employeeId, mine);
    }
    const spansOf = new Map<string, Array<{ from: string; to: string | null }>>();
    for (const contract of contracts) {
      const list = spansOf.get(contract.employeeId) ?? [];
      list.push({ from: formatDay(contract.startDate), to: contract.terminatedOn ? formatDay(contract.terminatedOn) : dayOf(contract.endDate) });
      spansOf.set(contract.employeeId, list);
    }
    const hasRate = new Set(rated.map(row => row.employeeId));
    const warnEmployment = this.settings.get<boolean>(`${HOURS_NAMESPACE}.warnOutsideEmployment`);
    const warnContract = this.settings.get<boolean>(`${HOURS_NAMESPACE}.warnOutsideContract`);

    const rows = workers.map(worker => {
      const first = dayOf(worker.startDate);
      const last = dayOf(worker.endDate);
      const mine = filled.get(worker.id);
      const spans = spansOf.get(worker.id) ?? [];
      const cells = days.map(date => {
        const cell = mine?.get(date);
        return {
          date,
          minutes: cell?.minutes ?? 0,
          entries: cell?.entries ?? 0,
          locked: Boolean(locks.covering(worker.id, date)),
          outsideEmployment: warnEmployment && Boolean((first && date < first) || (last && date > last)),
          outsideContract: warnContract && spans.length > 0 && !spans.some(span => span.from <= date && (span.to === null || date <= span.to)),
        };
      });
      return {
        employeeId: worker.id,
        name: personName(worker.person),
        clientId: worker.clientId,
        clientNumber: worker.client.number,
        clientName: worker.client.name,
        startDate: first,
        endDate: last,
        isActive: worker.isActive,
        // A worker hired in through a staffing company has no pay rate here (the staffing company pays them), so a missing rate is no problem.
        hasRate: hasRate.has(worker.id) || workKindOf(worker.data) === 'hired_in',
        kind: workKindOf(worker.data),
        hasContract: spans.length > 0,
        cells,
        minutes: cells.reduce((sum, cell) => sum + cell.minutes, 0),
      };
    });

    const byDay: Record<string, number> = Object.fromEntries(days.map(date => [date, 0]));
    for (const row of perDay) byDay[formatDay(row.date)] = row._sum.minutes ?? 0;
    return new ApiResult(
      {
        weekStart: start,
        weekEnd: end,
        today: todayInAmsterdam(),
        days: days.map(date => this.dayHeader(date, query.clientId, locale)),
        rows,
        totals: { byDay, minutes: Object.values(byDay).reduce((sum, minutes) => sum + minutes, 0) },
        limits: { maxMinutesPerDay: this.settings.get<number>(`${HOURS_NAMESPACE}.maxHoursPerDay`) * 60 },
      },
      pageMeta(total, query),
    );
  }

  /** The weekday heading of the grid: shaded when it is a weekend day or a public holiday. */
  private dayHeader(date: string, clientId: string | undefined, locale: AppLocale) {
    const holiday = this.calendar.holidayOn(date, clientId);
    return { date, weekend: this.calendar.isWeekend(date), holiday: holiday ? { name: locale === 'en' ? holiday.nameEn : holiday.nameNl, paid: holiday.isPaid } : null };
  }

  private workerWhere(query: { clientId?: string; search?: string; withHours?: boolean }, start: string, end: string): Prisma.EmployeeWhereInput {
    const range = { gte: parseDay(start), lte: parseDay(end) };
    const terms = fold(query.search ?? '').split(' ').filter(Boolean);
    return {
      ...(query.clientId && { clientId: query.clientId }),
      AND: [
        {
          OR: [
            { AND: [{ OR: [{ startDate: null }, { startDate: { lte: range.lte } }] }, { OR: [{ endDate: null }, { endDate: { gte: range.gte } }] }] },
            { hourEntries: { some: { date: range } } },
          ],
        },
        ...(query.withHours ? [{ hourEntries: { some: { date: range } } }] : []),
        ...terms.map(term => ({
          OR: [{ person: { searchText: { contains: term } } }, { client: { number: { contains: term, mode: 'insensitive' as const } } }, { client: { name: { contains: term, mode: 'insensitive' as const } } }],
        })),
      ],
    };
  }

  /* ── Typing in the grid ───────────────────────────────────────────────────────────────────────────────────────── */

  /**
   * Saves cells of the grid: a worker's whole day as minutes (empty or 0 clears it). Each cell stands alone — one that cannot be saved (a closed
   * period, a day with several entries) is reported and the others still are. Changing a closed day needs the permission to approve and a reason.
   */
  async saveCells(dto: SaveCellsDto, user: AuthenticatedUser, source: HourSource = 'manual'): Promise<CellResult[]> {
    const ids = [...new Set(dto.cells.map(cell => cell.employeeId))];
    const workers = new Map((await this.prisma.employee.findMany({ where: { id: { in: ids } }, include: WITH_PARTIES })).map(worker => [worker.id, worker]));
    const valid = dto.cells.map(cell => cell.date).filter(isValidDay).sort();
    const locks = valid.length ? await this.locks.index(ids, valid[0]!, valid[valid.length - 1]!) : await this.locks.index([], todayInAmsterdam(), todayInAmsterdam());
    const today = todayInAmsterdam();

    const results: CellResult[] = [];
    const changes = new Map<string, { worker: Worker; before: Record<string, number>; after: Record<string, number>; locked: boolean }>();
    for (const cell of dto.cells) {
      const worker = workers.get(cell.employeeId);
      const outcome = worker ? await this.saveCell(cell, worker, locks, dto.reason, user, today, source) : { result: { employeeId: cell.employeeId, date: cell.date, ok: false, error: 'not_found' } satisfies CellResult };
      results.push(outcome.result);
      if (worker && 'change' in outcome && outcome.change) {
        const entry = changes.get(worker.id) ?? { worker, before: {}, after: {}, locked: false };
        entry.before[cell.date] = outcome.change.before;
        entry.after[cell.date] = outcome.change.after;
        entry.locked ||= outcome.change.locked;
        changes.set(worker.id, entry);
      }
    }
    for (const { worker, before, after, locked } of changes.values()) {
      await this.audit.log({
        action: 'updated',
        entityType: 'hours',
        entityId: worker.id,
        entityLabel: `${personName(worker.person)} (${worker.client.number})`,
        before,
        after,
        meta: { unit: 'minutes', ...(locked && { closedPeriod: true, reason: dto.reason?.trim() }) },
      });
    }
    return results;
  }

  private async saveCell(cell: CellDto, worker: Worker, locks: LockIndex, reason: string | undefined, user: AuthenticatedUser, today: string, source: HourSource) {
    const fail = (error: string): { result: CellResult } => ({ result: { employeeId: cell.employeeId, date: cell.date, ok: false, error } });
    if (!this.plausibleDay(cell.date, today)) return fail('invalid_date');
    let closed: boolean;
    try {
      closed = this.locks.assertEditable(locks.covering(worker.id, cell.date), user, reason);
    } catch (error) {
      const code = this.codeOf(error);
      if (code === 'period_locked' || code === 'reason_required') return fail(code);
      throw error;
    }

    const minutes = cell.minutes ?? 0;
    const existing = await this.prisma.hourEntry.findMany({ where: { employeeId: worker.id, date: parseDay(cell.date) }, orderBy: { createdAt: 'asc' } });
    const before = existing.reduce((sum, entry) => sum + entry.minutes, 0);
    const done = (after: number, entries: number, changed: boolean) => ({
      result: { employeeId: worker.id, date: cell.date, ok: true, minutes: after, entries } satisfies CellResult,
      ...(changed && { change: { before, after, locked: closed } }),
    });

    const may = (action: 'create' | 'edit' | 'delete') => matrixAllows(user.matrix, `${HOURS_AREA}.${action}`);
    if (existing.length > 1) return before === minutes ? done(before, existing.length, false) : fail('multiple_entries');
    if (minutes === before) return done(before, existing.length, false);
    if (minutes === 0) {
      if (!may('delete')) return fail('forbidden');
      await this.prisma.hourEntry.delete({ where: { id: existing[0]!.id } });
      return done(0, 0, true);
    }
    if (!existing.length) {
      if (!may('create')) return fail('forbidden');
      await this.prisma.hourEntry.create({
        data: { employeeId: worker.id, clientId: worker.clientId, date: parseDay(cell.date), minutes, rate: await this.rateOn(this.prisma, worker.id, cell.date), source, createdById: user.id, updatedById: user.id },
      });
      return done(minutes, 1, true);
    }
    if (!may('edit')) return fail('forbidden');
    // Typing a new total replaces the clock times (they would no longer add up).
    await this.prisma.hourEntry.update({ where: { id: existing[0]!.id }, data: { minutes, startTime: null, endTime: null, breakMinutes: 0, updatedById: user.id } });
    return done(minutes, 1, true);
  }

  private codeOf(error: unknown): string | null {
    if (!(error instanceof HttpException)) return null;
    const body = error.getResponse();
    return typeof body === 'object' && body !== null && 'code' in body ? String((body as { code: unknown }).code) : null;
  }

  private plausibleDay(day: string, today: string): boolean {
    return isValidDay(day) && day >= EARLIEST_DAY && day <= addDays(today, DAYS_AHEAD);
  }

  /** The hourly rate that applied on `day` (from the rate history), or `null` when none was set yet. */
  private async rateOn(db: Pick<Prisma.TransactionClient, 'rateHistory'>, employeeId: string, day: string): Promise<Prisma.Decimal | null> {
    const row = await db.rateHistory.findFirst({ where: { employeeId, validFrom: { lte: parseDay(day) } }, orderBy: { validFrom: 'desc' }, select: { rate: true } });
    return row?.rate ?? null;
  }

  /* ── Copying a week ───────────────────────────────────────────────────────────────────────────────────────────── */

  /** Copies the entries of one week into another: only days that are still empty and open, only workers who are employed on that day. */
  async copyWeek(dto: CopyWeekDto, user: AuthenticatedUser) {
    const problems: Record<string, string> = {};
    if (!isValidDay(dto.from)) problems.from = 'validation.invalidDate';
    if (!isValidDay(dto.to)) problems.to = 'validation.invalidDate';
    if (Object.keys(problems).length) throw validationFailed(problems);
    const source = mondayOf(dto.from);
    const target = mondayOf(dto.to);
    if (source === target) throw validationFailed({ to: 'validation.invalid' });
    const shift = daysBetween(source, target);

    const entries = await this.prisma.hourEntry.findMany({
      where: {
        date: { gte: parseDay(source), lte: parseDay(addDays(source, 6)) },
        ...(dto.clientId && { clientId: dto.clientId }),
        ...(dto.employeeIds?.length && { employeeId: { in: dto.employeeIds } }),
      },
      orderBy: [{ employeeId: 'asc' }, { date: 'asc' }, { createdAt: 'asc' }],
    });
    const ids = [...new Set(entries.map(entry => entry.employeeId))];
    const workers = new Map((await this.prisma.employee.findMany({ where: { id: { in: ids } }, include: WITH_PARTIES })).map(worker => [worker.id, worker]));
    const there = await this.prisma.hourEntry.findMany({ where: { employeeId: { in: ids }, date: { gte: parseDay(target), lte: parseDay(addDays(target, 6)) } }, select: { employeeId: true, date: true } });
    const taken = new Set(there.map(entry => `${entry.employeeId}|${formatDay(entry.date)}`));
    const locks = await this.locks.index(ids, target, addDays(target, 6));

    const counts = { created: 0, skippedExisting: 0, skippedClosed: 0, skippedOutside: 0 };
    const made = new Map<string, Record<string, number>>();
    for (const entry of entries) {
      const worker = workers.get(entry.employeeId);
      if (!worker || !worker.isActive) {
        counts.skippedOutside += 1;
        continue;
      }
      const date = addDays(formatDay(entry.date), shift);
      const first = dayOf(worker.startDate);
      const last = dayOf(worker.endDate);
      if ((first && date < first) || (last && date > last)) counts.skippedOutside += 1;
      else if (locks.covering(worker.id, date)) counts.skippedClosed += 1;
      else if (taken.has(`${worker.id}|${date}`)) counts.skippedExisting += 1;
      else {
        await this.prisma.hourEntry.create({
          data: {
            employeeId: worker.id,
            clientId: worker.clientId,
            date: parseDay(date),
            minutes: entry.minutes,
            startTime: entry.startTime,
            endTime: entry.endTime,
            breakMinutes: entry.breakMinutes,
            rate: await this.rateOn(this.prisma, worker.id, date),
            source: 'copy',
            data: (entry.data ?? {}) as Prisma.InputJsonObject,
            createdById: user.id,
            updatedById: user.id,
          },
        });
        counts.created += 1;
        const mine = made.get(worker.id) ?? {};
        mine[date] = (mine[date] ?? 0) + entry.minutes;
        made.set(worker.id, mine);
      }
    }
    for (const [employeeId, after] of made) {
      const worker = workers.get(employeeId)!;
      await this.audit.log({ action: 'created', entityType: 'hours', entityId: employeeId, entityLabel: `${personName(worker.person)} (${worker.client.number})`, after, meta: { unit: 'minutes', copiedFrom: source } });
    }
    return { ...counts, from: source, to: target };
  }

  /* ── Entries: the details of a day ────────────────────────────────────────────────────────────────────────────── */

  async list(query: EntryListQuery, user: AuthenticatedUser): Promise<ApiResult> {
    const where = this.entryWhere(query);
    const [total, rows] = await Promise.all([
      this.prisma.hourEntry.count({ where }),
      this.prisma.hourEntry.findMany({ where, include: { employee: { include: WITH_PARTIES } }, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], ...toSkipTake(query) }),
    ]);
    const { doc } = await this.forms.live(HOUR_ENTRY_ENTITY);
    const hirers = await hirerNames(this.prisma, rows);
    const ids = [...new Set(rows.map(row => row.employeeId))];
    const days = rows.map(row => formatDay(row.date)).sort();
    const locks = days.length ? await this.locks.index(ids, days[0]!, days[days.length - 1]!) : await this.locks.index([], todayInAmsterdam(), todayInAmsterdam());
    const money = this.money(user);
    return paged(
      rows.map(row => ({
        ...entryView(row, doc, user.matrix, this.records, hirers, locks.covering(row.employeeId, formatDay(row.date)), money),
        employee: personName(row.employee.person),
        clientNumber: row.employee.client.number,
        clientName: row.employee.client.name,
      })),
      pageMeta(total, query),
    );
  }

  private entryWhere(query: EntryListQuery): Prisma.HourEntryWhereInput {
    const terms = fold(query.search ?? '').split(' ').filter(Boolean);
    return {
      ...(query.employeeId && { employeeId: query.employeeId }),
      ...(query.clientId && { clientId: query.clientId }),
      ...((query.from || query.to) && { date: { ...(query.from && isValidDay(query.from) && { gte: parseDay(query.from) }), ...(query.to && isValidDay(query.to) && { lte: parseDay(query.to) }) } }),
      ...(terms.length && {
        AND: terms.map(term => ({
          OR: [{ employee: { person: { searchText: { contains: term } } } }, { client: { number: { contains: term, mode: 'insensitive' as const } } }, { client: { name: { contains: term, mode: 'insensitive' as const } } }],
        })),
      }),
    };
  }

  async create(dto: CreateEntryDto, user: AuthenticatedUser, source: HourSource = 'manual') {
    const worker = await this.workerOrThrow(dto.employeeId);
    const today = todayInAmsterdam();
    if (!this.plausibleDay(dto.date, today)) throw validationFailed({ date: 'validation.invalidDate' });
    const closed = await this.assertOpen(worker.id, dto.date, user, dto.reason);
    const times = this.resolveTimes({ minutes: dto.minutes, startTime: dto.startTime, endTime: dto.endTime, breakMinutes: dto.breakMinutes });
    const { doc } = await this.forms.live(HOUR_ENTRY_ENTITY);
    const { values, errors } = await this.validation.check(HOUR_ENTRY_ENTITY, dto.values ?? {}, {}, user.matrix, doc);
    if (Object.keys(errors).length) throw new UnprocessableEntityException({ code: 'validation_failed', message: 'Validation failed', fields: errors });

    const row = await this.prisma.hourEntry.create({
      data: {
        employeeId: worker.id,
        clientId: worker.clientId,
        date: parseDay(dto.date),
        ...times,
        rate: await this.rateOn(this.prisma, worker.id, dto.date),
        source,
        data: FormRecordsService.merge({}, this.records.encode(doc, values)) as Prisma.InputJsonObject,
        createdById: user.id,
        updatedById: user.id,
      },
    });
    await this.audit.log({
      action: 'created',
      entityType: 'hours',
      entityId: worker.id,
      entityLabel: `${personName(worker.person)} (${worker.client.number})`,
      after: { date: dto.date, ...times, ...this.records.auditSnapshot(doc, values) },
      meta: { entryId: row.id, ...(closed && { closedPeriod: true, reason: dto.reason?.trim() }) },
    });
    return this.one(row.id, user);
  }

  async update(id: string, dto: UpdateEntryDto, user: AuthenticatedUser) {
    const row = await this.entryOrThrow(id);
    const worker = await this.workerOrThrow(row.employeeId);
    const date = formatDay(row.date);
    const closed = await this.assertOpen(worker.id, date, user, dto.reason);
    const touchesTimes = dto.startTime !== undefined || dto.endTime !== undefined || dto.breakMinutes !== undefined;
    const times = this.resolveTimes(
      {
        minutes: dto.minutes,
        startTime: dto.startTime !== undefined ? dto.startTime : dto.minutes !== undefined ? null : row.startTime,
        endTime: dto.endTime !== undefined ? dto.endTime : dto.minutes !== undefined ? null : row.endTime,
        breakMinutes: dto.breakMinutes ?? (dto.minutes !== undefined && !touchesTimes ? 0 : row.breakMinutes),
      },
      row.minutes,
    );

    const { doc } = await this.forms.live(HOUR_ENTRY_ENTITY);
    const existing = this.records.decode(asRecord(row.data));
    const { values, errors } = await this.validation.check(HOUR_ENTRY_ENTITY, dto.values ?? {}, existing, user.matrix, doc);
    if (Object.keys(errors).length) throw new UnprocessableEntityException({ code: 'validation_failed', message: 'Validation failed', fields: errors });
    const stored = FormRecordsService.merge(asRecord(row.data), this.records.encode(doc, values));
    const keys = Object.keys(values);
    const diff = this.records.auditChange(doc, Object.fromEntries(keys.map(key => [key, existing[key] ?? null])), Object.fromEntries(keys.map(key => [key, values[key] ?? null])));
    const timeDiff = AuditService.changes({ minutes: row.minutes, startTime: row.startTime, endTime: row.endTime, breakMinutes: row.breakMinutes }, times);

    if (!Object.keys(diff.after).length && !Object.keys(timeDiff.after).length) return this.one(id, user);
    await this.prisma.hourEntry.update({ where: { id }, data: { ...times, data: stored as Prisma.InputJsonObject, updatedById: user.id } });
    await this.audit.log({
      action: 'updated',
      entityType: 'hours',
      entityId: worker.id,
      entityLabel: `${personName(worker.person)} (${worker.client.number})`,
      before: { date, ...timeDiff.before, ...diff.before },
      after: { date, ...timeDiff.after, ...diff.after },
      meta: { entryId: id, ...(closed && { closedPeriod: true, reason: dto.reason?.trim() }) },
    });
    return this.one(id, user);
  }

  async remove(id: string, reason: string | undefined, user: AuthenticatedUser) {
    const row = await this.entryOrThrow(id);
    const worker = await this.workerOrThrow(row.employeeId);
    const date = formatDay(row.date);
    const closed = await this.assertOpen(worker.id, date, user, reason);
    await this.prisma.hourEntry.delete({ where: { id } });
    await this.audit.log({
      action: 'deleted',
      entityType: 'hours',
      entityId: worker.id,
      entityLabel: `${personName(worker.person)} (${worker.client.number})`,
      before: { date, minutes: row.minutes, startTime: row.startTime, endTime: row.endTime, breakMinutes: row.breakMinutes },
      meta: { entryId: id, ...(closed && { closedPeriod: true, reason: reason?.trim() }) },
    });
    return { deleted: true };
  }

  /** One entry as the screens show it. */
  async one(id: string, user: AuthenticatedUser) {
    const row = await this.entryOrThrow(id);
    const { doc } = await this.forms.live(HOUR_ENTRY_ENTITY);
    const lock = (await this.locks.index([row.employeeId], formatDay(row.date), formatDay(row.date))).covering(row.employeeId, formatDay(row.date));
    return entryView(row, doc, user.matrix, this.records, await hirerNames(this.prisma, [row]), lock, this.money(user));
  }

  /** Minutes and clock times of an entry: clock times win (minutes = end − start − break); otherwise the minutes are used as given. */
  private resolveTimes(input: { minutes?: number; startTime?: string | null; endTime?: string | null; breakMinutes?: number }, current?: number) {
    const hasStart = input.startTime !== undefined && input.startTime !== null && input.startTime !== '';
    const hasEnd = input.endTime !== undefined && input.endTime !== null && input.endTime !== '';
    if (hasStart !== hasEnd) throw validationFailed({ [hasStart ? 'endTime' : 'startTime']: 'validation.required' });
    if (hasStart && hasEnd) {
      const start = parseClock(input.startTime);
      const end = parseClock(input.endTime);
      const problems: Record<string, string> = {};
      if (start === null) problems.startTime = 'validation.invalid';
      if (end === null) problems.endTime = 'validation.invalid';
      if (Object.keys(problems).length) throw validationFailed(problems);
      const span = spanMinutes(start!, end!);
      if (span === null) throw validationFailed({ endTime: 'validation.invalid' });
      const breakMinutes = input.breakMinutes ?? 0;
      const minutes = span - breakMinutes;
      if (minutes <= 0 || minutes > MAX_ENTRY_MINUTES) throw validationFailed({ breakMinutes: 'validation.invalid' });
      return { minutes, startTime: formatClock(start!), endTime: formatClock(end!), breakMinutes };
    }
    const minutes = input.minutes ?? current;
    if (minutes === undefined) throw validationFailed({ minutes: 'validation.required' });
    return { minutes, startTime: null, endTime: null, breakMinutes: 0 };
  }

  /** Whether `day` of this worker is open for a change; a closed day needs the permission to approve and a reason. Returns whether it was closed. */
  private async assertOpen(employeeId: string, day: string, user: AuthenticatedUser, reason: string | undefined): Promise<boolean> {
    const lock = (await this.locks.index([employeeId], day, day)).covering(employeeId, day);
    return this.locks.assertEditable(lock, user, reason);
  }

  private async workerOrThrow(id: string): Promise<Worker> {
    const worker = await this.prisma.employee.findUnique({ where: { id }, include: WITH_PARTIES });
    if (!worker) throw new NotFoundException({ code: 'not_found', message: 'Employee not found' });
    return worker;
  }

  private async entryOrThrow(id: string): Promise<HourEntry> {
    const row = await this.prisma.hourEntry.findUnique({ where: { id } });
    if (!row) throw new NotFoundException({ code: 'not_found', message: 'Hour entry not found' });
    return row;
  }

  /* ── One worker, one month ────────────────────────────────────────────────────────────────────────────────────── */

  /** The month of a worker: every day with its entries, the totals, the closed periods, the statements, and — for people who may see it — what it pays. */
  async month(query: MonthQuery, user: AuthenticatedUser, locale: AppLocale) {
    if (!isMonth(query.month)) throw validationFailed({ month: 'validation.invalid' });
    const worker = await this.workerOrThrow(query.employeeId);
    const from = firstOfMonth(query.month);
    const to = lastOfMonth(query.month);
    const [rows, locks, statements, { doc }, closedByHand] = await Promise.all([
      this.prisma.hourEntry.findMany({ where: { employeeId: worker.id, date: { gte: parseDay(from), lte: parseDay(to) } }, orderBy: [{ date: 'asc' }, { createdAt: 'asc' }] }),
      this.locks.index([worker.id], from, to),
      this.prisma.salaryStatement.findMany({ where: { employeeId: worker.id, status: 'final', periodFrom: { lte: parseDay(to) }, periodTo: { gte: parseDay(from) } }, orderBy: { periodFrom: 'asc' } }),
      this.forms.live(HOUR_ENTRY_ENTITY),
      this.locks.list({ employeeId: worker.id, from, to }),
    ]);
    const hirers = await hirerNames(this.prisma, rows);
    const money = this.money(user);
    const entriesOf = new Map<string, Array<ReturnType<typeof entryView>>>();
    for (const row of rows) {
      const key = formatDay(row.date);
      const list = entriesOf.get(key) ?? [];
      list.push(entryView(row, doc, user.matrix, this.records, hirers, locks.covering(worker.id, key), money));
      entriesOf.set(key, list);
    }
    const days: MonthDay[] = [];
    for (let date = from; date <= to; date = addDays(date, 1)) {
      const entries = entriesOf.get(date) ?? [];
      days.push({ ...this.dayHeader(date, worker.clientId, locale), weekday: parseDay(date).getUTCDay(), minutes: entries.reduce((sum, entry) => sum + entry.minutes, 0), entries, locked: Boolean(locks.covering(worker.id, date)) });
    }
    const closed = days.length > 0 && days.every(entry => entry.locked);
    const pay = money && rows.length ? this.pay.view(await this.pay.preview(worker.id, from, to)) : null;

    return {
      employee: { id: worker.id, name: personName(worker.person), clientId: worker.clientId, clientNumber: worker.client.number, clientName: worker.client.name, isActive: worker.isActive, startDate: dayOf(worker.startDate), endDate: dayOf(worker.endDate) },
      month: query.month,
      from,
      to,
      days,
      totals: { minutes: rows.reduce((sum, row) => sum + row.minutes, 0), days: days.filter(entry => entry.minutes > 0).length, hours: minutesToHours(rows.reduce((sum, row) => sum + row.minutes, 0)) },
      closed,
      /** Why days are closed: by a salary statement, by an invoice, or by hand — how many closed periods of each kind touch the month. */
      closedBy: { statement: closedByHand.filter(lock => lock.kind === 'statement').length, invoice: closedByHand.filter(lock => lock.kind === 'invoice').length, manual: closedByHand.filter(lock => lock.kind === 'manual').length },
      locks: closedByHand.filter(lock => lock.kind === 'manual'),
      statements: statements.map(row => ({ id: row.id, from: formatDay(row.periodFrom), to: formatDay(row.periodTo), totalMinutes: row.totalMinutes, ...(money && { totalAmount: row.totalAmount.toNumber() }) })),
      pay: pay && { totals: pay.totals, warnings: pay.warnings, blockers: pay.blockers, terms: pay.terms },
    };
  }

  /* ── Export ───────────────────────────────────────────────────────────────────────────────────────────────────── */

  /** The entries a list shows, as a table for Excel, PDF or Word. Amounts only for people who may see what is paid. */
  async exportTable(query: EntryExportQuery, user: AuthenticatedUser, locale: AppLocale): Promise<ExportTable> {
    const where = this.entryWhere(query);
    this.exports.assertSize(await this.prisma.hourEntry.count({ where }));
    const rows = await this.prisma.hourEntry.findMany({ where, include: { employee: { include: WITH_PARTIES } }, orderBy: [{ date: 'asc' }, { employee: { client: { number: 'asc' } } }, { createdAt: 'asc' }] });
    const { doc } = await this.forms.live(HOUR_ENTRY_ENTITY);
    const hirers = await hirerNames(this.prisma, rows);
    const money = this.money(user);
    const nl = locale === 'nl';
    const note = doc.fields.find(field => field.key === 'note' && field.active);
    const periodText = query.from || query.to ? `${query.from ?? '…'} – ${query.to ?? '…'}` : undefined;
    return {
      title: nl ? 'Uren' : 'Hours',
      subtitle: periodText,
      locale,
      columns: [
        { key: 'date', header: nl ? 'Datum' : 'Date', type: 'date', width: 12 },
        { key: 'client', header: nl ? 'Klant' : 'Client', width: 26 },
        { key: 'worker', header: nl ? 'Werknemer' : 'Employee', width: 24 },
        { key: 'hours', header: nl ? 'Uren' : 'Hours', type: 'number', width: 8 },
        { key: 'start', header: nl ? 'Van' : 'From', width: 8 },
        { key: 'end', header: nl ? 'Tot' : 'To', width: 8 },
        { key: 'break', header: nl ? 'Pauze (min)' : 'Break (min)', type: 'number', width: 10 },
        { key: 'where', header: nl ? 'Waar' : 'Where', width: 30 },
        ...(note ? [{ key: 'note', header: note.labels[locale] || note.labels.nl, width: 30 }] : []),
        ...(money ? [{ key: 'rate', header: nl ? 'Uurloon' : 'Hourly rate', type: 'money' as const, width: 10 }] : []),
      ],
      rows: rows.map(row => {
        const values = valuesFor(doc, this.records.publicValues(asRecord(row.data)), user.matrix);
        return {
          date: formatDay(row.date),
          client: `${row.employee.client.number} – ${row.employee.client.name}`,
          worker: personName(row.employee.person),
          hours: minutesToHours(row.minutes),
          start: row.startTime ?? '',
          end: row.endTime ?? '',
          break: row.breakMinutes,
          where: whereText(values, hirers),
          note: typeof values.note === 'string' ? values.note : '',
          rate: row.rate?.toNumber() ?? null,
        };
      }),
    };
  }

  /* ── Rates ────────────────────────────────────────────────────────────────────────────────────────────────────── */

  /** Gives the open days of a worker (from `from` on) the rate the history says they had — closed days keep theirs. Returns how many entries it looked at. */
  async repriceFrom(tx: Prisma.TransactionClient, employeeId: string, from: string): Promise<number> {
    return tx.$executeRaw`
      UPDATE "HourEntry" h
      SET "rate" = (SELECT r."rate" FROM "RateHistory" r WHERE r."employeeId" = h."employeeId" AND r."validFrom" <= h."date" ORDER BY r."validFrom" DESC LIMIT 1)
      WHERE h."employeeId" = ${employeeId}
        AND h."date" >= ${from}::date
        AND NOT EXISTS (SELECT 1 FROM "PeriodLock" l WHERE l."employeeId" = h."employeeId" AND h."date" BETWEEN l."fromDate" AND l."toDate")`;
  }

  /** "Update the rates": the same, on request, for every open day (or from a day on). */
  async reprice(dto: RepriceDto, user: AuthenticatedUser) {
    const worker = await this.workerOrThrow(dto.employeeId);
    if (dto.from !== undefined && !isValidDay(dto.from)) throw validationFailed({ from: 'validation.invalidDate' });
    const updated = await this.prisma.$transaction(tx => this.repriceFrom(tx, worker.id, dto.from ?? EARLIEST_DAY));
    await this.audit.log({ action: 'updated', entityType: 'hours', entityId: worker.id, entityLabel: `${personName(worker.person)} (${worker.client.number})`, meta: { repriced: updated, from: dto.from ?? null, by: user.id } });
    return { updated };
  }
}
