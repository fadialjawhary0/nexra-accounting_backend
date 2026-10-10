import { ConflictException, Injectable, Logger, NotFoundException, UnprocessableEntityException, type OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import { addDays, formatDay, isValidDay, parseDay, todayInAmsterdam, weekdayOf } from '../../common/dates.js';
import type { Holiday } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { SettingsService, type SettingDefinitions } from '../../lib/settings/settings.service.js';
import { dutchHolidays } from './dutch-holidays.js';

export const CALENDAR_NAMESPACE = 'calendar';
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
/** Index = `Date#getUTCDay()`. */
const WEEKDAY_BY_NUMBER = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/** Settings → Calendar & holidays. */
export const CALENDAR_DEFINITIONS = {
  /** At least one day of the week stays a working day (a calendar without one would make every deadline unreachable). */
  weekendDays: { type: 'multi', default: ['sat', 'sun'], options: WEEKDAYS, max: 6, group: 'week' },
  warnWeekend: { type: 'bool', default: true, group: 'warnings' },
  warnHoliday: { type: 'bool', default: true, group: 'warnings' },
  deadlinesWorkingDays: { type: 'bool', default: true, group: 'deadlines' },
} satisfies SettingDefinitions;

/** Years kept ready: last year (for history) up to five years ahead. */
const YEARS_BEHIND = 1;
const YEARS_AHEAD = 5;
/** Safety stop for "find the next working day" loops (a calendar with every day switched off must not hang the server). */
const MAX_SCAN_DAYS = 3660;

interface HolidayEntry {
  id: string;
  clientId: string | null;
  nameNl: string;
  nameEn: string;
  isPaid: boolean;
}

export const serializeHoliday = (holiday: Holiday, locale: AppLocale) => ({
  id: holiday.id,
  date: formatDay(holiday.date),
  name: locale === 'en' ? holiday.nameEn : holiday.nameNl,
  names: { nl: holiday.nameNl, en: holiday.nameEn },
  kind: holiday.kind,
  paid: holiday.isPaid,
  active: holiday.isActive,
  code: holiday.code,
  clientId: holiday.clientId,
});

/**
 * The Netherlands calendar: weekends (editable) and the Dutch public holidays (generated for every year, editable) decide what is a
 * working day. EVERY date calculation in the app — reminders, deadlines, contract warnings, salary periods — goes through this
 * service, never through naive "+ 30 days". Days are `YYYY-MM-DD` strings.
 */
@Injectable()
export class CalendarService implements OnModuleInit {
  private readonly logger = new Logger(CalendarService.name);
  /** Active holidays by day (all clients); `clientId` narrows an entry to one client. */
  private entries = new Map<string, HolidayEntry[]>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {
    settings.register(CALENDAR_NAMESPACE, CALENDAR_DEFINITIONS, { exposed: true });
  }

  async onModuleInit(): Promise<void> {
    await this.refresh();
  }

  /** Every night: make sure the coming years exist (idempotent — it only creates years that are missing). */
  @Cron('17 3 * * *', { timeZone: 'Europe/Amsterdam' })
  async keepYearsCovered(): Promise<void> {
    await this.refresh();
  }

  /** Generates the official holidays of missing years, then reloads the cache. */
  async refresh(): Promise<void> {
    try {
      const thisYear = Number(todayInAmsterdam().slice(0, 4));
      for (let year = thisYear - YEARS_BEHIND; year <= thisYear + YEARS_AHEAD; year += 1) await this.ensureYear(year);
      await this.reload();
    } catch (error) {
      this.logger.warn(`Could not refresh the holiday calendar: ${(error as Error).message.split('\n')[0]}`);
    }
  }

  /** Creates the official holidays of `year` when the year has none yet. Returns how many were created. */
  async ensureYear(year: number): Promise<number> {
    const existing = await this.prisma.holiday.count({ where: { kind: 'official', date: { gte: parseDay(`${year}-01-01`), lte: parseDay(`${year}-12-31`) } } });
    if (existing > 0) return 0;
    const created = await this.prisma.holiday.createMany({
      data: dutchHolidays(year).map(holiday => ({ date: parseDay(holiday.date), nameNl: holiday.nameNl, nameEn: holiday.nameEn, kind: 'official' as const, isPaid: holiday.paid, code: holiday.code })),
      skipDuplicates: true,
    });
    return created.count;
  }

  private async reload(): Promise<void> {
    const rows = await this.prisma.holiday.findMany({ where: { isActive: true } });
    const entries = new Map<string, HolidayEntry[]>();
    for (const row of rows) {
      const day = formatDay(row.date);
      const list = entries.get(day) ?? [];
      list.push({ id: row.id, clientId: row.clientId, nameNl: row.nameNl, nameEn: row.nameEn, isPaid: row.isPaid });
      entries.set(day, list);
    }
    this.entries = entries;
  }

  /* ── Working-day arithmetic (synchronous: reads the cache) ─────────────────────────────────────────────────── */

  /** The days of the week that are weekend (`0` = Sunday … `6` = Saturday). */
  weekendNumbers(): Set<number> {
    const weekend = this.settings.get<string[]>(`${CALENDAR_NAMESPACE}.weekendDays`);
    return new Set(WEEKDAY_BY_NUMBER.map((name, number) => (weekend.includes(name) ? number : -1)).filter(number => number >= 0));
  }

  isWeekend(day: string): boolean {
    return this.weekendNumbers().has(weekdayOf(day));
  }

  /** The holiday on `day` for this client (or for everybody), if any. */
  holidayOn(day: string, clientId?: string | null): HolidayEntry | null {
    return this.entries.get(day)?.find(entry => !entry.clientId || entry.clientId === clientId) ?? null;
  }

  isHoliday(day: string, clientId?: string | null): boolean {
    return this.holidayOn(day, clientId) !== null;
  }

  isWorkingDay(day: string, clientId?: string | null): boolean {
    return !this.isWeekend(day) && !this.isHoliday(day, clientId);
  }

  /** `day` itself when it is a working day, otherwise the next one. */
  nextWorkingDay(day: string, clientId?: string | null): string {
    let current = day;
    for (let guard = 0; guard < MAX_SCAN_DAYS && !this.isWorkingDay(current, clientId); guard += 1) current = addDays(current, 1);
    return current;
  }

  previousWorkingDay(day: string, clientId?: string | null): string {
    let current = day;
    for (let guard = 0; guard < MAX_SCAN_DAYS && !this.isWorkingDay(current, clientId); guard += 1) current = addDays(current, -1);
    return current;
  }

  /** `count` working days after (or, negative, before) `day`. Adding 0 returns `day` unchanged. */
  addWorkingDays(day: string, count: number, clientId?: string | null): string {
    const step = count < 0 ? -1 : 1;
    let remaining = Math.abs(count);
    let current = day;
    for (let guard = 0; remaining > 0 && guard < MAX_SCAN_DAYS * 2; guard += 1) {
      current = addDays(current, step);
      if (this.isWorkingDay(current, clientId)) remaining -= 1;
    }
    return current;
  }

  /** Working days after `from` up to and including `to` (negative when `to` is earlier). */
  workingDaysBetween(from: string, to: string, clientId?: string | null): number {
    if (from === to) return 0;
    const [start, end, sign] = from < to ? [from, to, 1] : [to, from, -1];
    let count = 0;
    for (let current = addDays(start, 1), guard = 0; current <= end && guard < MAX_SCAN_DAYS * 2; current = addDays(current, 1), guard += 1) {
      if (this.isWorkingDay(current, clientId)) count += 1;
    }
    return count * sign;
  }

  /** A legal deadline that falls on a weekend or holiday moves to the next working day (Algemene termijnenwet) — when the office keeps that rule on. */
  moveDeadline(day: string, clientId?: string | null): string {
    return this.settings.get<boolean>(`${CALENDAR_NAMESPACE}.deadlinesWorkingDays`) ? this.nextWorkingDay(day, clientId) : day;
  }

  /** "Is this a working day, what is the next one, and what is N working days later?" — the screen where Ahmad tries his calendar out. */
  check(day: string, add: number, locale: AppLocale, clientId?: string | null) {
    if (!isValidDay(day)) throw this.invalid({ date: 'validation.invalidDate' });
    const holiday = this.holidayOn(day, clientId);
    return {
      date: day,
      weekend: this.isWeekend(day),
      holiday: holiday ? (locale === 'en' ? holiday.nameEn : holiday.nameNl) : null,
      working: this.isWorkingDay(day, clientId),
      nextWorkingDay: this.nextWorkingDay(day, clientId),
      plus: { days: add, date: this.addWorkingDays(day, add, clientId) },
    };
  }

  /** What the date pickers need: the weekend and the warning switches. */
  config() {
    const values = this.settings.group(CALENDAR_NAMESPACE);
    return { weekendDays: [...this.weekendNumbers()].sort(), warnWeekend: values.warnWeekend as boolean, warnHoliday: values.warnHoliday as boolean, deadlinesWorkingDays: values.deadlinesWorkingDays as boolean };
  }

  /* ── Reading and editing holidays (Settings → Calendar & holidays) ──────────────────────────────────────── */

  async list(options: { from?: string; to?: string; year?: number; includeInactive: boolean; locale: AppLocale }) {
    const range = options.year ? { from: `${options.year}-01-01`, to: `${options.year}-12-31` } : { from: options.from, to: options.to };
    const rows = await this.prisma.holiday.findMany({
      where: {
        ...(options.includeInactive ? {} : { isActive: true }),
        ...((range.from || range.to) && { date: { ...(range.from && { gte: parseDay(range.from) }), ...(range.to && { lte: parseDay(range.to) }) } }),
      },
      orderBy: [{ date: 'asc' }, { nameNl: 'asc' }],
    });
    return rows.map(row => serializeHoliday(row, options.locale));
  }

  async create(input: { date: string; nameNl: string; nameEn: string; paid?: boolean }, locale: AppLocale) {
    if (!isValidDay(input.date)) throw this.invalid({ date: 'validation.invalidDate' });
    const holiday = await this.prisma.holiday.create({
      data: { date: parseDay(input.date), nameNl: input.nameNl.trim(), nameEn: input.nameEn.trim(), kind: 'custom', isPaid: input.paid ?? false },
    });
    await this.reload();
    await this.audit.log({ action: 'created', entityType: 'holiday', entityId: holiday.id, entityLabel: `${input.date} ${holiday.nameEn}`, after: { date: input.date, nameNl: holiday.nameNl, nameEn: holiday.nameEn } });
    return serializeHoliday(holiday, locale);
  }

  async update(id: string, changes: { date?: string; nameNl?: string; nameEn?: string; paid?: boolean; active?: boolean }, locale: AppLocale) {
    const holiday = await this.prisma.holiday.findUnique({ where: { id } });
    if (!holiday) throw new NotFoundException({ code: 'not_found', message: 'Holiday not found' });
    if (changes.date !== undefined) {
      if (holiday.kind === 'official') throw new ConflictException({ code: 'official_holiday', message: 'The date of an official holiday follows the calendar and cannot be changed.' });
      if (!isValidDay(changes.date)) throw this.invalid({ date: 'validation.invalidDate' });
    }
    const updated = await this.prisma.holiday.update({
      where: { id },
      data: {
        ...(changes.date !== undefined && { date: parseDay(changes.date) }),
        ...(changes.nameNl !== undefined && { nameNl: changes.nameNl.trim() }),
        ...(changes.nameEn !== undefined && { nameEn: changes.nameEn.trim() }),
        ...(changes.paid !== undefined && { isPaid: changes.paid }),
        ...(changes.active !== undefined && { isActive: changes.active }),
      },
    });
    await this.reload();
    const pick = (row: Holiday) => ({ date: formatDay(row.date), nameNl: row.nameNl, nameEn: row.nameEn, paid: row.isPaid, active: row.isActive });
    const diff = AuditService.changes(pick(holiday), pick(updated));
    if (Object.keys(diff.after).length) {
      const action = changes.active !== undefined && changes.active !== holiday.isActive ? (changes.active ? 'activated' : 'deactivated') : 'updated';
      await this.audit.log({ action, entityType: 'holiday', entityId: id, entityLabel: `${formatDay(updated.date)} ${updated.nameEn}`, before: diff.before, after: diff.after });
    }
    return serializeHoliday(updated, locale);
  }

  async remove(id: string) {
    const holiday = await this.prisma.holiday.findUnique({ where: { id } });
    if (!holiday) throw new NotFoundException({ code: 'not_found', message: 'Holiday not found' });
    if (holiday.kind === 'official') throw new ConflictException({ code: 'official_holiday', message: 'Official holidays cannot be deleted — switch them off instead.' });
    await this.prisma.holiday.delete({ where: { id } });
    await this.reload();
    await this.audit.log({ action: 'deleted', entityType: 'holiday', entityId: id, entityLabel: `${formatDay(holiday.date)} ${holiday.nameEn}` });
    return { id };
  }

  /** Generates a year that is missing (e.g. further ahead than the nightly job looks). */
  async generateYear(year: number) {
    const created = await this.ensureYear(year);
    await this.reload();
    if (created > 0) await this.audit.log({ action: 'created', entityType: 'holiday', entityId: String(year), entityLabel: `Dutch holidays ${year}`, meta: { count: created } });
    return { year, created };
  }

  private invalid(fields: Record<string, string>) {
    return new UnprocessableEntityException({ code: 'validation_failed', message: 'Validation failed', fields });
  }
}
