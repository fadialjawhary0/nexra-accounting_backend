import type { ColumnType, ExportColumn, ExportLocale } from './export.types.js';

const TIME_ZONE = 'Europe/Amsterdam';
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const dateParts = new Intl.DateTimeFormat('nl-NL', { timeZone: TIME_ZONE, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

function parts(date: Date): Record<string, string> {
  return Object.fromEntries(dateParts.formatToParts(date).map(part => [part.type, part.value]));
}

/** `31-12-2026` — a `YYYY-MM-DD` day is reformatted as it is (no time-zone shift), a moment is shown in Amsterdam time. */
export function formatDay(value: unknown): string {
  if (typeof value === 'string' && DAY.test(value)) return `${value.slice(8, 10)}-${value.slice(5, 7)}-${value.slice(0, 4)}`;
  const date = toDate(value);
  if (!date) return '';
  const { day, month, year } = parts(date);
  return `${day}-${month}-${year}`;
}

/** `31-12-2026 14:30` in Amsterdam time. */
export function formatMoment(value: unknown): string {
  const date = toDate(value);
  if (!date) return '';
  const { day, month, year, hour, minute } = parts(date);
  return `${day}-${month}-${year} ${hour}:${minute}`;
}

export function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' && value) {
    const date = new Date(DAY.test(value) ? `${value}T12:00:00Z` : value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

const NUMBER = new Intl.NumberFormat('nl-NL', { maximumFractionDigits: 6 });
const MONEY = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** The text of a cell for PDF and Word (Excel gets real numbers and dates with a number format instead). */
export function formatCell(value: unknown, type: ColumnType = 'text', locale: ExportLocale = 'nl'): string {
  if (value === null || value === undefined || value === '') return '';
  switch (type) {
    case 'number':
      return typeof value === 'number' ? NUMBER.format(value) : String(value);
    case 'money':
      return typeof value === 'number' ? MONEY.format(value).replace(/ /g, ' ') : String(value);
    case 'date':
      return formatDay(value);
    case 'datetime':
      return formatMoment(value);
    case 'boolean':
      return value ? (locale === 'en' ? 'Yes' : 'Ja') : locale === 'en' ? 'No' : 'Nee';
    default:
      return Array.isArray(value) ? value.join(', ') : String(value);
  }
}

/** Words the documents themselves use, in the language of the table. */
export const WORDS = {
  nl: { generated: 'Gegenereerd op', by: 'door', page: 'Pagina', of: 'van', rows: 'rijen', none: 'Geen gegevens om te tonen.' },
  en: { generated: 'Generated on', by: 'by', page: 'Page', of: 'of', rows: 'rows', none: 'No data to show.' },
} as const;

/** `gebruikers-2026-10-10` — a safe file name base. */
export function fileBase(title: string, date: Date): string {
  const slug =
    title
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'export';
  const { day, month, year } = parts(date);
  return `${slug}-${year}-${month}-${day}`;
}

const CHARS: Record<ColumnType, number> = { text: 24, number: 10, money: 12, date: 11, datetime: 16, boolean: 9 };

/** How many characters a column needs: its hint (or the type's usual width), and at least what its header takes. */
export const columnChars = (column: ExportColumn): number => Math.max(column.header.length + 4, column.width ?? CHARS[column.type ?? 'text']);

/** Each column's share of the page width (whole numbers adding up to 100). */
export function columnShares(columns: ExportColumn[]): number[] {
  const total = columns.reduce((sum, column) => sum + columnChars(column), 0);
  return columns.map(column => Math.max(3, Math.floor((columnChars(column) / total) * 100)));
}
