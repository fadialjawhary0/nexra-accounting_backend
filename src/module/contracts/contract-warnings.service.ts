import { Injectable } from '@nestjs/common';
import { addDays, formatDay } from '../../common/dates.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { SettingsService } from '../../lib/settings/settings.service.js';
import { CalendarService } from '../calendar/calendar.service.js';
import { CONTRACTS_NAMESPACE, CONTRACTS_DEFINITIONS } from './contracts.settings.js';
import { TYPE_RULES, addMonths, isContractType, monthsBetween } from './contract-record.js';

export type WarningSeverity = 'error' | 'warning' | 'info';

/** One thing to look at before a contract is made. The screen writes the text from `code` and `params`. */
export interface ContractWarning {
  code: string;
  severity: WarningSeverity;
  /** The form field it is about (shown next to the field). */
  field?: string;
  params?: Record<string, string | number>;
}

export interface WarningInput {
  clientId: string;
  employeeId: string;
  type: string | null;
  startDate: string | null;
  endDate: string | null;
  probationMonths: number;
  hourlyRate: number | null;
  monthlySalary: number | null;
  /** The contract being edited: it is left out of the overlap and chain checks. */
  excludeId?: string | null;
}

/** Statutory limits behind the warnings (Dutch civil code, art. 7:652 probation, 7:668a chain rule, 7:668 notice; docs/09). */
const LAW = {
  /** A fixed-term contract of this many months or less may not have a probation period. */
  noProbationUpToMonths: 6,
  /** Under two years: at most 1 month; two years or longer (and permanent): at most 2. */
  shortProbationMonths: 1,
  longProbationMonths: 2,
  twoYearsInMonths: 24,
  /** More than this many fixed-term contracts in a chain, or more than this many months in total, and the next contract is permanent. */
  chainMaxContracts: 3,
  chainMaxMonths: 36,
  /** A break longer than this ends the chain — 6 months today, 36 months once the "Wet meer zekerheid flexwerkers" is in force. */
  chainBreakMonths: 6,
  chainBreakMonthsFrom2028: 36,
  /** The law that changes flexible contracts (bandwidth contract instead of zero-hour / min-max) is mostly in force from this day. */
  flexLawDate: '2028-01-01',
  /** After this many months an on-call worker must be offered a fixed number of hours. */
  onCallOfferMonths: 12,
  /** A fixed-term contract of at least this many months must be (not) renewed in writing, a month before it ends. */
  noticeFromMonths: 6,
};

const HOURLY_TYPES = new Set(['on_call', 'freelance', 'services']);
const MONTHLY_TYPES = new Set(['fixed_term', 'permanent', 'internship']);
const RANK: Record<WarningSeverity, number> = { error: 0, warning: 1, info: 2 };

/** Whether a contract from `start` to `end` lasts `months` months or less. */
const lastsAtMost = (start: string, end: string, months: number): boolean => end <= addDays(addMonths(start, months), -1);

/**
 * The advice shown while a contract is made and on its page: dates on weekends and holidays (through the Netherlands calendar), probation that
 * is not allowed, the chain rule, the on-call rule, the 2028 law, overlapping contracts and missing wages. Each group can be switched off in
 * Settings → Contracts. Only the first few are mistakes (an end before the start); everything else is advice and never blocks saving.
 */
