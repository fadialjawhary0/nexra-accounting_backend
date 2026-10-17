import { addDays, parseDay } from '../../common/dates.js';
import { euro, longDay, plainNumber, shortDay, type DocLocale } from './merge-format.js';

/*
 * The data of an invoice for its Word template: the `invoice` group (`{invoice.number}`, `{invoice.total}`, the table rows
 * `{#invoice.lines}{description} {period} {hours} {rate} {amount}{/invoice.lines}`) — next to `recipient.*` (the other company), `client.*` (the issuer)
 * and `office.*`. Everything is text, already written the way the document needs it; the amounts are worked out elsewhere and only formatted here.
 */

export interface InvoiceLineInput {
  kind: 'hours' | 'markup' | 'other';
  /** The worker's name as it stands on the invoice (empty for lines without a worker). */
  worker: string;
  description: string;
  from: string | null;
  to: string | null;
  minutes: number;
  rateCents: number | null;
  amountCents: number;
}

export interface InvoiceInput {
  number: string;
  credit: boolean;
  /** The number of the invoice a credit note takes back. */
  creditOfNumber: string;
  date: string;
  dueDate: string;
  periodFrom: string;
  periodTo: string;
  vatPercent: number;
  vatShifted: boolean;
  subtotalCents: number;
  vatCents: number;
  totalCents: number;
  gAccountPercent: number;
  gAccountCents: number;
  paymentDays: number;
  lines: InvoiceLineInput[];
}

const INTL: Record<DocLocale, string> = { nl: 'nl-NL', en: 'en-GB' };

const cents = (value: number, locale: DocLocale): string => euro(value / 100, locale);
const hours = (minutes: number, locale: DocLocale): string => plainNumber(Math.round((minutes / 60) * 100) / 100, locale);
const clock = (minutes: number): string => `${Math.floor(Math.abs(minutes) / 60)}:${String(Math.abs(minutes) % 60).padStart(2, '0')}`;
const wholeMonth = (from: string, to: string): boolean => from.slice(0, 7) === to.slice(0, 7) && from.endsWith('-01') && addDays(to, 1).endsWith('-01');

