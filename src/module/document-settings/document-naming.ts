import { NAME_TOKENS, type NameToken } from './document-settings.constants.js';

/** What a naming pattern can use. Every value is optional: a piece that is not known (a client document has no worker) simply disappears. */
export interface NameContext {
  /** The client's number (`042`). */
  number?: string | null;
  client?: string | null;
  worker?: string | null;
  /** The name of the type, in the language of the documents. */
  type?: string | null;
  /** The date on the document, `YYYY-MM-DD`. */
  date?: string | null;
  /** The name the file had, without its extension. */
  original: string;
}

const TOKEN_PATTERN = /\{(\w+)\}/g;
/** Characters a file name cannot hold. */
const FORBIDDEN = /[\\/:*?"<>|]+/g;
const MAX_LENGTH = 150;

const isToken = (value: string): value is NameToken => (NAME_TOKENS as readonly string[]).includes(value);

/** `2026-03-15` → `15-03-2026`. */
const dutchDay = (day: string): string => `${day.slice(8, 10)}-${day.slice(5, 7)}-${day.slice(0, 4)}`;

function valueOf(token: NameToken, context: NameContext): string {
  switch (token) {
    case 'number':
      return context.number ?? '';
    case 'client':
      return context.client ?? '';
    case 'worker':
      return context.worker ?? '';
    case 'type':
      return context.type ?? '';
    case 'date':
      return context.date ? dutchDay(context.date) : '';
    case 'year':
      return context.date ? context.date.slice(0, 4) : '';
    case 'month':
      return context.date ? context.date.slice(5, 7) : '';
    case 'original':
      return context.original;
  }
}

/** The tokens a pattern uses that do not exist (`{nummer}`), so the editor can say so. */
export const unknownTokens = (pattern: string): string[] => [...pattern.matchAll(TOKEN_PATTERN)].map(match => match[1]!).filter(token => !isToken(token));

/**
 * The file name a pattern makes, without the extension: `{number} - {type} {date}` → `042 - KvK-uittreksel 15-03-2026`. Pieces that are empty
 * take their separators with them (`{worker} - {type}` without a worker is just the type). `null` when nothing is left — the caller keeps the name.
 */
export function nameFromPattern(pattern: string, context: NameContext): string | null {
  if (!pattern.trim()) return null;
  const filled = pattern
    .replace(TOKEN_PATTERN, (_match, token: string) => (isToken(token) ? valueOf(token, context) : ''))
    .replace(FORBIDDEN, ' ')
    .replace(/\s+/g, ' ');
  // "{worker} - {type}" with no worker leaves " - Type"; "Type - " and "Type - - Date" are cleaned the same way.
  const cleaned = filled
    .replace(/(\s[-–]\s*){2,}/g, ' - ')
    .replace(/^[\s\-–_.,]+|[\s\-–_.,]+$/g, '')
    .trim()
    .slice(0, MAX_LENGTH)
    .trim();
  return cleaned || null;
}
