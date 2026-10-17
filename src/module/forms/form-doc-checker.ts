import {
  FIELD_TYPES,
  KEY_PATTERN,
  OPERATORS,
  SENSITIVE_EDIT,
  SENSITIVE_TYPES,
  SENSITIVE_VIEW,
  WIDTHS,
  conditionFields,
  isEncryptedField,
  type Condition,
  type FieldChoice,
  type FieldDef,
  type FieldFlags,
  type FieldType,
  type FieldValidation,
  type FormDoc,
  type Named,
  type SectionDef,
} from './form-doc.js';
import { RESERVED_FIELD_KEYS } from './form-entities.js';

/** Messages are translation keys (`validation.required`, `forms.keyTaken`); `problems` maps a place in the document to one. */
export type Problems = Record<string, string>;

const MAX_SECTIONS = 30;
const MAX_FIELDS = 300;
const MAX_CHOICES = 200;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/** Types that cannot hold "the same value as another record". */
const NOT_UNIQUE: readonly FieldType[] = ['textarea', 'boolean', 'multiselect', 'file', 'user', 'client'];

/**
 * Turns whatever the form builder sent into a clean document, and says what is wrong with it.
 *   - fields that were published before can be renamed, moved, hidden and re-flagged, but never removed, retyped or turned from system
 *     into custom (those properties are taken from the live document, whatever the request says);
 *   - fields added now are always custom;
 *   - the `showWhen` rules may only point at fields of the same form and may not depend on each other in a circle.
 */
