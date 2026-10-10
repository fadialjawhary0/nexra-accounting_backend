import { isValidDay } from '../../common/dates.js';
import { FORMATS } from '../../common/validation/formats.js';
import { FORMAT_OF_TYPE, evaluate, isEmptyValue, type FieldDef, type FormDoc } from './form-doc.js';

/** What the check needs to know besides the form itself. */
export interface ValueContext {
  /** Codes of the active choices of every pick-list a select field uses (`legal_form` → { 'bv', 'vof', … }). */
  lists: ReadonlyMap<string, ReadonlySet<string>>;
  /** The uploaded files the submitted values point at, as the database knows them (never trust the browser's name / size). */
  files: ReadonlyMap<string, { id: string; name: string; size: number; mimeType: string }>;
  /** Ids of the people who can be chosen in a `user` field (active staff). */
  users: ReadonlySet<string>;
  /** Ids of the clients that exist among the values submitted for `client` fields. */
  clients: ReadonlySet<string>;
  canView: (field: FieldDef) => boolean;
  canEdit: (field: FieldDef) => boolean;
}

export interface ValueResult {
  /** The cleaned patch: only fields that may be saved now, normalised; `null` clears a value. Merge it into the record's `data`. */
  values: Record<string, unknown>;
  /** `field key → message key` (`validation.required`, `validation.min|{"min":3}` …) — what the 422 answer carries. */
  errors: Record<string, string>;
}

const DEFAULT_TEXT_MAX = 500;
const TEXTAREA_MAX = 5000;
const MAX_CHOICES_SELECTED = 100;

type Parsed = { value: unknown } | { error: string };
const params = (key: string, values: Record<string, number>) => `${key}|${JSON.stringify(values)}`;

/** Codes a select field accepts: the active items of its list, its own choices, and what the record already holds. */
function allowedCodes(field: FieldDef, context: ValueContext, current: unknown): Set<string> {
  const codes = new Set<string>([...(field.list ? (context.lists.get(field.list) ?? []) : []), ...field.choices.map(choice => choice.code)]);
  for (const stored of Array.isArray(current) ? current : [current]) if (typeof stored === 'string') codes.add(stored);
  return codes;
}

function parseValue(field: FieldDef, raw: unknown, context: ValueContext, current: unknown): Parsed {
  if (isEmptyValue(raw)) return { value: null };
  const { validation } = field;
  const type = field.type;

  switch (type) {
    case 'text':
    case 'textarea': {
      if (typeof raw !== 'string') return { error: 'validation.invalid' };
      const value = raw.trim();
      const max = validation.maxLength ?? (type === 'textarea' ? TEXTAREA_MAX : DEFAULT_TEXT_MAX);
      if (validation.minLength !== undefined && value.length < validation.minLength) return { error: params('validation.minLength', { min: validation.minLength }) };
      if (value.length > max) return { error: params('validation.maxLength', { max }) };
      return { value };
    }
    case 'number':
    case 'money': {
      if (typeof raw !== 'number' || !Number.isFinite(raw) || Math.abs(raw) > 1e12) return { error: 'validation.enterNumber' };
      const value = type === 'money' ? Math.round(raw * 100) / 100 : raw;
      if (validation.min !== undefined && value < validation.min) return { error: params('validation.min', { min: validation.min }) };
      if (validation.max !== undefined && value > validation.max) return { error: params('validation.max', { max: validation.max }) };
      return { value };
    }
    case 'date':
      return typeof raw === 'string' && isValidDay(raw) ? { value: raw } : { error: 'validation.invalidDate' };
    case 'boolean':
      return typeof raw === 'boolean' ? { value: raw } : { error: 'validation.invalid' };
    case 'select': {
      if (typeof raw !== 'string') return { error: 'validation.invalid' };
      return allowedCodes(field, context, current).has(raw) ? { value: raw } : { error: 'validation.selectOption' };
    }
    case 'multiselect': {
      if (!Array.isArray(raw) || raw.length > MAX_CHOICES_SELECTED || raw.some(item => typeof item !== 'string')) return { error: 'validation.invalid' };
      const allowed = allowedCodes(field, context, current);
      const unique = [...new Set(raw as string[])];
      return unique.every(code => allowed.has(code)) ? { value: unique } : { error: 'validation.selectOption' };
    }
    case 'user':
      if (typeof raw !== 'string') return { error: 'validation.invalid' };
      return raw === current || context.users.has(raw) ? { value: raw } : { error: 'validation.selectOption' };
    case 'client':
      if (typeof raw !== 'string') return { error: 'validation.invalid' };
      return raw === current || context.clients.has(raw) ? { value: raw } : { error: 'validation.selectOption' };
    case 'file': {
      const id = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as { id?: unknown }).id : undefined;
      const file = typeof id === 'string' ? context.files.get(id) : undefined;
      return file ? { value: { id: file.id, name: file.name, size: file.size, mimeType: file.mimeType } } : { error: 'validation.invalid' };
    }
    default: {
      // Email, phone, URL, postcode, IBAN, BSN, KvK, VAT, RSIN and payroll-tax numbers: a Dutch format, stored normalised.
      const format = FORMAT_OF_TYPE[type];
      if (!format || typeof raw !== 'string') return { error: 'validation.invalid' };
      const normalized = FORMATS[format].normalize(raw.trim());
      return normalized === null ? { error: `validation.${FORMATS[format].messageKey}` } : { value: normalized };
    }
  }
}

/** Which fields are shown for these values: active, their section's rule and their own rule both pass. */
export function visibleFields(doc: FormDoc, values: Record<string, unknown>): FieldDef[] {
  const hiddenSections = new Set(doc.sections.filter(section => !evaluate(section.showWhen, values)).map(section => section.key));
  return doc.fields.filter(field => field.active && !hiddenSections.has(field.section) && evaluate(field.showWhen, values));
}

/**
 * Checks and cleans the values someone submitted for a record.
 *   `patch`     what was submitted (on a create: everything; on an update: only what changed — the rest of the record is kept)
 *   `existing`  the record's `data` so far ({} on a create)
 * Fields that are hidden by a rule, switched off, or that the person may not edit are ignored — and never deleted. Required fields
 * are checked against the record as it will be after the save, so clearing a required value, or revealing a new required field
 * (a different legal form), is caught too.
 */
export function validateValues(doc: FormDoc, patch: Record<string, unknown>, existing: Record<string, unknown>, context: ValueContext): ValueResult {
  const errors: Record<string, string> = {};
  const parsed: Record<string, unknown> = {};
  const byKey = new Map(doc.fields.filter(field => field.active).map(field => [field.key, field]));

  for (const [key, raw] of Object.entries(patch)) {
    const field = byKey.get(key);
    if (!field || !context.canEdit(field)) continue;
    const result = parseValue(field, raw, context, existing[key]);
    if ('error' in result) errors[key] = result.error;
    else parsed[key] = result.value;
  }

  const merged = { ...existing, ...parsed };
  const visible = new Set(visibleFields(doc, merged).map(field => field.key));
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) if (visible.has(key)) values[key] = value;

  for (const field of doc.fields) {
    if (!visible.has(field.key) || !field.required || !context.canEdit(field)) continue;
    if (!errors[field.key] && isEmptyValue(merged[field.key])) errors[field.key] = 'validation.required';
  }
  return { values, errors };
}
