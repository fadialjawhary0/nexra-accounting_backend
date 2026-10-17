import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import { checkCondition } from '../forms/condition-check.js';
import type { Condition } from '../forms/form-doc.js';
import { MAX_CHECKLIST_ITEMS } from './inspections.constants.js';

/**
 * What an edition of a checklist holds: its parts (sections) and its lines (items). A line says which documents satisfy it, for which period, how old they may be,
 * whether the inspector looks at them on site or wants a copy, and when the line applies at all. It is the only description of an inspector's list — nothing about
 * NEN 4400-1 is written into the program.
 */

/** How many periods a line asks for. The documents are matched to the periods through the period they cover (or, when none is given, the day on them). */
export const PERIOD_RULES = ['none', 'two_latest', 'year_previous', 'year_current', 'years_prev_current', 'quarters_prev_current', 'months_prev_current', 'months_24'] as const;
export type PeriodRule = (typeof PERIOD_RULES)[number];

/** A document of the current year must reach at least this far: `vat_quarter` = the end of the last VAT period that has had its filing time, `month` = the end of last month. */
export const CUTOFFS = ['vat_quarter', 'month'] as const;
export type Cutoff = (typeof CUTOFFS)[number];

/** Whose documents: the client's own, those of the most recent leavers (the inspector's sample), or those of the companies above the client (a holding). */
export const ITEM_SCOPES = ['client', 'sample', 'parents'] as const;
export type ItemScope = (typeof ITEM_SCOPES)[number];

/**
 * How often the inspector asks for a line, which decides whether it starts switched on in a new inspection: `every` inspection, once every `askEveryMonths`
 * months (it starts off while the client's last inspection that asked for it is more recent than that), or only when somebody switches it on (`manual`).
 * The office can always switch a line on or off by hand in the inspection itself.
 */
export const ASK_RULES = ['every', 'months', 'manual'] as const;
export type AskRule = (typeof ASK_RULES)[number];
export const ASK_MONTHS = { min: 2, max: 60 } as const;

export interface ChecklistSection {
  key: string;
  nameNl: string;
  nameEn: string;
  /** The part gets a folder in the dated inspection folder (`Controles / Cicero / 21-08-2026 / Personeels- en loonadministratie`). */
  folder: boolean;
}

export interface ChecklistItem {
  /** What the inspector calls the line (`2`, `9d`). Unique within the edition; also the number in a bundle. */
  code: string;
  section: string;
  labelNl: string;
  labelEn: string;
  /** A line of explanation: the rule in words. */
  helpNl: string;
  helpEn: string;
  scope: ItemScope;
  /** Codes of the document types that satisfy the line. Empty = nothing in the system can: the office ticks it by hand. */
  docTypes: string[];
  period: PeriodRule;
  cutoff: Cutoff | null;
  /** The newest document may be at most this many months old on the day of the inspection. */
  maxAgeMonths: number | null;
  /** "Ter inzage": the inspector wants to see it on site. */
  onSite: boolean;
  /** "Kopie digitaal": the inspector wants a copy. */
  digital: boolean;
  /** The document may hold a citizen service number (an ID copy, the payroll-tax form): the BSN warning leaves it alone. */
  bsnAllowed: boolean;
  /** Not having it is not a problem (it does not count against being ready). */
  optional: boolean;
  /** When the line applies, in the form builder's condition language over `client.*` fields; null = always. */
  condition: Condition | null;
  /** How often the inspector asks for it (see ASK_RULES). */
  ask: AskRule;
  /** With `ask: 'months'`: the number of months. */
  askEveryMonths: number | null;
}

export interface ChecklistDoc {
  sections: ChecklistSection[];
  items: ChecklistItem[];
}

export const EMPTY_ITEM: Omit<ChecklistItem, 'code' | 'section'> = {
  labelNl: '',
  labelEn: '',
  helpNl: '',
  helpEn: '',
  scope: 'client',
  docTypes: [],
  period: 'none',
  cutoff: null,
  maxAgeMonths: null,
  onSite: true,
  digital: false,
  bsnAllowed: false,
  optional: false,
  condition: null,
  ask: 'every',
  askEveryMonths: null,
};

const askMonthsOf = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) && value >= ASK_MONTHS.min && value <= ASK_MONTHS.max ? value : null);

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const SECTION_KEY = /^[a-z0-9_]{1,30}$/;
const ITEM_CODE = /^[0-9A-Za-z][0-9A-Za-z.-]{0,9}$/;

