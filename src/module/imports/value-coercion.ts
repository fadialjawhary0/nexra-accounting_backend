import { isValidDay } from '../../common/dates.js';
import { fold } from '../../common/text.js';
import { FORMAT_OF_TYPE, type FieldDef } from '../forms/form-doc.js';

/**
 * Turns what is in a spreadsheet cell — or what the AI wrote down — into a value a form field accepts: Dutch dates and numbers, "ja / nee",
 * pick-list names, postcodes without spaces. It only *reads*; the form check (FormValidationService) is still the authority on what is valid.
 */

/** A choice of a pick-list or of a field's own list: the code records store and the names people type. */
export interface Choice {
  code: string;
  names: string[];
}

/** What the coercion looks values up in (loaded once per import). */
export interface CoerceContext {
  /** Pick-list key → its active items. */
  lists: ReadonlyMap<string, readonly Choice[]>;
  /** Active staff, for `user` fields: names and e-mail address. */
  users: ReadonlyArray<{ id: string; names: string[] }>;
  /** Folded client number → client id; folded name → ids (a name may be shared). */
  clientsByNumber: ReadonlyMap<string, string>;
  clientsByName: ReadonlyMap<string, readonly string[]>;
}

export type Coerced = { value: unknown } | { error: string };

/** Anything that is a hint rather than a value: "** ** **", "---", "?". */
const PLACEHOLDER = /^[\s*_./\\\-–—?#]+$/;
const NOTHING_WORDS = new Set(['nvt', 'n.v.t.', 'n.v.t', 'n/a', 'na', 'onbekend', 'unknown', 'null', 'none', 'leeg']);

const compact = (text: string): string => fold(text).replace(/[^a-z0-9]/g, '');

/** A cell that holds nothing worth reading. */
export function isBlank(raw: unknown): boolean {
  if (raw === null || raw === undefined) return true;
  if (typeof raw === 'string') {
    const text = raw.trim();
    return text === '' || PLACEHOLDER.test(text) || NOTHING_WORDS.has(text.toLowerCase());
  }
  return false;
}

/** The text of a cell as a person sees it (numbers without a trailing ".0", dates as `YYYY-MM-DD`). */
export function cellText(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? '' : raw.toISOString().slice(0, 10);
  if (typeof raw === 'number') return Number.isInteger(raw) ? String(raw) : String(raw).replace(/\.?0+$/, '');
  if (typeof raw === 'boolean') return raw ? 'true' : 'false';
  return String(raw).replace(/\s+/g, ' ').trim();
}

/* ── Numbers ──────────────────────────────────────────────────────────────────────────────────────────────────────── */

/** `1.234,56` · `1234,56` · `€ 12,50` · `12.5` · `1,234.56` → a number; `null` when it is not one. A single "." followed by three digits is a thousands separator. */
export function parseDutchNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  let text = raw.replace(/[€$£]|eur|euro/gi, '').replace(/\s/g, '').replace(/ /g, '');
  if (!text || !/^[+-]?[\d.,]+$/.test(text)) return null;
  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    // Both: the one that comes last is the decimal separator.
    const decimal = lastComma > lastDot ? ',' : '.';
    const thousands = decimal === ',' ? '.' : ',';
    text = text.split(thousands).join('').replace(decimal, '.');
  } else if (lastComma >= 0) {
    // One comma is the decimal comma ("1,234" is 1.234); several are thousands separators ("1,234,567").
    text = (text.match(/,/g)?.length ?? 0) > 1 ? text.split(',').join('') : text.replace(',', '.');
  } else if (lastDot >= 0) {
    const dots = text.match(/\./g)?.length ?? 0;
    if (dots > 1 || (/\.\d{3}$/.test(text) && !/^[+-]?0\./.test(text))) text = text.split('.').join('');
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** Hours in the ways people write them: `8` · `7,5` · `7.5` · `7:30` · `7u30` · an Excel time (a fraction of a day) → whole minutes. */
export function parseDuration(raw: unknown): number | null {
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw.getUTCHours() * 60 + raw.getUTCMinutes();
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? Math.round(raw * 60) : null;
  if (typeof raw !== 'string') return null;
  const text = raw.trim().toLowerCase().replace(/\s/g, '').replace(/uur$|u$|h$/, '');
  if (!text) return null;
  const clock = /^(\d{1,2})[:u.h](\d{2})$/.exec(text);
  if (clock && (text.includes(':') || text.includes('u') || text.includes('h'))) return Number(clock[1]) * 60 + Number(clock[2]);
  const number = parseDutchNumber(text);
  return number !== null && number >= 0 ? Math.round(number * 60) : null;
}

/* ── Dates ────────────────────────────────────────────────────────────────────────────────────────────────────────── */

const MONTHS: Record<string, number> = {
  januari: 1, jan: 1, january: 1,
  februari: 2, feb: 2, february: 2,
  maart: 3, mrt: 3, mar: 3, march: 3,
  april: 4, apr: 4,
  mei: 5, may: 5,
  juni: 6, jun: 6, june: 6,
  juli: 7, jul: 7, july: 7,
  augustus: 8, aug: 8, august: 8,
  september: 9, sep: 9, sept: 9,
  oktober: 10, okt: 10, oct: 10, october: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

const pad = (value: number): string => String(value).padStart(2, '0');

function makeDay(year: number, month: number, day: number): string | null {
  const text = `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`;
  return year >= 1900 && year <= 2100 && isValidDay(text) ? text : null;
}

/** A two-digit year: up to ten years ahead of today is this century, the rest the last one (a birth date of "65" is 1965, an expiry of "31" is 2031). */
function fullYear(year: number): number {
  if (year >= 100) return year;
  const limit = (new Date().getUTCFullYear() % 100) + 10;
  return year <= limit ? 2000 + year : 1900 + year;
}

/**
 * `31-12-2026` · `31/12/26` · `31.12.2026` · `2026-12-31` · `31 december 2026` · `31 dec. 2026` · an Excel date or serial number → `YYYY-MM-DD`.
 * The day always comes first in the dashed / slashed forms (that is how Dutch spreadsheets are written).
 */
export function parseDutchDate(raw: unknown): string | null {
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : makeDay(raw.getUTCFullYear(), raw.getUTCMonth() + 1, raw.getUTCDate());
  if (typeof raw === 'number') {
    // An Excel serial number (days since 1899-12-30).
    if (!Number.isFinite(raw) || raw < 1 || raw > 80_000) return null;
    const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(raw) * 86_400_000);
    return makeDay(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  }
  if (typeof raw !== 'string') return null;
  const text = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!text) return null;

  let match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[t ].*)?$/.exec(text);
  if (match) return makeDay(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2}|\d{4})$/.exec(text);
  if (match) return makeDay(fullYear(Number(match[3])), Number(match[2]), Number(match[1]));
  match = /^(\d{1,2})[-/. ]*([a-z]+)\.?[-/. ]*(\d{2}|\d{4})$/.exec(text);
  if (match) {
    const month = MONTHS[match[2]!];
    return month ? makeDay(fullYear(Number(match[3])), month, Number(match[1])) : null;
  }
  match = /^(\d{8})$/.exec(text);
  if (match) return makeDay(Number(text.slice(4)), Number(text.slice(2, 4)), Number(text.slice(0, 2)));
  return null;
}