/** The `invoice` group (its computed fields; the invoice form's own fields are added by the caller). */
export function invoiceData(input: InvoiceInput, locale: DocLocale): Record<string, unknown> {
  const monthName = (day: string) => new Intl.DateTimeFormat(INTL[locale], { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(parseDay(day));
  const minutes = input.lines.filter(line => line.kind === 'hours').reduce((sum, line) => sum + line.minutes, 0);
  const period = (from: string | null, to: string | null) => (from && to ? (from === to ? shortDay(from) : `${shortDay(from)} – ${shortDay(to)}`) : '');
  return {
    number: input.number,
    date: shortDay(input.date),
    date_long: longDay(input.date, locale),
    due_date: shortDay(input.dueDate),
    due_date_long: longDay(input.dueDate, locale),
    period_from: shortDay(input.periodFrom),
    period_to: shortDay(input.periodTo),
    period_text: locale === 'nl' ? `van ${shortDay(input.periodFrom)} tot en met ${shortDay(input.periodTo)}` : `from ${shortDay(input.periodFrom)} up to and including ${shortDay(input.periodTo)}`,
    month_text: wholeMonth(input.periodFrom, input.periodTo) ? monthName(input.periodFrom) : '',
    total_hours: hours(minutes, locale),
    total_time: `${minutes < 0 ? '-' : ''}${clock(minutes)}`,
    subtotal: cents(input.subtotalCents, locale),
    vat_percent: plainNumber(input.vatPercent, locale),
    vat_amount: cents(input.vatCents, locale),
    total: cents(input.totalCents, locale),
    g_account_percent: plainNumber(input.gAccountPercent, locale),
    g_account_amount: cents(input.gAccountCents, locale),
    net_amount: cents(input.totalCents - input.gAccountCents, locale),
    payment_days: String(input.paymentDays),
    credit_of_number: input.creditOfNumber,
    is_credit: input.credit ? '1' : '',
    has_vat: input.vatCents !== 0 ? '1' : '',
    vat_shifted: input.vatShifted ? '1' : '',
    has_g_account: input.gAccountCents !== 0 ? '1' : '',
    has_credit_of: input.creditOfNumber ? '1' : '',
    lines: input.lines.map(line => ({
      description: line.description || line.worker,
      worker: line.worker,
      period: period(line.from, line.to),
      from: line.from ? shortDay(line.from) : '',
      to: line.to ? shortDay(line.to) : '',
      hours: line.kind === 'hours' ? hours(line.minutes, locale) : '',
      time: line.kind === 'hours' ? clock(line.minutes) : '',
      rate: line.rateCents === null ? '' : cents(line.rateCents, locale),
      amount: cents(line.amountCents, locale),
      is_hours: line.kind === 'hours' ? '1' : '',
    })),
  };
}

export interface InvoiceField {
  key: string;
  nl: string;
  en: string;
  type: 'text' | 'date' | 'number' | 'flag';
}

/** What the helper next to an invoice template lists (the loop's own fields are explained in the `lines` entry). */
export const INVOICE_FIELDS: InvoiceField[] = [
  { key: 'number', nl: 'Factuurnummer', en: 'Invoice number', type: 'text' },
  { key: 'date', nl: 'Factuurdatum', en: 'Invoice date', type: 'date' },
  { key: 'date_long', nl: 'Factuurdatum (voluit)', en: 'Invoice date (in words)', type: 'text' },
  { key: 'due_date', nl: 'Uiterste betaaldatum', en: 'Due date', type: 'date' },
  { key: 'due_date_long', nl: 'Uiterste betaaldatum (voluit)', en: 'Due date (in words)', type: 'text' },
  { key: 'period_from', nl: 'Eerste dag van de periode', en: 'First day of the period', type: 'date' },
  { key: 'period_to', nl: 'Laatste dag van de periode', en: 'Last day of the period', type: 'date' },
  { key: 'period_text', nl: 'Periode in een zin (“van … tot en met …”)', en: 'Period as a sentence (“from … up to and including …”)', type: 'text' },
  { key: 'month_text', nl: 'De maand (“september 2026”) — leeg als de periode geen hele maand is', en: 'The month (“September 2026”) — empty when the period is not a whole month', type: 'text' },
  { key: 'total_hours', nl: 'Totaal aantal uren (7,5)', en: 'Total hours (7.5)', type: 'number' },
  { key: 'total_time', nl: 'Totaal als tijd (7:30)', en: 'Total as time (7:30)', type: 'text' },
  { key: 'subtotal', nl: 'Totaal van de regels, zonder btw', en: 'Total of the lines, without VAT', type: 'text' },
  { key: 'vat_percent', nl: 'Btw-percentage', en: 'VAT percentage', type: 'number' },
  { key: 'vat_amount', nl: 'Btw-bedrag', en: 'VAT amount', type: 'text' },
  { key: 'total', nl: 'Totaal inclusief btw', en: 'Total including VAT', type: 'text' },
  { key: 'g_account_percent', nl: 'Percentage dat naar de G-rekening gaat', en: 'Percentage that goes to the G-account', type: 'number' },
  { key: 'g_account_amount', nl: 'Bedrag dat naar de G-rekening gaat', en: 'Amount that goes to the G-account', type: 'text' },
  { key: 'net_amount', nl: 'Bedrag voor de gewone rekening (totaal min G-rekening)', en: 'Amount for the ordinary account (total minus G-account)', type: 'text' },
  { key: 'payment_days', nl: 'Betaaltermijn in dagen', en: 'Payment term in days', type: 'number' },
  { key: 'credit_of_number', nl: 'Nummer van de factuur die een creditnota terugdraait', en: 'Number of the invoice a credit note takes back', type: 'text' },
  { key: 'is_credit', nl: 'Blok alleen voor een creditnota: {#invoice.is_credit} … {/invoice.is_credit}', en: 'Block for a credit note only: {#invoice.is_credit} … {/invoice.is_credit}', type: 'flag' },
  { key: 'has_vat', nl: 'Blok alleen als er btw op de factuur staat', en: 'Block only when the invoice carries VAT', type: 'flag' },
  { key: 'vat_shifted', nl: 'Blok alleen bij btw verlegd', en: 'Block only when the VAT is reverse-charged', type: 'flag' },
  { key: 'has_g_account', nl: 'Blok alleen als een deel naar de G-rekening gaat', en: 'Block only when part goes to the G-account', type: 'flag' },
  { key: 'has_credit_of', nl: 'Blok alleen als de creditnota naar een factuur verwijst', en: 'Block only when the credit note refers to an invoice', type: 'flag' },
  { key: 'lines', nl: 'De regels (herhaald): {#invoice.lines} … {/invoice.lines} — daarbinnen: {description} {worker} {period} {from} {to} {hours} {rate} {amount}', en: 'The lines (repeated): {#invoice.lines} … {/invoice.lines} — inside: {description} {worker} {period} {from} {to} {hours} {rate} {amount}', type: 'text' },
];

/** Made-up invoice for a template preview: one month, three workers, VAT and a part for the G-account. */
export function sampleInvoice(today: string): InvoiceInput {
  const first = `${today.slice(0, 7)}-01`;
  const last = new Date(Date.UTC(parseDay(first).getUTCFullYear(), parseDay(first).getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  const line = (worker: string, minutes: number, rateCents: number): InvoiceLineInput => ({ kind: 'hours', worker, description: worker, from: first, to: last, minutes, rateCents, amountCents: Math.round((minutes * rateCents) / 60) });
  const lines = [line('Jan de Vries', 9600, 2650), line('Fatima El Amrani', 7200, 2650), line('Piotr Nowak', 4800, 2800)];
  const subtotal = lines.reduce((sum, entry) => sum + entry.amountCents, 0);
  const vat = Math.round(subtotal * 0.21);
  const total = subtotal + vat;
  return {
    number: `${today.slice(0, 4)}-0042`,
    credit: false,
    creditOfNumber: '',
    date: today,
    dueDate: addDays(today, 30),
    periodFrom: first,
    periodTo: last,
    vatPercent: 21,
    vatShifted: false,
    subtotalCents: subtotal,
    vatCents: vat,
    totalCents: total,
    gAccountPercent: 25,
    gAccountCents: Math.round(total * 0.25),
    paymentDays: 30,
    lines,
  };
}