/** What is stored, read as a document (a missing property takes its default, so an older stored edition still reads). */
export function readDoc(sections: unknown, items: unknown): ChecklistDoc {
  const sectionRows = Array.isArray(sections) ? sections.filter(isRecord) : [];
  const itemRows = Array.isArray(items) ? items.filter(isRecord) : [];
  return {
    sections: sectionRows.map(row => ({ key: text(row.key), nameNl: text(row.nameNl), nameEn: text(row.nameEn), folder: row.folder === true })),
    items: itemRows.map(row => ({
      code: text(row.code),
      section: text(row.section),
      labelNl: text(row.labelNl),
      labelEn: text(row.labelEn),
      helpNl: text(row.helpNl),
      helpEn: text(row.helpEn),
      scope: (ITEM_SCOPES as readonly string[]).includes(row.scope as string) ? (row.scope as ItemScope) : 'client',
      docTypes: Array.isArray(row.docTypes) ? row.docTypes.filter((code): code is string => typeof code === 'string') : [],
      period: (PERIOD_RULES as readonly string[]).includes(row.period as string) ? (row.period as PeriodRule) : 'none',
      cutoff: (CUTOFFS as readonly string[]).includes(row.cutoff as string) ? (row.cutoff as Cutoff) : null,
      maxAgeMonths: typeof row.maxAgeMonths === 'number' && row.maxAgeMonths > 0 ? Math.floor(row.maxAgeMonths) : null,
      onSite: row.onSite !== false,
      digital: row.digital === true,
      bsnAllowed: row.bsnAllowed === true,
      optional: row.optional === true,
      condition: isRecord(row.condition) && Object.keys(row.condition).length ? (row.condition as unknown as Condition) : null,
      // Editions saved before the rule existed: every line was asked at every inspection.
      ...askOf(row.ask, row.askEveryMonths),
    })),
  };
}

/** The rule as stored; anything unknown reads as "every inspection". */
function askOf(ask: unknown, months: unknown): Pick<ChecklistItem, 'ask' | 'askEveryMonths'> {
  if (ask === 'manual') return { ask: 'manual', askEveryMonths: null };
  const every = askMonthsOf(months);
  return ask === 'months' && every ? { ask: 'months', askEveryMonths: every } : { ask: 'every', askEveryMonths: null };
}

export type Problems = Record<string, string>;

export interface KnownValues {
  /** Codes of the document types that exist. */
  types: ReadonlySet<string>;
  /** Keys of the client fields a condition may look at (`client.legal_form`). */
  fields: ReadonlySet<string>;
}

/**
 * A document as it came from the editor, checked: every problem is reported under `sections.<n>.<part>` or `items.<n>.<part>` (a message key of the `validation` file) and
 * the document that comes back is the cleaned one — trimmed texts, unknown properties dropped, codes upper-cased where they are numbers followed by letters.
 */
