/*
 * The form definition document: what a form looks like, stored as JSON per entity (client, person, employee, contract …).
 * Everything that shows or reads a record's fields — forms, list columns, filters, exports, imports, templates, AI extraction —
 * reads this document instead of a hard-coded field list. The frontend has the same document and evaluates `showWhen` identically
 * (nexra-accounting_frontend/src/components/dynamic-form/conditions.js).
 */

export interface Named {
  nl: string;
  en: string;
}

/** Field types. A format type (iban, bsn …) validates and normalises its value the way src/common/validation/formats.ts does. */
export const FIELD_TYPES = ['text', 'textarea', 'number', 'money', 'date', 'boolean', 'select', 'multiselect', 'email', 'phone', 'url', 'postcode', 'iban', 'bsn', 'kvk', 'vat', 'rsin', 'payrollTax', 'file', 'user'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Types whose value is checked against a Dutch format (and stored normalised). */
export const FORMAT_OF_TYPE: Partial<Record<FieldType, 'email' | 'phone' | 'url' | 'postcode' | 'iban' | 'bsn' | 'kvk' | 'vat' | 'rsin' | 'payrollTaxNumber'>> = {
  email: 'email',
  phone: 'phone',
  url: 'url',
  postcode: 'postcode',
  iban: 'iban',
  bsn: 'bsn',
  kvk: 'kvk',
  vat: 'vat',
  rsin: 'rsin',
  payrollTax: 'payrollTaxNumber',
};

/** Types that hold personal data by nature: fields of these types are always limited to people with access to sensitive data. Any other field can be limited in the builder. */
export const SENSITIVE_TYPES: readonly FieldType[] = ['bsn'];
export const SENSITIVE_VIEW = 'personal_data.view';
export const SENSITIVE_EDIT = 'personal_data.edit';

/** Types whose stored text can be encrypted at rest when the field is limited to sensitive data (dates and files stay readable: reminders need them). */
const ENCRYPTABLE_TYPES: readonly FieldType[] = ['bsn', 'iban', 'text', 'textarea', 'phone', 'email', 'postcode'];

export const OPERATORS = ['eq', 'ne', 'in', 'nin', 'filled', 'empty'] as const;
export type Operator = (typeof OPERATORS)[number];

/**
 * A rule that shows a field or section only in some situations.
 *   { field: 'legal_form', op: 'eq', value: 'eenmanszaak' }
 *   { any: [{ field: 'legal_form', op: 'in', value: ['bv', 'nv'] }, { field: 'is_holding', op: 'eq', value: true }] }
 * For a multi-choice value `eq` / `in` mean "contains".
 */
export type Condition = { field: string; op: Operator; value?: unknown } | { all: Condition[] } | { any: Condition[] } | { not: Condition };

export interface FieldChoice {
  /** Stable code that records store; never changes. */
  code: string;
  names: Named;
}

export interface FieldValidation {
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
}

export type FieldWidth = 'full' | 'half' | 'third';

export interface FieldFlags {
  /** A column in the list (by default; people can choose columns). */
  list: boolean;
  filter: boolean;
  export: boolean;
  /** Part of what quick search looks in. */
  search: boolean;
  /** No two records may hold the same value. */
  unique: boolean;
  /** Counts toward a "complete" record: a record where this is empty shows up in the data-quality view. */
  complete: boolean;
}

export interface FieldDef {
  /** Stable name records store the value under. Lower-case letters, digits and `_`; never changes. */
  key: string;
  /** `system`: a column the logic reads — can be renamed, moved and hidden, not deleted or retyped. `custom`: added by the office. */
  kind: 'system' | 'custom';
  type: FieldType;
  labels: Named;
  help: Named;
  placeholder: Named;
  section: string;
  order: number;
  width: FieldWidth;
  required: boolean;
  /** The logic needs this field: it can neither be hidden nor made optional. */
  locked: boolean;
  /** Hidden fields keep their stored values (nothing is ever deleted) but leave forms, lists and exports. */
  active: boolean;
  default: string | number | boolean | string[] | null;
  /** select / multiselect: the pick-list (a key in Settings → Lists) … */
  list: string | null;
  /** … or choices typed in the builder. */
  choices: FieldChoice[];
  validation: FieldValidation;
  showWhen: Condition | null;
  /** Capability needed to see / change the value (`personal_data.view`); null = anyone who may open the record. */
  viewPermission: string | null;
  editPermission: string | null;
  flags: FieldFlags;
}

export interface SectionDef {
  key: string;
  names: Named;
  order: number;
  showWhen: Condition | null;
}

export interface FormDoc {
  version: 1;
  sections: SectionDef[];
  fields: FieldDef[];
}

export const emptyDoc = (): FormDoc => ({ version: 1, sections: [], fields: [] });

export const KEY_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;
export const WIDTHS: readonly FieldWidth[] = ['full', 'half', 'third'];

/** A field whose value is encrypted in the database: a BSN, and any other text field limited to people with access to sensitive data. */
export const isEncryptedField = (field: Pick<FieldDef, 'type' | 'viewPermission'>): boolean =>
  field.type === 'bsn' || (field.viewPermission === SENSITIVE_VIEW && ENCRYPTABLE_TYPES.includes(field.type));

/** The value counts as "not filled in". */
export const isEmptyValue = (value: unknown): boolean =>
  value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0) || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value as object).length === 0);

const matches = (actual: unknown, wanted: unknown): boolean => (Array.isArray(actual) ? actual.some(item => item === wanted) : actual === wanted);

/** Evaluates a `showWhen` rule against the values of a record. (Mirrored in the frontend — keep both in step.) */
export function evaluate(condition: Condition | null | undefined, values: Record<string, unknown>): boolean {
  if (!condition) return true;
  if ('all' in condition) return condition.all.every(inner => evaluate(inner, values));
  if ('any' in condition) return condition.any.some(inner => evaluate(inner, values));
  if ('not' in condition) return !evaluate(condition.not, values);
  const actual = values[condition.field];
  switch (condition.op) {
    case 'eq':
      return matches(actual, condition.value);
    case 'ne':
      return !matches(actual, condition.value);
    case 'in':
      return (Array.isArray(condition.value) ? condition.value : []).some(wanted => matches(actual, wanted));
    case 'nin':
      return !(Array.isArray(condition.value) ? condition.value : []).some(wanted => matches(actual, wanted));
    case 'filled':
      return !isEmptyValue(actual);
    case 'empty':
      return isEmptyValue(actual);
    default:
      return true;
  }
}

/** Keys of the fields a rule looks at. */
export function conditionFields(condition: Condition | null | undefined): string[] {
  if (!condition) return [];
  if ('all' in condition) return condition.all.flatMap(conditionFields);
  if ('any' in condition) return condition.any.flatMap(conditionFields);
  if ('not' in condition) return conditionFields(condition.not);
  return [condition.field];
}
