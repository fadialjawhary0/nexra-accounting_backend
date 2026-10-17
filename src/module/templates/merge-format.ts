import { addDays, parseDay } from '../../common/dates.js';

/*
 * How the data of a record is written into a document: Dutch dates (`31-12-2026`), euro amounts (`€ 1.234,56`), names the way a letter
 * writes them. Everything here is a pure function of the value and the language of the document, so a template in English gets English
 * text and a template in Dutch gets Dutch text, whatever language the person using the app has chosen.
 */

export type DocLocale = 'nl' | 'en';

const INTL: Record<DocLocale, string> = { nl: 'nl-NL', en: 'en-GB' };

/** `2026-11-01` → `01-11-2026`. */
export const shortDay = (day: string): string => `${day.slice(8, 10)}-${day.slice(5, 7)}-${day.slice(0, 4)}`;

/** `2026-11-01` → `1 november 2026` / `1 November 2026`. */
export const longDay = (day: string, locale: DocLocale): string => new Intl.DateTimeFormat(INTL[locale], { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(parseDay(day));

/** `1234.5` → `1.234,5` (Dutch) / `1,234.5` (English): at most 4 decimals, none that are not needed. */
export const plainNumber = (value: number, locale: DocLocale): string => new Intl.NumberFormat(INTL[locale], { maximumFractionDigits: 4 }).format(value);

/** `1234.5` → `€ 1.234,50` / `€1,234.50`. */
export const euro = (value: number, locale: DocLocale): string => new Intl.NumberFormat(INTL[locale], { style: 'currency', currency: 'EUR' }).format(value).replace(/ /g, ' ');

/** `1234.5` → `1.234,50` without the euro sign — for templates that print the sign themselves. */
export const money = (value: number, locale: DocLocale): string => new Intl.NumberFormat(INTL[locale], { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);

export const yesNo = (value: boolean, locale: DocLocale): string => (value ? (locale === 'nl' ? 'Ja' : 'Yes') : locale === 'nl' ? 'Nee' : 'No');

const capitalize = (value: string): string => (value ? value.charAt(0).toUpperCase() + value.slice(1) : value);

export interface NameParts {
  firstName?: string;
  infix?: string;
  lastName?: string;
  initials?: string;
}

/** `Jan van der Berg`. */
export const fullName = ({ firstName, infix, lastName }: NameParts): string => [firstName, infix, lastName].map(part => (part ?? '').trim()).filter(Boolean).join(' ');

/** `J. van der Berg` — the initials when there are any, otherwise the first name. */
export const initialsName = ({ firstName, infix, lastName, initials }: NameParts): string => [(initials ?? '').trim() || (firstName ?? '').trim(), (infix ?? '').trim(), (lastName ?? '').trim()].filter(Boolean).join(' ');

/** `Geachte heer Van der Berg` / `Dear Mr Van der Berg` — the name prefix gets a capital after the title, as letters write it. */
export function salutationLine(salutation: string | undefined, { infix, lastName }: NameParts, locale: DocLocale): string {
  const surname = capitalize([(infix ?? '').trim(), (lastName ?? '').trim()].filter(Boolean).join(' '));
  if (locale === 'nl') {
    const title = salutation === 'mr' ? 'Geachte heer' : salutation === 'mrs' ? 'Geachte mevrouw' : 'Geachte heer/mevrouw';
    return [title, surname].filter(Boolean).join(' ');
  }
  const title = salutation === 'mr' ? 'Dear Mr' : salutation === 'mrs' ? 'Dear Ms' : 'Dear Sir/Madam';
  return [title, surname].filter(Boolean).join(' ');
}

/** `Kerkstraat 12a` */
export const streetLine = (values: Record<string, unknown>): string => {
  const text = (key: string) => (typeof values[key] === 'string' ? (values[key] as string).trim() : '');
  const number = [text('house_number'), text('house_number_suffix')].filter(Boolean).join('');
  return [text('street'), number].filter(Boolean).join(' ');
};

/** `1234 AB Utrecht` */
export const cityLine = (values: Record<string, unknown>): string => {
  const text = (key: string) => (typeof values[key] === 'string' ? (values[key] as string).trim() : '');
  return [text('postal_code'), text('city')].filter(Boolean).join(' ');
};

/** `Kerkstraat 12a, 1234 AB Utrecht` */
export const addressLine = (values: Record<string, unknown>): string => [streetLine(values), cityLine(values)].filter(Boolean).join(', ');

/** "from 01-11-2026 up to and including 30-04-2027" — the period of a contract as one sentence. */
export function periodText(start: string | null, end: string | null, locale: DocLocale): string {
  if (!start) return '';
  if (!end) return locale === 'nl' ? `vanaf ${shortDay(start)} voor onbepaalde tijd` : `from ${shortDay(start)} for an indefinite period`;
  return locale === 'nl' ? `van ${shortDay(start)} tot en met ${shortDay(end)}` : `from ${shortDay(start)} up to and including ${shortDay(end)}`;
}

/** The first day of next month: a believable start date for a sample document. */
export const firstOfNextMonth = (today: string): string => {
  const date = parseDay(today);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
};

export { addDays };

/** Fills a short text (a WhatsApp message) with the data: `{employee.first_name}` becomes `Jan`; a field that does not exist stays visible as written. */
export function fillText(body: string, data: Record<string, Record<string, string>>): string {
  return body.replace(/\{([a-z_]+)\.([a-z0-9_]+)\}/gi, (match, group: string, key: string) => data[group]?.[key] ?? match);
}
