import { addDays } from '../../common/dates.js';
import { WEEKDAY_CODES, mondayOf, overlapMinutes, parseClock, roundDiv, spanMinutes, weekdayCode, type WeekdayCode } from './hours-time.js';

/*
 * Gross pay for a stretch of worked days: hours × hourly rate, plus the surcharges the office switched on. A pure function of its input — the
 * calendar (weekend / holiday), the rules and the rates are handed in — so a preview, a salary statement and the checks all agree to the cent.
 * Money is whole cents and every division rounds half up (`roundDiv`); nothing here uses a floating-point amount.
 */

export const SURCHARGE_KINDS = ['weekend', 'holiday', 'overtime', 'evening'] as const;
export type SurchargeKind = (typeof SURCHARGE_KINDS)[number];

export interface PayEntry {
  id: string;
  date: string;
  minutes: number;
  startTime: string | null;
  endTime: string | null;
  breakMinutes: number;
  /** The hourly rate in cents that applied that day (`null` = no rate known). */
  rateCents: number | null;
  clientId: string;
  /** Where the work was done, as text for the statement. */
  where: string;
}

export interface PayRule {
  id: string;
  name: string;
  kind: SurchargeKind;
  /** weekend — `{ days: ['sat'] }` · overtime — `{ per: 'day' | 'week', afterMinutes }` · evening — `{ from: '20:00', to: '24:00' }`. */
  conditions: Record<string, unknown>;
  /** The percentage × 100 (25 % = 2500), or `null` when the rule pays a fixed amount per hour. */
  percentBp: number | null;
  perHourCents: number | null;
  /** Only for entries of this client; `null` = every client. */
  clientId: string | null;
}

export interface DayKind {
  weekend: boolean;
  holiday: boolean;
}

export interface PayInput {
  from: string;
  to: string;
  /** The worker's entries — at least those of the period, and for week-based overtime also the rest of the weeks the period touches. */
  entries: PayEntry[];
  rules: PayRule[];
  dayKind: (day: string, clientId: string) => DayKind;
  /** Whole percent (8 = 8 %). */
  allowancePercent: number;
  /** Vacation hours built up per 100 hours worked (10 = 0,1 hour per hour). */
  vacationAccrualPercent: number;
}

export interface PayLine {
  type: 'work' | 'surcharge';
  date: string;
  minutes: number;
  rateCents: number | null;
  where: string;
  /** A surcharge: the rule's name. */
  label: string;
  ruleId?: string;
  kind?: SurchargeKind;
  percentBp?: number | null;
  perHourCents?: number | null;
  amountCents: number;
  entryIds: string[];
}

export interface PayIssue {
  code: 'rate_missing' | 'evening_needs_times';
  date?: string;
  entryId?: string;
  ruleName?: string;
}

export interface PayTotals {
  minutes: number;
  days: number;
  baseCents: number;
  surchargeCents: number;
  grossCents: number;
  allowancePercent: number;
  allowanceCents: number;
  totalCents: number;
  vacationMinutes: number;
}

export interface PayResult {
  lines: PayLine[];
  totals: PayTotals;
  issues: PayIssue[];
}

const WEEKEND_ALL: readonly WeekdayCode[] = WEEKDAY_CODES;

/** The cents a rule pays for `minutes` of an entry paid at `rateCents` per hour. */
function surchargeCents(rule: PayRule, minutes: number, rateCents: number | null): number {
  if (rule.perHourCents !== null) return roundDiv(minutes * rule.perHourCents, 60);
  if (rule.percentBp !== null && rateCents !== null) return roundDiv(minutes * rateCents * rule.percentBp, 60 * 10_000);
  return 0;
}

/** The minutes of one entry the rule applies to, given what the rule is about. Overtime is worked out separately (it needs the whole day or week). */
function directMinutes(rule: PayRule, entry: PayEntry, kind: DayKind, issues: PayIssue[]): number {
  switch (rule.kind) {
    case 'holiday':
      return kind.holiday ? entry.minutes : 0;
    case 'weekend': {
      // A public holiday on a Saturday is paid as a holiday, not twice.
      if (!kind.weekend || kind.holiday) return 0;
      const days = Array.isArray(rule.conditions.days) && rule.conditions.days.length ? (rule.conditions.days as WeekdayCode[]) : WEEKEND_ALL;
      return days.includes(weekdayCode(entry.date)) ? entry.minutes : 0;
    }
    case 'evening': {
      const from = parseClock(rule.conditions.from);
      const to = parseClock(rule.conditions.to);
      if (from === null || to === null) return 0;
      const start = parseClock(entry.startTime);
      const end = parseClock(entry.endTime);
      if (start === null || end === null) {
        issues.push({ code: 'evening_needs_times', entryId: entry.id, ruleName: rule.name });
        return 0;
      }
      const length = spanMinutes(start, end);
      if (length === null) return 0;
      return Math.min(entry.minutes, overlapMinutes(start, length, from, to));
    }
    default:
      return 0;
  }
}