@Injectable()
export class ContractWarningsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly calendar: CalendarService,
  ) {
    settings.register(CONTRACTS_NAMESPACE, CONTRACTS_DEFINITIONS, { exposed: true });
  }

  async check(input: WarningInput): Promise<ContractWarning[]> {
    const on = (name: keyof typeof CONTRACTS_DEFINITIONS) => this.settings.get<boolean>(`${CONTRACTS_NAMESPACE}.${name}`);
    const found: ContractWarning[] = [];
    const add = (warning: ContractWarning) => found.push(warning);
    const { type, startDate: start, endDate: end } = input;
    const rules = isContractType(type) ? TYPE_RULES[type] : null;
    const endsAt = rules?.end === 'none' ? null : end;

    /* Mistakes */
    if (!start) add({ code: 'start_missing', severity: 'error', field: 'start_date' });
    if (start && endsAt && endsAt < start) add({ code: 'end_before_start', severity: 'error', field: 'end_date' });
    if (rules?.end === 'required' && !endsAt) add({ code: 'end_required', severity: 'error', field: 'end_date' });

    /* The Netherlands calendar: weekends and holidays */
    if (on('warnNonWorkingDays')) {
      for (const [field, day, code] of [
        ['start_date', start, 'start_non_working'],
        ['end_date', endsAt, 'end_non_working'],
      ] as const) {
        if (!day || this.calendar.isWorkingDay(day, input.clientId)) continue;
        const holiday = this.calendar.holidayOn(day, input.clientId);
        add({ code, severity: 'warning', field, params: { date: day, reason: holiday ? 'holiday' : 'weekend', ...(holiday && { holiday: holiday.nameNl }) } });
      }
    }

    /* Probation */
    if (start && rules?.employment && type !== 'internship' && on('warnProbation') && input.probationMonths > 0) {
      let allowed = LAW.longProbationMonths;
      if (endsAt) {
        if (lastsAtMost(start, endsAt, LAW.noProbationUpToMonths)) allowed = 0;
        else if (endsAt < addDays(addMonths(start, LAW.twoYearsInMonths), -1)) allowed = LAW.shortProbationMonths;
      }
      if (allowed === 0) add({ code: 'probation_not_allowed', severity: 'warning', field: 'probation_months' });
      else if (input.probationMonths > allowed) add({ code: 'probation_too_long', severity: 'warning', field: 'probation_months', params: { max: allowed } });
    }

    /* Notice of (non-)renewal: a fixed-term contract of 6 months or more */
    if (start && endsAt && type === 'fixed_term' && endsAt >= addDays(addMonths(start, LAW.noticeFromMonths), -1)) {
      add({ code: 'notice_required', severity: 'info', field: 'end_date', params: { deadline: this.calendar.previousWorkingDay(addMonths(endsAt, -1)) } });
    }

    /* On-call: a fixed number of hours must be offered after 12 months */
    if (on('warnOnCall') && type === 'on_call' && start && (!endsAt || !lastsAtMost(start, endsAt, LAW.onCallOfferMonths - 1))) {
      add({ code: 'on_call_year', severity: 'info', field: 'end_date', params: { months: LAW.onCallOfferMonths } });
    }

    /* The flexible-work law of 2028 */
    if (on('warnLaw2028') && type === 'on_call' && (!endsAt || endsAt >= LAW.flexLawDate)) {
      add({ code: 'law_2028', severity: 'info', field: 'type', params: { date: LAW.flexLawDate } });
    }

    /* Wage */
    if (on('warnWage') && type) {
      if (HOURLY_TYPES.has(type) && input.hourlyRate === null) add({ code: 'wage_missing', severity: 'warning', field: 'hourly_rate' });
      if (MONTHLY_TYPES.has(type) && input.monthlySalary === null) add({ code: 'wage_missing', severity: 'warning', field: 'monthly_salary' });
    }

    /* The worker and the client */
    const employee = await this.prisma.employee.findUnique({ where: { id: input.employeeId }, select: { isActive: true, startDate: true, endDate: true, client: { select: { isActive: true } } } });
    if (employee) {
      if (!employee.isActive) add({ code: 'worker_stopped', severity: 'warning' });
      if (!employee.client.isActive) add({ code: 'client_stopped', severity: 'warning' });
      const workerStart = employee.startDate ? formatDay(employee.startDate) : null;
      const workerEnd = employee.endDate ? formatDay(employee.endDate) : null;
      if (start && workerStart && start < workerStart) add({ code: 'before_worker_start', severity: 'info', field: 'start_date', params: { date: workerStart } });
      if (workerEnd && (!endsAt || endsAt > workerEnd)) add({ code: 'after_worker_end', severity: 'warning', field: 'end_date', params: { date: workerEnd } });
    }

    /* Other contracts of the same worker */
    if (start && (on('warnOverlap') || on('warnChain'))) {
      const others = await this.prisma.contract.findMany({
        where: { employeeId: input.employeeId, status: { not: 'cancelled' }, ...(input.excludeId && { id: { not: input.excludeId } }) },
        select: { id: true, type: true, status: true, startDate: true, endDate: true, terminatedOn: true },
        orderBy: { startDate: 'asc' },
      });
      const effective = others.map(other => ({ id: other.id, type: other.type, status: other.status, start: formatDay(other.startDate), end: other.terminatedOn ? formatDay(other.terminatedOn) : other.endDate ? formatDay(other.endDate) : null }));

      if (on('warnOverlap')) {
        const open = effective.find(other => ['draft', 'sent', 'active'].includes(other.status) && other.start <= (endsAt ?? '9999-12-31') && (other.end ?? '9999-12-31') >= start);
        if (open) add({ code: 'overlap', severity: 'warning', params: { id: open.id, start: open.start, end: open.end ?? '' } });
      }

      if (on('warnChain') && type === 'fixed_term' && rules?.employment) {
        const breakMonths = start >= LAW.flexLawDate ? LAW.chainBreakMonthsFrom2028 : LAW.chainBreakMonths;
        // Walk back from the new contract through the fixed-term contracts that follow each other (a break of more than 6 months ends the chain).
        let count = 1;
        let months = endsAt ? (monthsBetween(start, endsAt) ?? 0) : 0;
        let from = start;
        for (const other of [...effective].filter(entry => entry.type === 'fixed_term' && entry.end && entry.start < start).sort((a, b) => b.start.localeCompare(a.start))) {
          if (other.end! < addMonths(from, -breakMonths)) break;
          count += 1;
          months += monthsBetween(other.start, other.end) ?? 0;
          from = other.start;
        }
        if (count > LAW.chainMaxContracts) add({ code: 'chain_count', severity: 'warning', params: { count, max: LAW.chainMaxContracts } });
        else if (months > LAW.chainMaxMonths) add({ code: 'chain_months', severity: 'warning', params: { months, max: LAW.chainMaxMonths } });
        else if (count === LAW.chainMaxContracts) add({ code: 'chain_last', severity: 'info', params: { count, max: LAW.chainMaxContracts } });
      }
    }

    return found.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  }
}
