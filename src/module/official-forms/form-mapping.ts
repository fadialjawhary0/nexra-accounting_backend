import type { PdfFieldInfo } from '../../lib/pdf/pdf.types.js';
import { FILLABLE_KINDS, MAX_MAPPING_ENTRIES } from './official-forms.constants.js';

/*
 * The mapping of an official PDF: for every field of the PDF, where its value comes from and how it is written. It is stored with the edition of the PDF
 * (`OfficialFormVersion.mapping`), so a new edition of a form has its own mapping and what was filled with an older one stays explainable.
 *
 * Sources are named by the stable key of a field of a form (`client.kvk`, `person.last_name`) — never by its label — so the office can rename or hide fields in the
 * form builder without breaking a mapping.
 */

/** `client.name`: a group (client, person, employee, office, form, period) and a name inside it. */
export const SOURCE_KEY = /^(client|person|employee|office|form|period)\.[a-z][a-z0-9_]*$/;
const PLACEHOLDER = /\{((?:client|person|employee|office|form|period)\.[a-z][a-z0-9_]*)\}/g;

export type SourceRef =
  /** A value from a record or from the office (`client.kvk`). */
  | { type: 'field'; key: string }
  /** The same text every time. */
  | { type: 'fixed'; value: string }
  /** Typed (or ticked) by the person who fills the form in. */
  | { type: 'ask' }
  /** Several values in one text: `{person.initials} {person.infix} {person.last_name}`. */
  | { type: 'compose'; template: string };

/** How a value is written into a text field. */
export const TEXT_FORMATS = [
  'as_is',
  'upper',
  'lower',
  'digits',
  'compact',
  'iban_groups',
  'initials',
  'date_dmy',
  'date_dmy_compact',
  'date_ymd',
  'date_day',
  'date_month',
  'date_year',
  'date_long',
  'postcode_digits',
  'postcode_letters',
  'number',
  'money',
  'yes_no',
] as const;
export type TextFormat = (typeof TEXT_FORMATS)[number];

export const TEST_OPS = ['truthy', 'falsy', 'eq', 'ne', 'in', 'filled', 'empty'] as const;
export type TestOp = (typeof TEST_OPS)[number];

/** A question about the value of a source: is it yes, is it this code, is it filled in. */
export interface Test {
  op: TestOp;
  value?: string | string[];
}

/** For a radio group, a drop-down or a list: the option to choose when the value passes the test. The first choice that passes wins. */
export interface Choice {
  when: Test;
  option: string;
}

export interface FieldMapping {
  /** The full name of the field in the PDF. */
  pdfField: string;
  /** What the field is called on the screen where it is filled in. */
  label: string;
  /** The heading it is shown under (empty = the page of the PDF). */
  section: string;
  /** `null` = the field is left as the PDF has it. */
  source: SourceRef | null;
  /** Text fields: how the value is written. */
  format: TextFormat;
  /** Check boxes: when the box is ticked (default: when the value is yes). */
  test: Test | null;
  /** Radio groups, drop-downs, lists: which option goes with which value. Without choices the value itself must be one of the options. */
  choices: Choice[];
  /** The option used when none of the choices passes. */
  fallback: string;
  /** The person who fills the form in is told when it is empty — and cannot finish. */
  required: boolean;
  /** A note shown with the field ("only for a sole proprietorship"). */
  hint: string;
}

export const emptyMapping = (pdfField: string): FieldMapping => ({ pdfField, label: '', section: '', source: null, format: 'as_is', test: null, choices: [], fallback: '', required: false, hint: '' });

const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** The keys a composed text asks for. */
export const placeholdersOf = (template: string): string[] => [...template.matchAll(PLACEHOLDER)].map(match => match[1]!);

function cleanTest(input: unknown): Test | null {
  const raw = record(input);
  const op = (TEST_OPS as readonly string[]).includes(raw.op as string) ? (raw.op as Test['op']) : null;
  if (!op) return null;
  const value = Array.isArray(raw.value) ? raw.value.filter((entry): entry is string => typeof entry === 'string').map(entry => entry.trim().slice(0, 120)).slice(0, 30) : typeof raw.value === 'string' ? raw.value.trim().slice(0, 120) : undefined;
  return value === undefined || ['truthy', 'falsy', 'filled', 'empty'].includes(op) ? { op } : { op, value };
}

function cleanSource(input: unknown, isKnownKey: (key: string) => boolean): SourceRef | 'invalid' | null {
  if (input === null || input === undefined) return null;
  const raw = record(input);
  switch (raw.type) {
    case 'field':
      return typeof raw.key === 'string' && SOURCE_KEY.test(raw.key) && isKnownKey(raw.key) ? { type: 'field', key: raw.key } : 'invalid';
    case 'fixed':
      return { type: 'fixed', value: text(raw.value, 500) };
    case 'ask':
      return { type: 'ask' };
    case 'compose': {
      const template = text(raw.template, 500);
      const keys = placeholdersOf(template);
      return template && keys.length && keys.every(isKnownKey) ? { type: 'compose', template } : 'invalid';
    }
    default:
      return 'invalid';
  }
}

