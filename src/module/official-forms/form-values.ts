import { isValidDay } from '../../common/dates.js';
import { longDay, money, plainNumber, shortDay, type DocLocale } from '../templates/merge-format.js';
import type { Choice, TextFormat, Test } from './form-mapping.js';

/*
 * The small, pure rules that turn a value from a record into what is written in a field of a PDF: the way a date or an amount is written, whether a box is
 * ticked, which option of a radio group goes with a value. No database, no PDF — everything here is a function of the value and the mapping.
 */

/** A value from a source, both as it is stored (`raw`: a date is `2026-12-31`, a choice its code) and as text for a person (`text`: `31-12-2026`, the name of the choice). */
export interface Resolved {
  raw: unknown;
  text: string;
  /** The type of the field it comes from (`date`, `select`, `bsn` …) or `text`. */
  type: string;
  /** A sensitive value (BSN …): a form that holds it is only opened by people who may see sensitive data. */
  restricted: boolean;
  /** The person asking may not see this value, so it was not looked up. */
  hidden: boolean;
}

export const NOTHING: Resolved = { raw: null, text: '', type: 'text', restricted: false, hidden: false };

export const isFilled = (value: unknown): boolean => !(value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0));

const YES = /^(true|1|yes|ja|on|x)$/i;

/** `Jan Pieter` → `J.P.` ; `Jan-Willem` → `J.W.` */
export const initialsOf = (value: string): string =>
  value
    .split(/[\s-]+/)
    .map(part => part.trim().charAt(0))
    .filter(Boolean)
    .map(letter => `${letter.toLocaleUpperCase('nl-NL')}.`)
    .join('');

/** The value as the text field is to hold it. `as_is` is the text a person would read (`31-12-2026`, `B.V.`, `Ja`). */
export function formatValue(resolved: Resolved, format: TextFormat, locale: DocLocale): string {
  const { raw, text } = resolved;
  const day = typeof raw === 'string' && isValidDay(raw) ? raw : null;
  const amount = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw)) ? Number(raw) : null;
  switch (format) {
    case 'upper':
      return text.toLocaleUpperCase('nl-NL');
    case 'lower':
      return text.toLocaleLowerCase('nl-NL');
    case 'digits':
      return text.replace(/\D+/g, '');
    case 'compact':
      return text.replace(/\s+/g, '');
    case 'iban_groups':
      return text
        .replace(/\s+/g, '')
        .replace(/(.{4})/g, '$1 ')
        .trim();
    case 'initials':
      return initialsOf(text);
    case 'date_dmy':
      return day ? shortDay(day) : text;
    case 'date_dmy_compact':
      return day ? shortDay(day).replace(/-/g, '') : text;
    case 'date_ymd':
      return day ?? text;
    case 'date_day':
      return day ? day.slice(8, 10) : text;
    case 'date_month':
      return day ? day.slice(5, 7) : text;
    case 'date_year':
      return day ? day.slice(0, 4) : text;
    case 'date_long':
      return day ? longDay(day, locale) : text;
    case 'postcode_digits':
      return /^(\d{4})\s?[A-Za-z]{2}$/.exec(text.trim())?.[1] ?? text;
    case 'postcode_letters':
      return /^\d{4}\s?([A-Za-z]{2})$/.exec(text.trim())?.[1]?.toUpperCase() ?? text;
    case 'number':
      return amount === null ? text : plainNumber(amount, locale);
    case 'money':
      return amount === null ? text : money(amount, locale);
    case 'yes_no': {
      const yes = raw === true || (typeof raw === 'string' && /^true$/i.test(raw.trim()));
      const no = raw === false || (typeof raw === 'string' && /^false$/i.test(raw.trim()));
      return yes ? (locale === 'nl' ? 'Ja' : 'Yes') : no ? (locale === 'nl' ? 'Nee' : 'No') : text;
    }
    default:
      return text;
  }
}

const same = (value: unknown): string => String(value ?? '').trim().toLowerCase();

/** Whether the value passes a test. A test on a choice field compares the code; `truthy` is a yes (a ticked box, "ja", "true"). */
export function passes(resolved: Resolved, test: Test): boolean {
  const { raw } = resolved;
  const values = Array.isArray(raw) ? raw.map(same) : [same(raw)];
  switch (test.op) {
    case 'truthy':
      return raw === true || (typeof raw === 'string' && YES.test(raw.trim()));
    case 'falsy':
      return !passes(resolved, { op: 'truthy' });
    case 'filled':
      return isFilled(raw);
    case 'empty':
      return !isFilled(raw);
    case 'eq':
      return values.includes(same(Array.isArray(test.value) ? test.value[0] : test.value));
    case 'ne':
      return !values.includes(same(Array.isArray(test.value) ? test.value[0] : test.value));
    case 'in': {
      const wanted = (Array.isArray(test.value) ? test.value : [test.value ?? '']).map(same);
      return values.some(value => wanted.includes(value));
    }
    default:
      return false;
  }
}

/** The option of the first choice that passes, else the fallback (empty = nothing is chosen). */
export function pickChoice(resolved: Resolved, choices: readonly Choice[], fallback: string): string {
  return choices.find(choice => passes(resolved, choice.when))?.option ?? fallback;
}

/** The option of a list that is the same as a text (ignoring case and spaces at the ends); the text itself when there is none. */
export function matchOption(textValue: string, options: readonly string[]): string {
  const wanted = same(textValue);
  return options.find(option => option === textValue) ?? options.find(option => same(option) === wanted) ?? '';
}

const PLACEHOLDER = /\{((?:client|person|employee|office|form|period)\.[a-z][a-z0-9_]*)\}/g;

/**
 * `{person.initials} {person.infix} {person.last_name}` with the values filled in. A value that is empty takes its separator with it: "J.  de" never
 * comes out with a double space, and a text that ends up with only separators is empty.
 */
export function composeText(template: string, valueOf: (key: string) => string): string {
  const filled = template.replace(PLACEHOLDER, (_match, key: string) => valueOf(key));
  const tidy = filled
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/(^|\n)[\s,;:/\-–]+/g, '$1')
    .replace(/[\s,;:/\-–]+(?=\n|$)/g, '')
    .replace(/ ([,;:])/g, '$1')
    .trim();
  return tidy;
}
