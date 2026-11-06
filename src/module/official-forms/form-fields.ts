import type { PdfBox, PdfFieldInfo, PdfFieldKind } from '../../lib/pdf/pdf.types.js';
import { FILLABLE_KINDS, MAX_MAPPING_ENTRIES, PLACED_KINDS } from './official-forms.constants.js';

const KINDS: readonly string[] = ['text', 'checkbox', 'radio', 'dropdown', 'list', 'signature', 'button', 'other'];

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const round = (value: number): number => Math.round(value * 10) / 10;

/** A rectangle as stored (top left corner of the page as it is shown, in points); null when it is not one. */
export function readBox(stored: unknown): PdfBox | null {
  const raw = record(stored);
  const x = finite(raw.x);
  const y = finite(raw.y);
  const width = finite(raw.width);
  const height = finite(raw.height);
  return x !== null && y !== null && width !== null && height !== null && width > 0 && height > 0 ? { x, y, width, height } : null;
}

/** The fields of a PDF as they were stored when it was uploaded, and the boxes placed on its pages. Tolerant of an old or damaged shape; never throws. */
export function readFields(stored: unknown): PdfFieldInfo[] {
  if (!Array.isArray(stored)) return [];
  return stored.flatMap(entry => {
    if (!entry || typeof entry !== 'object') return [];
    const raw = entry as Record<string, unknown>;
    if (typeof raw.name !== 'string' || !raw.name) return [];
    return [
      {
        name: raw.name,
        kind: (KINDS.includes(raw.kind as string) ? raw.kind : 'other') as PdfFieldKind,
        page: typeof raw.page === 'number' ? raw.page : -1,
        options: Array.isArray(raw.options) ? raw.options.filter((option): option is string => typeof option === 'string') : [],
        maxLength: typeof raw.maxLength === 'number' ? raw.maxLength : null,
        multiline: raw.multiline === true,
        readOnly: raw.readOnly === true,
        tooltip: typeof raw.tooltip === 'string' ? raw.tooltip : '',
        box: readBox(raw.box),
        placed: raw.placed === true,
        cells: typeof raw.cells === 'number' && raw.cells > 1 ? Math.round(raw.cells) : null,
        context: typeof raw.context === 'string' ? raw.context : '',
      } satisfies PdfFieldInfo,
    ];
  });
}

/** A field somebody can fill in: not a signature box or a button, and not one the PDF locks. */
export const isFillable = (field: PdfFieldInfo): boolean => (FILLABLE_KINDS as readonly string[]).includes(field.kind) && !field.readOnly;

/** The part of a long field name people recognise: `topmostSubform[0].Page1[0].Naam[0]` → `Naam`. */
export function shortName(name: string): string {
  const last = name.split('.').pop() ?? name;
  return last.replace(/\[\d+\]$/, '');
}

/** The name a box placed on a page gets: `box_1`, `box_2` … — never the name of a field of the PDF. */
export const PLACED_NAME = /^box_[0-9]{1,4}$/;

export interface SanitizedBoxes {
  boxes: PdfFieldInfo[];
  problems: Record<string, string>;
}

/**
 * Checks the boxes a person (or the AI) placed on the pages: a name of their own (`box_n`), a kind that can be written (text or a tick), a page the PDF has and a
 * rectangle inside that page. `pages` are the sizes of the pages; without them only the page number and the size of the box are checked.
 */
export function sanitizeBoxes(input: unknown, pageCount: number, pages: Array<{ width: number; height: number }>): SanitizedBoxes {
  const problems: Record<string, string> = {};
  if (!Array.isArray(input) || input.length > MAX_MAPPING_ENTRIES) return { boxes: [], problems: { boxes: 'validation.invalid' } };
  const seen = new Set<string>();
  const boxes: PdfFieldInfo[] = [];
  input.forEach((entry, index) => {
    const raw = record(entry);
    const where = `boxes.${index}`;
    const name = typeof raw.name === 'string' ? raw.name : '';
    const kind = (PLACED_KINDS as readonly string[]).includes(raw.kind as string) ? (raw.kind as PdfFieldKind) : null;
    const page = typeof raw.page === 'number' && Number.isInteger(raw.page) ? raw.page : -1;
    const box = readBox(raw.box);
    if (!PLACED_NAME.test(name) || seen.has(name)) return void (problems[`${where}.name`] = 'validation.invalid');
    if (!kind) return void (problems[`${where}.kind`] = 'validation.invalid');
    if (page < 0 || page >= pageCount) return void (problems[`${where}.page`] = 'validation.invalid');
    const size = pages[page];
    if (!box || box.width < 3 || box.height < 3 || box.x < -1 || box.y < -1 || (size && (box.x + box.width > size.width + 1 || box.y + box.height > size.height + 1))) return void (problems[`${where}.box`] = 'validation.invalid');
    seen.add(name);
    const cells = kind === 'text' && typeof raw.cells === 'number' && raw.cells > 1 ? Math.min(60, Math.round(raw.cells)) : null;
    boxes.push({
      name,
      kind,
      page,
      options: [],
      maxLength: cells,
      multiline: kind === 'text' && !cells && raw.multiline === true,
      readOnly: false,
      tooltip: '',
      box: { x: round(Math.max(0, box.x)), y: round(Math.max(0, box.y)), width: round(box.width), height: round(box.height) },
      placed: true,
      cells,
      context: typeof raw.context === 'string' ? raw.context.trim().slice(0, 160) : '',
    });
  });
  return { boxes, problems };
}

/** The next free name for a placed box. */
export function nextBoxName(fields: readonly PdfFieldInfo[]): string {
  const taken = new Set(fields.map(field => field.name));
  for (let number = 1; number < 10_000; number += 1) if (!taken.has(`box_${number}`)) return `box_${number}`;
  return `box_${Date.now()}`;
}
