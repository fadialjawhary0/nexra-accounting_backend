import { addDays, addMonths, formatDay, parseDay } from '../../common/dates.js';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import type { VatKind } from './taxes.constants.js';

/** A stretch of time a VAT return is about: a quarter, a month or a year. Days are `YYYY-MM-DD` strings (see common/dates). */
export interface PeriodRange {
  kind: VatKind;
  start: string;
  end: string;
  year: number;
  /** The quarter (1–4), the month (1–12) or 1 for a year. */
  number: number;
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** The last day of a month (`month` is 1–12). */
export const lastDayOf = (year: number, month: number): string => formatDay(new Date(Date.UTC(year, month, 0)));

const isLastDayOfMonth = (day: string): boolean => lastDayOf(Number(day.slice(0, 4)), Number(day.slice(5, 7))) === day;

/** `day` + months; the last day of a month stays the last day of a month (31 Dec + 5 months = 31 May, 28 Feb + 1 month = 31 Mar). */
export function addMonthsKeepEnd(day: string, months: number): string {
  if (!isLastDayOfMonth(day)) return addMonths(day, months);
  const moved = addMonths(`${day.slice(0, 8)}01`, months);
  return lastDayOf(Number(moved.slice(0, 4)), Number(moved.slice(5, 7)));
}

/** The quarter, month or year (by `kind`) that holds `day`. */
export function periodContaining(kind: VatKind, day: string): PeriodRange {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  if (kind === 'month') return { kind, start: `${year}-${pad(month)}-01`, end: lastDayOf(year, month), year, number: month };
  if (kind === 'quarter') {
    const quarter = Math.floor((month - 1) / 3) + 1;
    const first = (quarter - 1) * 3 + 1;
    return { kind, start: `${year}-${pad(first)}-01`, end: lastDayOf(year, first + 2), year, number: quarter };
  }
  return { kind, start: `${year}-01-01`, end: `${year}-12-31`, year, number: 1 };
}

export const previousPeriod = (range: PeriodRange): PeriodRange => periodContaining(range.kind, addDays(range.start, -1));
export const nextPeriod = (range: PeriodRange): PeriodRange => periodContaining(range.kind, addDays(range.end, 1));

/** `2026-Q3` · `2026-09` · `2026` — how a period is named in URLs and filters. */
export function periodKey(range: Pick<PeriodRange, 'kind' | 'year' | 'number'>): string {
  if (range.kind === 'quarter') return `${range.year}-Q${range.number}`;
  if (range.kind === 'month') return `${range.year}-${pad(range.number)}`;
  return String(range.year);
}

export function parsePeriodKey(key: string | undefined): PeriodRange | null {
  const value = (key ?? '').trim();
  const quarter = /^(\d{4})-Q([1-4])$/i.exec(value);
  if (quarter) return periodContaining('quarter', `${quarter[1]}-${pad((Number(quarter[2]) - 1) * 3 + 1)}-01`);
  const month = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value);
  if (month) return periodContaining('month', `${month[1]}-${month[2]}-01`);
  const year = /^(\d{4})$/.exec(value);
  if (year) return periodContaining('year', `${year[1]}-01-01`);
  return null;
}

/** The range of a stored period (its first day decides). */
export const rangeOf = (kind: string, start: string): PeriodRange => periodContaining(kind === 'month' || kind === 'year' ? kind : 'quarter', start);

/** "Q3 2026" · "september 2026" · "2026". */
export function periodLabel(range: Pick<PeriodRange, 'kind' | 'year' | 'number' | 'start'>, locale: AppLocale): string {
  if (range.kind === 'quarter') return `Q${range.number} ${range.year}`;
  if (range.kind === 'month') return new Intl.DateTimeFormat(locale === 'nl' ? 'nl-NL' : 'en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(parseDay(range.start));
  return String(range.year);
}

/** The year a return is named after (a financial year is named after the year it starts in) and its first and last day. */
export const calendarYear = (year: number): { start: string; end: string } => ({ start: `${year}-01-01`, end: `${year}-12-31` });
