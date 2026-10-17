import { Injectable, NotFoundException } from '@nestjs/common';
import { daysBetween, formatDay, isValidDay, parseDay, todayInAmsterdam } from '../../common/dates.js';
import { asRecord } from '../../common/record-values.js';
import { validationFailed } from '../../common/validation/failure.js';
import type { Employee, Person } from '../../generated/prisma/client.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { SettingsService } from '../../lib/settings/settings.service.js';
import { CalendarService } from '../calendar/calendar.service.js';
import { workKindOf } from '../employees/employee-record.js';
import { personName } from '../people/person-record.js';
import { ENTRY_FIELD, HOURS_NAMESPACE } from './hours.constants.js';
import { fromCents, toCents } from './hours-time.js';
import { calculatePay, weekSpan, type PayEntry, type PayLine, type PayResult, type PayTotals } from './pay-calculator.js';
import { SurchargeRulesService } from './surcharge-rules.service.js';

/** Longest period one preview or statement covers. */
export const MAX_PERIOD_DAYS = 366;

export interface PayWarning {
  code: string;
  severity: 'error' | 'warning' | 'info';
  /** The days it is about (at most a handful are listed). */
  dates?: string[];
  params?: Record<string, string | number>;
}

export interface PayTerms {
  allowancePercent: number;
  vacationAccrualPercent: number;
  /** Where the percentages come from: the worker's latest contract, or Settings → Hours & pay. */
  source: 'contract' | 'settings';
}

export interface PayPreview {
  employee: { id: string; name: string; clientId: string; clientNumber: string; clientName: string };
  from: string;
  to: string;
  result: PayResult;
  terms: PayTerms;
  warnings: PayWarning[];
  /** Problems that stop a statement from being made. */
  blockers: PayWarning[];
  entryCount: number;
}

type WorkerRow = Employee & { person: Person; client: { id: string; number: string; name: string } };

/** The lines of a statement as the screens get them: amounts in euros, the surcharge as a percentage or an amount per hour. */
export const viewLines = (lines: PayLine[]) =>
  lines.map(line => ({
    type: line.type,
    date: line.date,
    minutes: line.minutes,
    rate: line.rateCents === null ? null : fromCents(line.rateCents),
    where: line.where,
    label: line.label,
    kind: line.kind ?? null,
    percent: line.percentBp === null || line.percentBp === undefined ? null : line.percentBp / 100,
    perHour: line.perHourCents === null || line.perHourCents === undefined ? null : fromCents(line.perHourCents),
    amount: fromCents(line.amountCents),
  }));

export const viewTotals = (totals: PayTotals) => ({
  minutes: totals.minutes,
  days: totals.days,
  base: fromCents(totals.baseCents),
  surcharge: fromCents(totals.surchargeCents),
  gross: fromCents(totals.grossCents),
  allowancePercent: totals.allowancePercent,
  allowance: fromCents(totals.allowanceCents),
  total: fromCents(totals.totalCents),
  vacationMinutes: totals.vacationMinutes,
});

/** The names of the hirers on a set of entries (`data.hirer` holds the id of a client). */
export async function hirerNames(prisma: PrismaService, rows: Array<{ data: unknown }>): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map(row => asRecord(row.data)[ENTRY_FIELD.hirer]).filter((id): id is string => typeof id === 'string' && id.length > 0))];
  if (!ids.length) return new Map();
  const clients = await prisma.client.findMany({ where: { id: { in: ids } }, select: { id: true, number: true, name: true } });
  return new Map(clients.map(client => [client.id, `${client.number} – ${client.name}`]));
}

/** "004 – Bakkerij · Kerkstraat 1 · Project X": where the work was done, as one line. */
export function whereText(data: unknown, hirers: Map<string, string>): string {
  const values = asRecord(data);
  const text = (key: string) => (typeof values[key] === 'string' ? (values[key] as string).trim() : '');
  const hirer = typeof values[ENTRY_FIELD.hirer] === 'string' ? (hirers.get(values[ENTRY_FIELD.hirer] as string) ?? '') : '';
  return [hirer, text(ENTRY_FIELD.workplace), text(ENTRY_FIELD.assignment)].filter(Boolean).join(' · ');
}

/**
 * What a worker is paid for a period of hours, worked out from the entries, the rate that applied each day, the surcharge rules that are switched
 * on and the Netherlands calendar. Nothing is saved here: the month overview shows it as it is now, and a salary statement freezes it.
 */