export function checkDoc(input: unknown, live: FormDoc | null, knownLists: ReadonlySet<string>): { doc: FormDoc; problems: Problems } {
  const problems: Problems = {};
  const source = isRecord(input) ? input : {};
  const liveFields = new Map((live?.fields ?? []).map(field => [field.key, field]));

  const sectionsIn = Array.isArray(source.sections) ? source.sections.slice(0, MAX_SECTIONS) : [];
  const fieldsIn = Array.isArray(source.fields) ? source.fields.slice(0, MAX_FIELDS) : [];

  const named = (value: unknown, place: string, max: number, required: boolean): Named => {
    const raw = isRecord(value) ? value : {};
    const result = { nl: text(raw.nl, max), en: text(raw.en, max) };
    if (required) for (const language of ['nl', 'en'] as const) if (!result[language]) problems[`${place}.${language}`] = 'validation.required';
    return result;
  };

  // Sections
  const sections: SectionDef[] = [];
  const sectionKeys = new Set<string>();
  sectionsIn.forEach((raw, index) => {
    const entry = isRecord(raw) ? raw : {};
    const key = text(entry.key, 40);
    const place = `section.${key || index}`;
    if (!KEY_PATTERN.test(key)) problems[`${place}.key`] = 'forms.keyInvalid';
    else if (sectionKeys.has(key)) problems[`${place}.key`] = 'forms.keyTaken';
    sectionKeys.add(key);
    sections.push({ key, names: named(entry.names, `${place}.names`, 80, true), order: index, showWhen: null });
  });
  if (!sections.length) problems.doc = 'forms.sectionNeeded';

  // Fields
  const fields: FieldDef[] = [];
  const fieldKeys = new Set<string>();
  fieldsIn.forEach((raw, index) => {
    const entry = isRecord(raw) ? raw : {};
    const key = text(entry.key, 40);
    const place = `field.${key || index}`;
    const previous = liveFields.get(key);

    if (!KEY_PATTERN.test(key) || RESERVED_FIELD_KEYS.has(key)) problems[`${place}.key`] = 'forms.keyInvalid';
    else if (fieldKeys.has(key)) problems[`${place}.key`] = 'forms.keyTaken';
    fieldKeys.add(key);

    // What can never change once published comes from the live document.
    const type = (previous?.type ?? entry.type) as FieldType;
    if (!FIELD_TYPES.includes(type)) problems[`${place}.type`] = 'validation.selectOption';
    const kind: FieldDef['kind'] = previous ? previous.kind : 'custom';
    const locked = previous ? previous.locked : false;

    const section = text(entry.section, 40);
    if (!sectionKeys.has(section)) problems[`${place}.section`] = 'forms.sectionMissing';

    const width = WIDTHS.includes(entry.width as never) ? (entry.width as FieldDef['width']) : 'full';
    const choices = type === 'select' || type === 'multiselect' ? checkChoices(entry.choices, place, problems) : [];
    const list = type === 'select' || type === 'multiselect' ? text(entry.list, 60) || null : null;
    if (type === 'select' || type === 'multiselect') {
      if (list && !knownLists.has(list)) problems[`${place}.list`] = 'forms.listMissing';
      if (!list && !choices.length) problems[`${place}.choices`] = 'forms.choicesNeeded';
    }

    const flagsIn = isRecord(entry.flags) ? entry.flags : {};
    const flag = (name: keyof FieldFlags, fallback: boolean) => (typeof flagsIn[name] === 'boolean' ? (flagsIn[name] as boolean) : fallback);
    const flags: FieldFlags = {
      list: flag('list', false),
      filter: flag('filter', false),
      export: flag('export', true),
      search: flag('search', false),
      unique: flag('unique', false),
      complete: flag('complete', false),
    };
    if (flags.unique && NOT_UNIQUE.includes(type)) flags.unique = false;
    if (flags.search && !['text', 'textarea', 'email', 'phone', 'postcode', 'kvk', 'vat', 'rsin', 'payrollTax', 'select'].includes(type)) flags.search = false;

    const sensitive = SENSITIVE_TYPES.includes(type);
    // A BSN field is always limited to people with access to sensitive data; any other field is limited when the builder says so.
    const limited = sensitive || entry.viewPermission === SENSITIVE_VIEW || entry.editPermission === SENSITIVE_EDIT;
    // Encrypted values cannot be listed, searched, filtered or exported.
    if (isEncryptedField({ type, viewPermission: limited ? SENSITIVE_VIEW : null })) {
      flags.list = false;
      flags.filter = false;
      flags.export = false;
      flags.search = false;
    }

    const required = locked ? true : typeof entry.required === 'boolean' ? entry.required : false;
    const active = locked ? true : typeof entry.active === 'boolean' ? entry.active : true;

    fields.push({
      key,
      kind,
      type,
      labels: named(entry.labels, `${place}.labels`, 80, true),
      help: named(entry.help, `${place}.help`, 300, false),
      placeholder: named(entry.placeholder, `${place}.placeholder`, 80, false),
      section,
      order: typeof entry.order === 'number' ? entry.order : index,
      width,
      required,
      locked,
      active,
      default: checkDefault(entry.default, type, place, problems),
      list,
      choices,
      validation: checkValidation(entry.validation, type, place, problems),
      showWhen: null,
      viewPermission: limited ? SENSITIVE_VIEW : null,
      editPermission: limited ? SENSITIVE_EDIT : null,
      flags,
    });
  });

  // Published fields can be hidden, not removed.
  for (const key of liveFields.keys()) if (!fieldKeys.has(key)) problems[`field.${key}.key`] = 'forms.cannotRemove';

  // Conditions need the finished list of keys.
  const known = new Set(fields.map(field => field.key));
  sectionsIn.forEach((raw, index) => {
    const section = sections[index];
    if (section && isRecord(raw)) section.showWhen = checkCondition(raw.showWhen, known, `section.${section.key}.showWhen`, problems);
  });
  fieldsIn.forEach((raw, index) => {
    const field = fields[index];
    if (field && isRecord(raw)) field.showWhen = checkCondition(raw.showWhen, known, `field.${field.key}.showWhen`, problems, field.key);
  });
  const cycle = findCycle(fields);
  if (cycle) problems[`field.${cycle}.showWhen`] = 'forms.cycle';

  // Dense, stable order: by section order, then by the given order.
  const sectionOrder = new Map(sections.map(section => [section.key, section.order]));
  fields.sort((a, b) => (sectionOrder.get(a.section) ?? 0) - (sectionOrder.get(b.section) ?? 0) || a.order - b.order);
  const counters = new Map<string, number>();
  for (const field of fields) {
    const next = counters.get(field.section) ?? 0;
    field.order = next;
    counters.set(field.section, next + 1);
  }
  return { doc: { version: 1, sections, fields }, problems };
}

function checkChoices(input: unknown, place: string, problems: Problems): FieldChoice[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const choices: FieldChoice[] = [];
  for (const raw of input.slice(0, MAX_CHOICES)) {
    const entry = isRecord(raw) ? raw : {};
    const code = text(entry.code, 40);
    const names = isRecord(entry.names) ? entry.names : {};
    if (!KEY_PATTERN.test(code) || seen.has(code)) {
      problems[`${place}.choices`] = 'forms.choiceInvalid';
      continue;
    }
    seen.add(code);
    const nl = text(names.nl, 80);
    const en = text(names.en, 80);
    if (!nl || !en) problems[`${place}.choices`] = 'forms.choiceInvalid';
    choices.push({ code, names: { nl, en } });
  }
  return choices;
}

