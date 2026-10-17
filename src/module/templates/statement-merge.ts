import { addDays, parseDay } from '../../common/dates.js';
import { euro, longDay, plainNumber, shortDay, type DocLocale } from './merge-format.js';

/*
 * The data of a salary statement for its Word template: the `statement` group (`{statement.period_text}`, `{statement.total_amount}`, and the table
 * rows `{#statement.lines}{date} {description} {hours} {rate} {amount}{/statement.lines}`). Everything is text, already written the way the
 * document needs it; the statement itself (hours × rate + surcharges, the allowance) is worked out elsewhere and only formatted here.
 */

export interface StatementLineInput {
  type: 'work' | 'surcharge';
  date: string;
  minutes: number;
  rateCents: number | null;
  where: string;
  label: string;
  percentBp?: number | null;
  perHourCents?: number | null;
  amountCents: number;
}

export interface StatementInput {
  from: string;
  to: string;
  note: string;
  createdOn: string;
  totals: {
    minutes: number;
    days: number;
    baseCents: number;
    surchargeCents: number;
    grossCents: number;
    allowancePercent: number;
    allowanceCents: number;
    totalCents: number;
    vacationMinutes: number;
  };
  lines: StatementLineInput[];
}

const INTL: Record<DocLocale, string> = { nl: 'nl-NL', en: 'en-GB' };