@Injectable()
export class HoursPayService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly calendar: CalendarService,
    private readonly rules: SurchargeRulesService,
  ) {}

  async preview(employeeId: string, from: string, to: string): Promise<PayPreview> {
    this.assertPeriod(from, to);
    const worker = await this.worker(employeeId);
    const span = weekSpan(from, to);

    const [rows, rules, terms, taken] = await Promise.all([
      this.prisma.hourEntry.findMany({ where: { employeeId, date: { gte: parseDay(span.from), lte: parseDay(span.to) } }, orderBy: [{ date: 'asc' }, { createdAt: 'asc' }] }),
      this.rules.active(),
      this.terms(worker, to),
      this.prisma.salaryStatement.findMany({ where: { employeeId, status: 'final', periodFrom: { lte: parseDay(to) }, periodTo: { gte: parseDay(from) } }, select: { id: true, periodFrom: true, periodTo: true } }),
    ]);
    const hirers = await hirerNames(this.prisma, rows);
    const entries: PayEntry[] = rows.map(row => ({
      id: row.id,
      date: formatDay(row.date),
      minutes: row.minutes,
      startTime: row.startTime,
      endTime: row.endTime,
      breakMinutes: row.breakMinutes,
      rateCents: row.rate === null ? null : toCents(row.rate.toNumber()),
      clientId: row.clientId,
      where: whereText(row.data, hirers),
    }));

    const result = calculatePay({
      from,
      to,
      entries,
      rules,
      dayKind: (day, clientId) => ({ weekend: this.calendar.isWeekend(day), holiday: this.calendar.isHoliday(day, clientId) }),
      allowancePercent: terms.allowancePercent,
      vacationAccrualPercent: terms.vacationAccrualPercent,
    });

    const inPeriod = entries.filter(entry => entry.date >= from && entry.date <= to);
    const warnings: PayWarning[] = [];
    const blockers: PayWarning[] = [];

    const noRate = [...new Set(result.issues.filter(issue => issue.code === 'rate_missing' && issue.date).map(issue => issue.date as string))];
    if (noRate.length) blockers.push({ code: 'rate_missing', severity: 'error', dates: noRate.slice(0, 8), params: { count: noRate.length } });
    if (!inPeriod.length) blockers.push({ code: 'no_hours', severity: 'error' });
    // A worker hired in through a staffing company is paid by that company: there is no salary statement for them here.
    if (workKindOf(worker.data) === 'hired_in') blockers.push({ code: 'hired_in', severity: 'error' });
    if (taken.length) blockers.push({ code: 'statement_overlap', severity: 'error', params: { from: formatDay(taken[0]!.periodFrom), to: formatDay(taken[0]!.periodTo), id: taken[0]!.id } });

    warnings.push(...(await this.advice(worker, inPeriod, to)));
    const evening = result.issues.filter(issue => issue.code === 'evening_needs_times');
    if (evening.length) warnings.push({ code: 'evening_needs_times', severity: 'info', params: { count: new Set(evening.map(issue => issue.entryId)).size } });

    return {
      employee: { id: worker.id, name: personName(worker.person), clientId: worker.clientId, clientNumber: worker.client.number, clientName: worker.client.name },
      from,
      to,
      result,
      terms,
      warnings,
      blockers,
      entryCount: inPeriod.length,
    };
  }

  /** The answer for the screens: amounts as euros. */
  view(preview: PayPreview) {
    return {
      employee: preview.employee,
      from: preview.from,
      to: preview.to,
      terms: preview.terms,
      warnings: preview.warnings,
      blockers: preview.blockers,
      entryCount: preview.entryCount,
      lines: viewLines(preview.result.lines),
      totals: viewTotals(preview.result.totals),
    };
  }

  /* ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  assertPeriod(from: string, to: string): void {
    const problems: Record<string, string> = {};
    if (!isValidDay(from)) problems.from = 'validation.invalidDate';
    if (!isValidDay(to)) problems.to = 'validation.invalidDate';
    if (!Object.keys(problems).length) {
      if (to < from) problems.to = 'validation.endBeforeStart';
      else if (daysBetween(from, to) + 1 > MAX_PERIOD_DAYS) problems.to = 'validation.invalid';
    }
    if (Object.keys(problems).length) throw validationFailed(problems);
  }

  private async worker(employeeId: string): Promise<WorkerRow> {
    const row = await this.prisma.employee.findUnique({ where: { id: employeeId }, include: { person: true, client: { select: { id: true, number: true, name: true } } } });
    if (!row) throw new NotFoundException({ code: 'not_found', message: 'Employee not found' });
    return row;
  }

  /**
   * The holiday allowance and the vacation build-up: the worker's latest signed contract decides when it says so, otherwise the office's settings. The standard contract
   * form asks only for the allowance; the build-up per hour (`vacation_hours_per_hour`) counts only on contracts that hold it (older ones, or a field the office adds).
   */
  private async terms(worker: WorkerRow, day: string): Promise<PayTerms> {
    const setting = (name: string) => this.settings.get<number>(`${HOURS_NAMESPACE}.${name}`);
    const terms: PayTerms = { allowancePercent: setting('holidayAllowancePercent'), vacationAccrualPercent: setting('vacationAccrualPercent'), source: 'settings' };
    const contract = await this.prisma.contract.findFirst({
      where: { employeeId: worker.id, status: { in: ['active', 'ended', 'terminated'] }, startDate: { lte: parseDay(day) } },
      orderBy: { startDate: 'desc' },
      select: { data: true },
    });
    const data = asRecord(contract?.data);
    const allowance = Number(data.holiday_allowance_percent);
    const vacation = Number(data.vacation_hours_per_hour);
    if (data.holiday_allowance_percent !== undefined && Number.isFinite(allowance) && allowance >= 0) {
      terms.allowancePercent = Math.round(allowance);
      terms.source = 'contract';
    }
    if (data.vacation_hours_per_hour !== undefined && Number.isFinite(vacation) && vacation >= 0) {
      terms.vacationAccrualPercent = Math.round(vacation * 100);
      terms.source = 'contract';
    }
    return terms;
  }

  /** What the office should look at before paying: days outside the worker's employment or contracts, days that are too long. */
  private async advice(worker: WorkerRow, inPeriod: PayEntry[], to: string): Promise<PayWarning[]> {
    const warnings: PayWarning[] = [];
    const flag = (name: string) => this.settings.get<boolean>(`${HOURS_NAMESPACE}.${name}`);
    const dates = (predicate: (entry: PayEntry) => boolean) => [...new Set(inPeriod.filter(predicate).map(entry => entry.date))];

    if (flag('warnOutsideEmployment')) {
      const first = worker.startDate ? formatDay(worker.startDate) : null;
      const last = worker.endDate ? formatDay(worker.endDate) : null;
      const outside = dates(entry => Boolean((first && entry.date < first) || (last && entry.date > last)));
      if (outside.length) warnings.push({ code: 'outside_employment', severity: 'warning', dates: outside.slice(0, 8), params: { count: outside.length } });
    }

    if (flag('warnOutsideContract')) {
      const contracts = await this.prisma.contract.findMany({
        where: { employeeId: worker.id, status: { in: ['active', 'ended', 'terminated'] } },
        select: { startDate: true, endDate: true, terminatedOn: true },
      });
      if (contracts.length) {
        const spans = contracts.map(contract => ({ from: formatDay(contract.startDate), to: contract.terminatedOn ? formatDay(contract.terminatedOn) : contract.endDate ? formatDay(contract.endDate) : null }));
        const outside = dates(entry => !spans.some(span => span.from <= entry.date && (span.to === null || entry.date <= span.to)));
        if (outside.length) warnings.push({ code: 'outside_contract', severity: 'warning', dates: outside.slice(0, 8), params: { count: outside.length } });
      }
    }

    const max = this.settings.get<number>(`${HOURS_NAMESPACE}.maxHoursPerDay`) * 60;
    const perDay = new Map<string, number>();
    for (const entry of inPeriod) perDay.set(entry.date, (perDay.get(entry.date) ?? 0) + entry.minutes);
    const long = [...perDay].filter(([, minutes]) => minutes > max).map(([date]) => date);
    if (long.length) warnings.push({ code: 'day_too_long', severity: 'warning', dates: long.slice(0, 8), params: { count: long.length, hours: max / 60 } });

    // A period that reaches into the future is worth a word: the hours are not worked yet.
    if (to > todayInAmsterdam()) warnings.push({ code: 'period_in_future', severity: 'info' });
    return warnings;
  }
}