/* ── Yes / no ─────────────────────────────────────────────────────────────────────────────────────────────────────── */

const YES = new Set(['ja', 'j', 'yes', 'y', 'true', 'waar', 'x', '✓', '✔', '1', 'aan', 'on']);
const NO = new Set(['nee', 'n', 'no', 'false', 'onwaar', '0', 'uit', 'off', '-']);

export function parseYesNo(raw: unknown): boolean | null {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw === 1 ? true : raw === 0 ? false : null;
  if (typeof raw !== 'string') return null;
  const text = fold(raw);
  return YES.has(text) ? true : NO.has(text) ? false : null;
}

/* ── Pick-lists ───────────────────────────────────────────────────────────────────────────────────────────────────── */

/** The choices a select field offers: the items of its list plus its own choices. */
export function choicesOf(field: FieldDef, context: CoerceContext): Choice[] {
  const own = field.choices.map(choice => ({ code: choice.code, names: [choice.names.nl, choice.names.en] }));
  return [...(field.list ? (context.lists.get(field.list) ?? []) : []), ...own];
}

/** The choice a text means: its code, or its Dutch / English name (spaces, dots and capitals do not matter: "B.V." is "bv"). */
export function matchChoice(text: string, choices: readonly Choice[]): string | null {
  const wanted = compact(text);
  if (!wanted) return null;
  const exact = choices.find(choice => compact(choice.code) === wanted || choice.names.some(name => compact(name) === wanted));
  if (exact) return exact.code;
  if (wanted.length < 4) return null;
  // "Eenmanszaak (ZZP)" for "Eenmanszaak": accept a single choice that the text starts with or that starts with the text.
  const close = choices.filter(choice => choice.names.some(name => compact(name).startsWith(wanted) || (compact(name).length >= 4 && wanted.startsWith(compact(name)))));
  return close.length === 1 ? close[0]!.code : null;
}