function checkValidation(input: unknown, type: FieldType, place: string, problems: Problems): FieldValidation {
  const raw = isRecord(input) ? input : {};
  const result: FieldValidation = {};
  const number = (name: 'min' | 'max' | 'minLength' | 'maxLength', allowed: boolean, integer = false) => {
    const value = raw[name];
    if (value === undefined || value === null || value === '') return;
    if (!allowed) return;
    if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isInteger(value))) {
      problems[`${place}.validation`] = 'validation.invalid';
      return;
    }
    result[name] = value;
  };
  const numeric = type === 'number' || type === 'money';
  const texty = type === 'text' || type === 'textarea';
  number('min', numeric);
  number('max', numeric);
  number('minLength', texty, true);
  number('maxLength', texty, true);
  // A date of birth (or any date that cannot lie ahead): no day after today.
  if (type === 'date' && raw.notFuture === true) result.notFuture = true;
  if (result.min !== undefined && result.max !== undefined && result.min > result.max) problems[`${place}.validation`] = 'validation.invalid';
  if (result.minLength !== undefined && result.maxLength !== undefined && result.minLength > result.maxLength) problems[`${place}.validation`] = 'validation.invalid';
  return result;
}

function checkDefault(input: unknown, type: FieldType, place: string, problems: Problems): FieldDef['default'] {
  if (input === undefined || input === null || input === '') return null;
  const ok =
    (['text', 'textarea', 'select', 'email', 'phone', 'url', 'postcode', 'iban', 'bsn', 'kvk', 'vat', 'rsin', 'payrollTax', 'date'].includes(type) && typeof input === 'string') ||
    (['number', 'money'].includes(type) && typeof input === 'number' && Number.isFinite(input)) ||
    (type === 'boolean' && typeof input === 'boolean') ||
    (type === 'multiselect' && Array.isArray(input) && input.every(item => typeof item === 'string'));
  if (!ok) {
    problems[`${place}.default`] = 'validation.invalid';
    return null;
  }
  return input as FieldDef['default'];
}

function checkCondition(input: unknown, known: ReadonlySet<string>, place: string, problems: Problems, self?: string, depth = 0): Condition | null {
  if (input === undefined || input === null) return null;
  if (!isRecord(input) || depth > 4) {
    problems[place] = 'validation.invalid';
    return null;
  }
  for (const group of ['all', 'any'] as const) {
    const members = input[group];
    if (members !== undefined) {
      if (!Array.isArray(members) || members.length === 0 || members.length > 10) {
        problems[place] = 'validation.invalid';
        return null;
      }
      const checked = members.map(member => checkCondition(member, known, place, problems, self, depth + 1)).filter((member): member is Condition => member !== null);
      return checked.length ? ({ [group]: checked } as Condition) : null;
    }
  }
  if (input.not !== undefined) {
    const inner = checkCondition(input.not, known, place, problems, self, depth + 1);
    return inner ? { not: inner } : null;
  }
  const field = text(input.field, 40);
  const op = input.op as (typeof OPERATORS)[number];
  if (!known.has(field) || field === self) {
    problems[place] = 'forms.conditionFieldMissing';
    return null;
  }
  if (!OPERATORS.includes(op)) {
    problems[place] = 'validation.invalid';
    return null;
  }
  if (op === 'filled' || op === 'empty') return { field, op };
  if ((op === 'in' || op === 'nin') && (!Array.isArray(input.value) || input.value.length === 0)) {
    problems[place] = 'validation.invalid';
    return null;
  }
  return { field, op, value: input.value };
}

/** Key of a field that (through other fields' rules) depends on itself, if any. */
function findCycle(fields: FieldDef[]): string | null {
  const edges = new Map(fields.map(field => [field.key, conditionFields(field.showWhen)]));
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (key: string): string | null => {
    if (state.get(key) === 'done') return null;
    if (state.get(key) === 'visiting') return key;
    state.set(key, 'visiting');
    for (const next of edges.get(key) ?? []) {
      const found = visit(next);
      if (found) return found;
    }
    state.set(key, 'done');
    return null;
  };
  for (const key of edges.keys()) {
    const found = visit(key);
    if (found) return found;
  }
  return null;
}