const cents = (value: number, locale: DocLocale): string => euro(value / 100, locale);
/** 450 minutes → `7,5` (Dutch) / `7.5` (English). */
const hours = (minutes: number, locale: DocLocale): string => plainNumber(Math.round((minutes / 60) * 100) / 100, locale);
/** 450 minutes → `7:30`. */
const clock = (minutes: number): string => `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
const weekday = (day: string, locale: DocLocale): string => new Intl.DateTimeFormat(INTL[locale], { weekday: 'short', timeZone: 'UTC' }).format(parseDay(day));

/** The first and last day of a calendar month: when a statement covers exactly one, the template can say "september 2026". */
const wholeMonth = (from: string, to: string): boolean => from.slice(0, 7) === to.slice(0, 7) && from.endsWith('-01') && addDays(to, 1).endsWith('-01');

function percentText(basisPoints: number): string {
  const value = basisPoints / 100;
  return `+${Number.isInteger(value) ? value : value.toFixed(2).replace(/0+$/, '')}%`;
}

/** The `statement` group for the template. */
export function statementData(input: StatementInput, locale: DocLocale): Record<string, unknown> {
  const { totals } = input;
  const monthName = (day: string) => new Intl.DateTimeFormat(INTL[locale], { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(parseDay(day));
  return {
    period_from: shortDay(input.from),
    period_to: shortDay(input.to),
    period_from_long: longDay(input.from, locale),
    period_to_long: longDay(input.to, locale),
    period_text: locale === 'nl' ? `van ${shortDay(input.from)} tot en met ${shortDay(input.to)}` : `from ${shortDay(input.from)} up to and including ${shortDay(input.to)}`,
    month_text: wholeMonth(input.from, input.to) ? monthName(input.from) : '',
    total_hours: hours(totals.minutes, locale),
    total_hours_text: locale === 'nl' ? `${hours(totals.minutes, locale)} uur` : `${hours(totals.minutes, locale)} hours`,
    total_time: clock(totals.minutes),
    days_count: String(totals.days),
    base_amount: cents(totals.baseCents, locale),
    surcharge_amount: cents(totals.surchargeCents, locale),
    gross_amount: cents(totals.grossCents, locale),
    allowance_percent: plainNumber(totals.allowancePercent, locale),
    allowance_amount: cents(totals.allowanceCents, locale),
    total_amount: cents(totals.totalCents, locale),
    vacation_hours: hours(totals.vacationMinutes, locale),
    created_on: shortDay(input.createdOn),
    note: input.note,
    has_surcharges: totals.surchargeCents > 0 ? '1' : '',
    has_allowance: totals.allowancePercent > 0 ? '1' : '',
    has_vacation: totals.vacationMinutes > 0 ? '1' : '',
    has_note: input.note ? '1' : '',
    lines: input.lines.map(line => {
      const work = line.type === 'work';
      return {
        date: shortDay(line.date),
        weekday: weekday(line.date, locale),
        hours: hours(line.minutes, locale),
        time: clock(line.minutes),
        description: work ? line.where || (locale === 'nl' ? 'Gewerkt' : 'Worked') : [line.label, line.percentBp ? percentText(line.percentBp) : line.perHourCents ? `+${euro(line.perHourCents / 100, locale)}/${locale === 'nl' ? 'uur' : 'hour'}` : ''].filter(Boolean).join(' '),
        where: work ? line.where : '',
        label: work ? '' : line.label,
        rate: work ? (line.rateCents === null ? '' : cents(line.rateCents, locale)) : '',
        amount: cents(line.amountCents, locale),
        is_work: work ? '1' : '',
        is_surcharge: work ? '' : '1',
      };
    }),
  };
}

export interface StatementField {
  key: string;
  nl: string;
  en: string;
  type: 'text' | 'date' | 'number' | 'flag';
}

/** What the helper next to a statement template lists (the loop's own fields are explained in `STATEMENT_LINE_FIELDS`). */
export const STATEMENT_FIELDS: StatementField[] = [
  { key: 'period_from', nl: 'Eerste dag van de periode', en: 'First day of the period', type: 'date' },
  { key: 'period_to', nl: 'Laatste dag van de periode', en: 'Last day of the period', type: 'date' },
  { key: 'period_from_long', nl: 'Eerste dag van de periode (voluit)', en: 'First day of the period (in words)', type: 'text' },
  { key: 'period_to_long', nl: 'Laatste dag van de periode (voluit)', en: 'Last day of the period (in words)', type: 'text' },
  { key: 'period_text', nl: 'Periode in een zin (“van … tot en met …”)', en: 'Period as a sentence (“from … up to and including …”)', type: 'text' },
  { key: 'month_text', nl: 'De maand (“september 2026”) — leeg als de periode geen hele maand is', en: 'The month (“September 2026”) — empty when the period is not a whole month', type: 'text' },
  { key: 'total_hours', nl: 'Totaal aantal uren (7,5)', en: 'Total hours (7.5)', type: 'number' },
  { key: 'total_hours_text', nl: 'Totaal aantal uren met het woord “uur”', en: 'Total hours with the word “hours”', type: 'text' },
  { key: 'total_time', nl: 'Totaal als tijd (7:30)', en: 'Total as time (7:30)', type: 'text' },
  { key: 'days_count', nl: 'Aantal gewerkte dagen', en: 'Number of days worked', type: 'number' },
  { key: 'base_amount', nl: 'Loon over de uren (uren × uurloon)', en: 'Wages for the hours (hours × hourly rate)', type: 'text' },
  { key: 'surcharge_amount', nl: 'Toeslagen', en: 'Surcharges', type: 'text' },
  { key: 'gross_amount', nl: 'Brutoloon (loon + toeslagen)', en: 'Gross wages (wages + surcharges)', type: 'text' },
  { key: 'allowance_percent', nl: 'Percentage vakantietoeslag', en: 'Holiday allowance percentage', type: 'number' },
  { key: 'allowance_amount', nl: 'Vakantietoeslag', en: 'Holiday allowance', type: 'text' },
  { key: 'total_amount', nl: 'Totaal bruto inclusief vakantietoeslag', en: 'Total gross including holiday allowance', type: 'text' },
  { key: 'vacation_hours', nl: 'Opgebouwde vakantie-uren', en: 'Vacation hours built up', type: 'number' },
  { key: 'created_on', nl: 'Datum waarop de loonstaat is gemaakt', en: 'Date the statement was made', type: 'date' },
  { key: 'note', nl: 'Opmerking bij de loonstaat', en: 'Note on the statement', type: 'text' },
  { key: 'has_surcharges', nl: 'Blok alleen als er toeslagen zijn: {#statement.has_surcharges} … {/statement.has_surcharges}', en: 'Block only when there are surcharges: {#statement.has_surcharges} … {/statement.has_surcharges}', type: 'flag' },
  { key: 'has_allowance', nl: 'Blok alleen als er vakantietoeslag is', en: 'Block only when there is a holiday allowance', type: 'flag' },
  { key: 'has_vacation', nl: 'Blok alleen als er vakantie-uren worden opgebouwd', en: 'Block only when vacation hours are built up', type: 'flag' },
  { key: 'has_note', nl: 'Blok alleen als er een opmerking is', en: 'Block only when there is a note', type: 'flag' },
  { key: 'lines', nl: 'De regels (herhaald): {#statement.lines} … {/statement.lines} — daarbinnen: {date} {weekday} {hours} {description} {rate} {amount}', en: 'The lines (repeated): {#statement.lines} … {/statement.lines} — inside: {date} {weekday} {hours} {description} {rate} {amount}', type: 'text' },
];

/** Made-up statement for a template preview: a month with a few weeks of work, one surcharge line. */
export function sampleStatement(today: string): StatementInput {
  const first = `${today.slice(0, 7)}-01`;
  const day = (offset: number) => addDays(first, offset);
  const work = (offset: number, minutes: number, where: string): StatementLineInput => ({ type: 'work', date: day(offset), minutes, rateCents: 1625, where, label: '', amountCents: Math.round((minutes * 1625) / 60) });
  const lines: StatementLineInput[] = [
    work(0, 480, 'Kerkstraat 1, Utrecht'),
    work(1, 480, 'Kerkstraat 1, Utrecht'),
    work(2, 450, 'Kerkstraat 1, Utrecht'),
    { type: 'surcharge', date: day(2), minutes: 120, rateCents: 1625, where: '', label: 'Avonduren', percentBp: 1000, perHourCents: null, amountCents: Math.round((120 * 1625 * 1000) / (60 * 10_000)) },
    work(3, 480, 'Kerkstraat 1, Utrecht'),
  ];
  const base = lines.filter(line => line.type === 'work').reduce((sum, line) => sum + line.amountCents, 0);
  const extra = lines.filter(line => line.type === 'surcharge').reduce((sum, line) => sum + line.amountCents, 0);
  const gross = base + extra;
  const allowance = Math.round(gross * 0.08);
  const minutes = lines.filter(line => line.type === 'work').reduce((sum, line) => sum + line.minutes, 0);
  return {
    from: first,
    to: new Date(Date.UTC(parseDay(first).getUTCFullYear(), parseDay(first).getUTCMonth() + 1, 0)).toISOString().slice(0, 10),
    note: '',
    createdOn: today,
    totals: { minutes, days: 4, baseCents: base, surchargeCents: extra, grossCents: gross, allowancePercent: 8, allowanceCents: allowance, totalCents: gross + allowance, vacationMinutes: 0 },
    lines,
  };
}
