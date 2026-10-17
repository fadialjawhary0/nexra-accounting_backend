import type { PdfFieldInfo, PdfFieldKind } from '../../lib/pdf/pdf.types.js';
import { FILLABLE_KINDS } from './official-forms.constants.js';

const KINDS: readonly string[] = ['text', 'checkbox', 'radio', 'dropdown', 'list', 'signature', 'button', 'other'];

/** The fields of a PDF as they were stored when it was uploaded. Tolerant of an old or damaged shape; never throws. */
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