/** Overtime of every entry: the minutes after the threshold, counted day by day or week by week from the first entry onwards. */
function overtimeMinutes(rule: PayRule, entries: PayEntry[]): Map<string, number> {
  const after = typeof rule.conditions.afterMinutes === 'number' && rule.conditions.afterMinutes >= 0 ? rule.conditions.afterMinutes : null;
  const result = new Map<string, number>();
  if (after === null) return result;
  const bucket = (entry: PayEntry) => (rule.conditions.per === 'week' ? mondayOf(entry.date) : entry.date);
  const counted = new Map<string, number>();
  for (const entry of entries) {
    if (rule.clientId && rule.clientId !== entry.clientId) continue;
    const key = bucket(entry);
    const before = counted.get(key) ?? 0;
    const upTo = before + entry.minutes;
    counted.set(key, upTo);
    const over = Math.max(0, Math.min(entry.minutes, upTo - Math.max(before, after)));
    if (over > 0) result.set(entry.id, over);
  }
  return result;
}

/** Entries in the order the work was done: by day, then by start time, then as entered. */
const chronological = (a: PayEntry, b: PayEntry): number => a.date.localeCompare(b.date) || (a.startTime ?? '99:99').localeCompare(b.startTime ?? '99:99') || a.id.localeCompare(b.id);

export function calculatePay(input: PayInput): PayResult {
  const issues: PayIssue[] = [];
  const everything = [...input.entries].sort(chronological);
  const inPeriod = everything.filter(entry => entry.date >= input.from && entry.date <= input.to);

  const lines: PayLine[] = [];
  for (const entry of inPeriod) {
    if (entry.rateCents === null) issues.push({ code: 'rate_missing', date: entry.date, entryId: entry.id });
    lines.push({
      type: 'work',
      date: entry.date,
      minutes: entry.minutes,
      rateCents: entry.rateCents,
      where: entry.where,
      label: '',
      amountCents: entry.rateCents === null ? 0 : roundDiv(entry.minutes * entry.rateCents, 60),
      entryIds: [entry.id],
    });
  }

  // One surcharge line per day and rule: the minutes and the amount of that day's entries added up.
  const periodIds = new Set(inPeriod.map(entry => entry.id));
  for (const rule of input.rules) {
    const overtime = rule.kind === 'overtime' ? overtimeMinutes(rule, everything) : null;
    const perDay = new Map<string, PayLine>();
    for (const entry of inPeriod) {
      if (rule.clientId && rule.clientId !== entry.clientId) continue;
      const minutes = overtime ? (overtime.get(entry.id) ?? 0) : directMinutes(rule, entry, input.dayKind(entry.date, entry.clientId), issues);
      if (minutes <= 0 || !periodIds.has(entry.id)) continue;
      const cents = surchargeCents(rule, minutes, entry.rateCents);
      const line = perDay.get(entry.date) ?? { type: 'surcharge', date: entry.date, minutes: 0, rateCents: entry.rateCents, where: '', label: rule.name, ruleId: rule.id, kind: rule.kind, percentBp: rule.percentBp, perHourCents: rule.perHourCents, amountCents: 0, entryIds: [] };
      line.minutes += minutes;
      line.amountCents += cents;
      line.entryIds.push(entry.id);
      perDay.set(entry.date, line);
    }
    lines.push(...perDay.values());
  }

  // A day's work first, then its surcharges, in the order the rules are set up.
  const ruleOrder = new Map(input.rules.map((rule, index) => [rule.id, index]));
  lines.sort((a, b) => a.date.localeCompare(b.date) || Number(a.type === 'surcharge') - Number(b.type === 'surcharge') || (ruleOrder.get(a.ruleId ?? '') ?? 0) - (ruleOrder.get(b.ruleId ?? '') ?? 0));

  const work = lines.filter(line => line.type === 'work');
  const baseCents = work.reduce((sum, line) => sum + line.amountCents, 0);
  const extraCents = lines.filter(line => line.type === 'surcharge').reduce((sum, line) => sum + line.amountCents, 0);
  const grossCents = baseCents + extraCents;
  const minutes = work.reduce((sum, line) => sum + line.minutes, 0);
  const allowanceCents = roundDiv(grossCents * input.allowancePercent, 100);
  return {
    lines,
    issues,
    totals: {
      minutes,
      days: new Set(work.map(line => line.date)).size,
      baseCents,
      surchargeCents: extraCents,
      grossCents,
      allowancePercent: input.allowancePercent,
      allowanceCents,
      totalCents: grossCents + allowanceCents,
      vacationMinutes: roundDiv(minutes * input.vacationAccrualPercent, 100),
    },
  };
}

/** The days of the weeks that `from → to` touches, so week-based overtime sees the whole week. */
export function weekSpan(from: string, to: string): { from: string; to: string } {
  return { from: mondayOf(from), to: addDays(mondayOf(to), 6) };
}