/* ── One cell → one field ─────────────────────────────────────────────────────────────────────────────────────────── */

/** Digits that an Excel cell lost their leading zeros of (a BSN of eight digits, a mobile number without its 0). */
function numericText(raw: unknown, field: FieldDef): string {
  const text = cellText(raw);
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return text;
  if (field.type === 'phone' && /^[1-9]\d{8}$/.test(text)) return `0${text}`;
  if (field.type === 'postcode' || field.type === 'text' || field.type === 'textarea') return text;
  return text;
}

/**
 * The value a field gets from a cell. A blank cell gives `null` (the field is left alone). Errors carry the message key of the `validation` page,
 * the same ones the forms show.
 */
export function coerce(field: FieldDef, raw: unknown, context: CoerceContext): Coerced {
  if (field.type !== 'select' && field.type !== 'multiselect' && isBlank(raw)) return { value: null };
  switch (field.type) {
    case 'number':
    case 'money': {
      const value = parseDutchNumber(raw);
      return value === null ? { error: 'validation.enterNumber' } : { value };
    }
    case 'date': {
      const value = parseDutchDate(raw);
      return value === null ? { error: 'validation.invalidDate' } : { value };
    }
    case 'boolean': {
      const value = parseYesNo(raw);
      return value === null ? { error: 'validation.invalid' } : { value };
    }
    case 'select': {
      if (isBlank(raw) && !matchChoice(cellText(raw), choicesOf(field, context))) return { value: null };
      const code = matchChoice(cellText(raw), choicesOf(field, context));
      return code ? { value: code } : { error: 'validation.selectOption' };
    }
    case 'multiselect': {
      const parts = cellText(raw)
        .split(/[,;/|]+/)
        .map(part => part.trim())
        .filter(part => part && !isBlank(part));
      if (!parts.length) return { value: null };
      const choices = choicesOf(field, context);
      const codes = parts.map(part => matchChoice(part, choices));
      return codes.every(code => code !== null) ? { value: [...new Set(codes as string[])] } : { error: 'validation.selectOption' };
    }
    case 'user': {
      const wanted = fold(cellText(raw));
      const found = context.users.filter(user => user.names.some(name => fold(name) === wanted));
      return found.length === 1 ? { value: found[0]!.id } : { error: 'validation.selectOption' };
    }
    case 'client': {
      const text = cellText(raw);
      const byNumber = context.clientsByNumber.get(fold(text));
      if (byNumber) return { value: byNumber };
      const byName = context.clientsByName.get(fold(text));
      return byName?.length === 1 ? { value: byName[0] } : { error: 'validation.selectOption' };
    }
    case 'file':
      return { value: null };
    default: {
      // Text and the format types: always text, whatever the cell held.
      const text = numericText(raw, field);
      if (FORMAT_OF_TYPE[field.type] === 'postcode') return { value: text.replace(/\s+/g, '') };
      if (FORMAT_OF_TYPE[field.type] === 'kvk') return { value: text.replace(/\s+/g, '') };
      return { value: text };
    }
  }
}