export interface SanitizedMapping {
  mapping: FieldMapping[];
  /** `mapping.3.source` → `validation.invalid`: what is wrong, where (the keys are the position in the list the screen sent). */
  problems: Record<string, string>;
}

/**
 * Checks what the mapping editor sends against the PDF it is for: every entry must name a field the PDF has and can have filled in, once; a source must exist;
 * the options of a choice must be options of the field. Entries are tidied (lengths, defaults) and put in the order of the PDF.
 */
export function sanitizeMapping(input: unknown, fields: readonly PdfFieldInfo[], isKnownKey: (key: string) => boolean): SanitizedMapping {
  const problems: Record<string, string> = {};
  if (!Array.isArray(input) || input.length > MAX_MAPPING_ENTRIES) return { mapping: [], problems: { mapping: 'validation.invalid' } };
  const byName = new Map(fields.map(field => [field.name, field]));
  const seen = new Set<string>();
  const kept = new Map<string, FieldMapping>();

  input.forEach((entry, index) => {
    const raw = record(entry);
    const name = typeof raw.pdfField === 'string' ? raw.pdfField : '';
    const field = byName.get(name);
    const where = `mapping.${index}`;
    if (!field || !(FILLABLE_KINDS as readonly string[]).includes(field.kind)) {
      problems[`${where}.pdfField`] = 'validation.invalid';
      return;
    }
    if (seen.has(name)) {
      problems[`${where}.pdfField`] = 'validation.alreadyExists';
      return;
    }
    seen.add(name);

    const source = cleanSource(raw.source, isKnownKey);
    if (source === 'invalid') problems[`${where}.source`] = 'validation.invalid';
    const format = (TEXT_FORMATS as readonly string[]).includes(raw.format as string) ? (raw.format as TextFormat) : 'as_is';

    const options = new Set(field.options.map(option => option.trim().toLowerCase()));
    const choices: Choice[] = [];
    if (field.kind === 'radio' || field.kind === 'dropdown' || field.kind === 'list') {
      const list = Array.isArray(raw.choices) ? raw.choices.slice(0, 40) : [];
      list.forEach((candidate, position) => {
        const choice = record(candidate);
        const when = cleanTest(choice.when);
        const option = text(choice.option, 200);
        if (!when) problems[`${where}.choices.${position}.when`] = 'validation.invalid';
        else if (!option || (options.size && !options.has(option.toLowerCase()))) problems[`${where}.choices.${position}.option`] = 'validation.selectOption';
        else choices.push({ when, option });
      });
    }
    const fallback = text(raw.fallback, 200);
    if (fallback && options.size && !options.has(fallback.toLowerCase())) problems[`${where}.fallback`] = 'validation.selectOption';

    kept.set(name, {
      pdfField: name,
      label: text(raw.label, 160),
      section: text(raw.section, 80),
      source: source === 'invalid' ? null : source,
      format: field.kind === 'text' ? format : 'as_is',
      test: field.kind === 'checkbox' ? cleanTest(raw.test) : null,
      choices,
      fallback: options.size && fallback && !options.has(fallback.toLowerCase()) ? '' : fallback,
      required: raw.required === true,
      hint: text(raw.hint, 300),
    });
  });

  // In the order of the PDF.
  const mapping = fields.filter(field => kept.has(field.name)).map(field => kept.get(field.name)!);
  return { mapping, problems };
}

/** The mapping as stored (JSON), tolerant of an old shape: what cannot be read is dropped. Never throws. */
export function readMapping(stored: unknown): FieldMapping[] {
  if (!Array.isArray(stored)) return [];
  return stored.flatMap(entry => {
    const raw = record(entry);
    if (typeof raw.pdfField !== 'string' || !raw.pdfField) return [];
    const source = cleanSource(raw.source, () => true);
    return [
      {
        pdfField: raw.pdfField,
        label: text(raw.label, 160),
        section: text(raw.section, 80),
        source: source === 'invalid' ? null : source,
        format: (TEXT_FORMATS as readonly string[]).includes(raw.format as string) ? (raw.format as TextFormat) : 'as_is',
        test: cleanTest(raw.test),
        choices: (Array.isArray(raw.choices) ? raw.choices : []).flatMap(candidate => {
          const choice = record(candidate);
          const when = cleanTest(choice.when);
          const option = text(choice.option, 200);
          return when && option ? [{ when, option }] : [];
        }),
        fallback: text(raw.fallback, 200),
        required: raw.required === true,
        hint: text(raw.hint, 300),
      } satisfies FieldMapping,
    ];
  });
}