export function sanitizeDoc(input: unknown, known: KnownValues): { doc: ChecklistDoc; problems: Problems } {
  const problems: Problems = {};
  const source = isRecord(input) ? input : {};
  const rawSections = Array.isArray(source.sections) ? source.sections : [];
  const rawItems = Array.isArray(source.items) ? source.items : [];
  if (rawItems.length > MAX_CHECKLIST_ITEMS) problems.items = `validation.maxItems|${JSON.stringify({ max: MAX_CHECKLIST_ITEMS })}`;
  if (rawSections.length > 30) problems.sections = `validation.maxItems|${JSON.stringify({ max: 30 })}`;

  const sections: ChecklistSection[] = [];
  const sectionKeys = new Set<string>();
  rawSections.slice(0, 30).forEach((raw, index) => {
    const row = isRecord(raw) ? raw : {};
    const key = text(row.key);
    const nameNl = text(row.nameNl);
    const nameEn = text(row.nameEn);
    if (!SECTION_KEY.test(key)) problems[`sections.${index}.key`] = 'validation.invalid';
    else if (sectionKeys.has(key)) problems[`sections.${index}.key`] = 'validation.alreadyExists';
    if (!nameNl) problems[`sections.${index}.nameNl`] = 'validation.required';
    else if (nameNl.length > 80) problems[`sections.${index}.nameNl`] = `validation.maxLength|${JSON.stringify({ max: 80 })}`;
    if (!nameEn) problems[`sections.${index}.nameEn`] = 'validation.required';
    else if (nameEn.length > 80) problems[`sections.${index}.nameEn`] = `validation.maxLength|${JSON.stringify({ max: 80 })}`;
    sectionKeys.add(key);
    sections.push({ key, nameNl, nameEn, folder: row.folder === true });
  });

  const items: ChecklistItem[] = [];
  const codes = new Set<string>();
  rawItems.slice(0, MAX_CHECKLIST_ITEMS).forEach((raw, index) => {
    const row = isRecord(raw) ? raw : {};
    const at = (part: string) => `items.${index}.${part}`;
    const code = text(row.code);
    const section = text(row.section);
    const labelNl = text(row.labelNl);
    const labelEn = text(row.labelEn);
    const helpNl = text(row.helpNl);
    const helpEn = text(row.helpEn);

    if (!ITEM_CODE.test(code)) problems[at('code')] = code ? 'validation.invalid' : 'validation.required';
    else if (codes.has(code.toLowerCase())) problems[at('code')] = 'validation.alreadyExists';
    codes.add(code.toLowerCase());
    if (!sectionKeys.has(section)) problems[at('section')] = 'validation.selectOption';
    if (!labelNl) problems[at('labelNl')] = 'validation.required';
    else if (labelNl.length > 240) problems[at('labelNl')] = `validation.maxLength|${JSON.stringify({ max: 240 })}`;
    if (!labelEn) problems[at('labelEn')] = 'validation.required';
    else if (labelEn.length > 240) problems[at('labelEn')] = `validation.maxLength|${JSON.stringify({ max: 240 })}`;
    if (helpNl.length > 600) problems[at('helpNl')] = `validation.maxLength|${JSON.stringify({ max: 600 })}`;
    if (helpEn.length > 600) problems[at('helpEn')] = `validation.maxLength|${JSON.stringify({ max: 600 })}`;

    const docTypes = [...new Set(Array.isArray(row.docTypes) ? row.docTypes.filter((entry): entry is string => typeof entry === 'string').map(entry => entry.trim()).filter(Boolean) : [])];
    if (docTypes.length > 12) problems[at('docTypes')] = `validation.maxItems|${JSON.stringify({ max: 12 })}`;
    else if (docTypes.some(entry => !known.types.has(entry))) problems[at('docTypes')] = 'validation.invalid';

    const scope = (ITEM_SCOPES as readonly string[]).includes(row.scope as string) ? (row.scope as ItemScope) : null;
    if (!scope) problems[at('scope')] = 'validation.selectOption';
    const period = (PERIOD_RULES as readonly string[]).includes(row.period as string) ? (row.period as PeriodRule) : null;
    if (!period) problems[at('period')] = 'validation.selectOption';
    const cutoff = row.cutoff === null || row.cutoff === undefined || row.cutoff === '' ? null : (CUTOFFS as readonly string[]).includes(row.cutoff as string) ? (row.cutoff as Cutoff) : undefined;
    if (cutoff === undefined) problems[at('cutoff')] = 'validation.selectOption';

    let maxAgeMonths: number | null = null;
    if (row.maxAgeMonths !== null && row.maxAgeMonths !== undefined && row.maxAgeMonths !== '') {
      const value = Number(row.maxAgeMonths);
      if (!Number.isInteger(value)) problems[at('maxAgeMonths')] = 'validation.wholeNumber';
      else if (value < 1 || value > 120) problems[at('maxAgeMonths')] = value < 1 ? `validation.min|${JSON.stringify({ min: 1 })}` : `validation.max|${JSON.stringify({ max: 120 })}`;
      else maxAgeMonths = value;
    }

    let condition: Condition | null = null;
    if (isRecord(row.condition) && Object.keys(row.condition).length) {
      condition = checkCondition(row.condition, known.fields);
      if (!condition) problems[at('condition')] = 'validation.invalid';
    }

    const ask = row.ask === undefined || row.ask === null || row.ask === '' ? 'every' : (ASK_RULES as readonly string[]).includes(row.ask as string) ? (row.ask as AskRule) : null;
    if (!ask) problems[at('ask')] = 'validation.selectOption';
    let askEveryMonths: number | null = null;
    if (ask === 'months') {
      const value = Number(row.askEveryMonths);
      if (row.askEveryMonths === null || row.askEveryMonths === undefined || row.askEveryMonths === '') problems[at('askEveryMonths')] = 'validation.required';
      else if (!Number.isInteger(value)) problems[at('askEveryMonths')] = 'validation.wholeNumber';
      else if (value < ASK_MONTHS.min) problems[at('askEveryMonths')] = `validation.min|${JSON.stringify({ min: ASK_MONTHS.min })}`;
      else if (value > ASK_MONTHS.max) problems[at('askEveryMonths')] = `validation.max|${JSON.stringify({ max: ASK_MONTHS.max })}`;
      else askEveryMonths = value;
    }

    items.push({
      code,
      section,
      labelNl,
      labelEn,
      helpNl,
      helpEn,
      // Nothing in the system satisfies a line without document types: it is ticked by hand, whatever else was set.
      scope: docTypes.length ? (scope ?? 'client') : 'client',
      docTypes,
      period: docTypes.length ? (period ?? 'none') : 'none',
      cutoff: docTypes.length ? (cutoff ?? null) : null,
      maxAgeMonths: docTypes.length ? maxAgeMonths : null,
      onSite: row.onSite !== false,
      digital: row.digital === true,
      bsnAllowed: row.bsnAllowed === true,
      optional: row.optional === true,
      condition,
      ask: ask ?? 'every',
      askEveryMonths: ask === 'months' ? askEveryMonths : null,
    });
  });
  if (!rawSections.length && rawItems.length) problems.sections = 'validation.required';
  return { doc: { sections, items }, problems };
}

export const itemLabel = (item: Pick<ChecklistItem, 'labelNl' | 'labelEn'>, locale: AppLocale): string => (locale === 'nl' ? item.labelNl : item.labelEn) || item.labelNl || item.labelEn;
export const itemHelp = (item: Pick<ChecklistItem, 'helpNl' | 'helpEn'>, locale: AppLocale): string => (locale === 'nl' ? item.helpNl : item.helpEn) || item.helpNl || item.helpEn;
export const sectionName = (section: Pick<ChecklistSection, 'nameNl' | 'nameEn'>, locale: AppLocale): string => (locale === 'nl' ? section.nameNl : section.nameEn) || section.nameNl || section.nameEn;
