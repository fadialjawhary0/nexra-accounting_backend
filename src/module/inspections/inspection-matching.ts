import { addMonths, formatDay, parseDay } from '../../common/dates.js';
import { evaluate } from '../forms/form-doc.js';
import type { ChecklistItem, Cutoff, PeriodRule } from './checklist-doc.js';
import type { ItemDecision } from './inspections.constants.js';

/*
 * The matching of documents to the lines of a checklist: pure functions, no database. Given the day of the inspection, the lines, what is known about the client and the
 * documents on file, it says for every line whether it is ready, partly ready, missing, too old or has to be done by hand — and which documents it found. Nothing here
 * is NEN 4400-specific: everything comes from the lines (document types, period rule, maximum age, cut-off, condition).
 */

/** How a line stands. `done` = the office ticked it ("shown in another way"); `manual` = nothing in the system can satisfy it, it has to be ticked. */
export type ItemState = 'ready' | 'partial' | 'missing' | 'too_old' | 'undated' | 'manual' | 'done' | 'not_applicable';

export interface MatchFile {
  id: string;
  name: string;
  docType: string | null;
  /** The date on the document (`YYYY-MM-DD`). */
  docDate: string | null;
  /** The stretch of time the document is about; when only one end is known it counts as a single day. */
  periodFrom: string | null;
  periodTo: string | null;
}

/** A worker of the sample or a company above the client: the lines that ask for "each of them" are checked per subject. */
export interface MatchSubject {
  id: string;
  name: string;
  files: MatchFile[];
}

/** What people decided about one line: documents put on it by hand and documents taken off it. */
export interface ItemChoice {
  decision: ItemDecision | null;
  added: ReadonlySet<string>;
  excluded: ReadonlySet<string>;
}

export interface MatchInput {
  /** The day of the inspection: ages and periods are counted from it. */
  asOf: string;
  items: readonly ChecklistItem[];
  /** The client's values for the conditions of the lines (`client.legal_form`). */
  clientValues: Record<string, unknown>;
  /** The client's own current documents. */
  files: readonly MatchFile[];
  /** The most recent leavers (the inspector's sample). */
  sample: readonly MatchSubject[];
  /** The companies above the client (a holding, and its holding …). */
  parents: readonly MatchSubject[];
  /** By code of the line. */
  choices: ReadonlyMap<string, ItemChoice>;
  /** Documents put on a line by hand, by id (they count whatever their type). */
  added: ReadonlyMap<string, MatchFile>;
  /** The day of the client's most recent earlier inspection that asked for a line, by code of the line (for the lines asked once every so many months). */
  lastAsked: ReadonlyMap<string, string>;
}

export interface UsedFile {
  id: string;
  /** `matched` by type and period, or `added` by hand. */
  source: 'matched' | 'added';
  /** The period unit it covers (`2026-Q1`), when the line is asked per period. */
  unit: string | null;
}

export interface UnitsResult {
  /** `2026`, `2026-Q2` or `2026-04`, in order. */
  keys: string[];
  covered: string[];
  missing: string[];
}

export interface SubjectResult {
  id: string;
  name: string;
  state: ItemState;
  files: UsedFile[];
  units: UnitsResult | null;
  newestDate: string | null;
  ageMonths: number | null;
  /** Documents of the right type that are of other periods. */
  outside: number;
}

/**
 * Why a line is switched off: somebody switched it off (`decision`), it does not apply to this client (`condition`), there is nobody to ask it for (`no_subjects`),
 * it is only asked when somebody switches it on (`manual`), or it was asked recently and is asked again only after some months (`interval`).
 */
export type NotApplicableBecause = 'decision' | 'condition' | 'no_subjects' | 'manual' | 'interval';

export interface ItemResult {
  code: string;
  state: ItemState;
  /** The line is switched on: the inspector asks for it this time. */
  applicable: boolean;
  /** Not having it is not a problem (it does not count against being ready). */
  optional: boolean;
  notApplicableBecause: NotApplicableBecause | null;
  decision: ItemDecision | null;
  /** Every document the line uses (of all subjects). */
  files: UsedFile[];
  /** Per worker / company, for the lines that ask for each of them. */
  subjects: SubjectResult[] | null;
  units: UnitsResult | null;
  newestDate: string | null;
  /** How old the newest document is on the day of the inspection, in whole months. */
  ageMonths: number | null;
  maxAgeMonths: number | null;
  /** The day a document of the current year has to reach (`cutoff`), when the line has such a rule. */
  cutoffDate: string | null;
  outside: number;
  /** The day of the client's most recent earlier inspection that asked for this line. */
  lastAsked?: string | null;
  /** A line asked once every so many months that is off for now: the day from which it is switched on again. */
  askAgainFrom?: string | null;
}

export interface Summary {
  /** The lines that count: they apply and are not optional. */
  total: number;
  ready: number;
  partial: number;
  missing: number;
  tooOld: number;
  undated: number;
  manual: number;
  notApplicable: number;
  /** Optional lines that are not there (they do not count against it). */
  optionalOpen: number;
  /** 0 – 100: ready / total. */
  percent: number;
}

const NO_FILES: ReadonlySet<string> = new Set();
const pad = (value: number): string => String(value).padStart(2, '0');

/* ── Dates and periods ──────────────────────────────────────────────────────────────────────────────────────────────── */

interface Unit {
  key: string;
  from: string;
  to: string;
}

const monthEnd = (year: number, month: number): string => formatDay(new Date(Date.UTC(year, month, 0)));
const yearUnit = (year: number): Unit => ({ key: String(year), from: `${year}-01-01`, to: `${year}-12-31` });
const quarterUnit = (year: number, quarter: number): Unit => {
  const first = (quarter - 1) * 3 + 1;
  return { key: `${year}-Q${quarter}`, from: `${year}-${pad(first)}-01`, to: monthEnd(year, first + 2) };
};
const monthUnit = (year: number, month: number): Unit => ({ key: `${year}-${pad(month)}`, from: `${year}-${pad(month)}-01`, to: monthEnd(year, month) });

/** The periods a rule asks for on the day of the inspection (null = the rule is not about periods). */
export function unitsFor(rule: PeriodRule, asOf: string): Unit[] | null {
  const year = Number(asOf.slice(0, 4));
  switch (rule) {
    case 'year_previous':
      return [yearUnit(year - 1)];
    case 'year_current':
      return [yearUnit(year)];
    case 'years_prev_current':
      return [yearUnit(year - 1), yearUnit(year)];
    case 'quarters_prev_current': {
      const units = [1, 2, 3, 4].map(quarter => quarterUnit(year - 1, quarter));
      // A quarter of this year is expected once its filing month is over (the return is due a month after the quarter).
      for (const quarter of [1, 2, 3, 4]) {
        const unit = quarterUnit(year, quarter);
        if (addMonths(unit.to, 1) <= asOf) units.push(unit);
      }
      return units;
    }
    case 'months_prev_current': {
      const units: Unit[] = [];
      for (let month = 1; month <= 12; month += 1) units.push(monthUnit(year - 1, month));
      // A month of this year is expected once its filing time is over (a payroll-tax return is due by the end of the next month).
      for (let month = 1; month <= 12; month += 1) {
        const unit = monthUnit(year, month);
        if (addMonths(unit.to, 1) <= asOf) units.push(unit);
      }
      return units;
    }
    case 'months_24': {
      const units: Unit[] = [];
      const month = Number(asOf.slice(5, 7));
      for (let back = 24; back >= 1; back -= 1) {
        const date = new Date(Date.UTC(year, month - 1 - back, 1));
        units.push(monthUnit(date.getUTCFullYear(), date.getUTCMonth() + 1));
      }
      return units;
    }
    default:
      return null;
  }
}

/** The end of the last VAT period / month whose filing time has passed on the day of the inspection. */
export function cutoffDateFor(cutoff: Cutoff, asOf: string): string {
  const year = Number(asOf.slice(0, 4));
  const month = Number(asOf.slice(5, 7));
  if (cutoff === 'month') {
    for (let back = 1; back <= 14; back += 1) {
      const date = new Date(Date.UTC(year, month - 1 - back, 1));
      const end = monthEnd(date.getUTCFullYear(), date.getUTCMonth() + 1);
      if (addMonths(end, 1) <= asOf) return end;
    }
    return asOf;
  }
  for (let back = 0; back <= 6; back += 1) {
    // The quarters, newest first, starting with the one the day falls in.
    const index = Math.floor((month - 1) / 3) - back;
    const quarterYear = year + Math.floor(index / 4);
    const quarter = ((index % 4) + 4) % 4 + 1;
    const end = quarterUnit(quarterYear, quarter).to;
    if (addMonths(end, 1) <= asOf) return end;
  }
  return asOf;
}

/** Whole months from `from` to `to` (negative when `to` is earlier), for showing an age. */
export function monthsBetween(from: string, to: string): number {
  const a = parseDay(from);
  const b = parseDay(to);
  let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (months > 0 && addMonths(from, months) > to) months -= 1;
  else if (months < 0 && addMonths(from, months) < to) months += 1;
  return months;
}

/** The days a document covers: its period, else the day on it; null when it has neither. */
const rangeOf = (file: MatchFile): [string, string] | null => {
  if (file.periodFrom && file.periodTo) return file.periodFrom <= file.periodTo ? [file.periodFrom, file.periodTo] : [file.periodTo, file.periodFrom];
  const single = file.periodFrom ?? file.periodTo;
  if (single) return [single, single];
  return file.docDate ? [file.docDate, file.docDate] : null;
};
const overlaps = (range: [string, string], unit: Unit): boolean => range[0] <= unit.to && range[1] >= unit.from;
/** The day used to tell how old a document is. */
const dateOf = (file: MatchFile): string | null => file.docDate ?? file.periodTo ?? file.periodFrom;
/** The last day the document is about. */
const endOf = (file: MatchFile): string | null => file.periodTo ?? file.docDate ?? file.periodFrom;
const newestFirst = (a: MatchFile, b: MatchFile): number => (dateOf(b) ?? '').localeCompare(dateOf(a) ?? '') || a.name.localeCompare(b.name);

/* ── One subject, one line ──────────────────────────────────────────────────────────────────────────────────────────── */

interface Evaluated {
  state: ItemState;
  files: UsedFile[];
  units: UnitsResult | null;
  newestDate: string | null;
  ageMonths: number | null;
  outside: number;
}

function evaluateSubject(item: ChecklistItem, files: readonly MatchFile[], choice: ItemChoice | undefined, asOf: string, added: ReadonlyMap<string, MatchFile>, allowAdded: boolean): Evaluated {
  const wanted = new Set(item.docTypes);
  const excluded = choice?.excluded ?? NO_FILES;
  const matched = files.filter(file => file.docType !== null && wanted.has(file.docType) && !excluded.has(file.id));
  const byHand = allowAdded ? [...(choice?.added ?? NO_FILES)].map(id => added.get(id)).filter((file): file is MatchFile => Boolean(file) && !excluded.has(file!.id)) : [];
  const source = new Map<string, 'matched' | 'added'>();
  for (const file of matched) source.set(file.id, 'matched');
  for (const file of byHand) if (!source.has(file.id)) source.set(file.id, 'added');
  const pool = [...matched, ...byHand.filter(file => !matched.some(other => other.id === file.id))];
  const empty: Evaluated = { state: 'missing', files: [], units: null, newestDate: null, ageMonths: null, outside: 0 };
  if (!pool.length) return empty;

  let state: ItemState = 'ready';
  let used: Array<{ file: MatchFile; unit: string | null }> = [];
  let units: UnitsResult | null = null;
  let outside = 0;
  const periods = unitsFor(item.period, asOf);

  if (periods) {
    // A document put on the line by hand that says nothing about the time it covers is the office's word that it covers all of it.
    const placed = pool.map(file => ({ file, range: rangeOf(file), byHand: source.get(file.id) === 'added' }));
    const covered: string[] = [];
    const taken = new Map<string, string | null>();
    for (const unit of periods) {
      const hits = placed.filter(entry => (entry.range ? overlaps(entry.range, unit) : entry.byHand));
      if (!hits.length) continue;
      covered.push(unit.key);
      for (const hit of hits) if (!taken.has(hit.file.id)) taken.set(hit.file.id, unit.key);
    }
    // In the order of the periods (the oldest first), then by date.
    const rank = new Map(periods.map((unit, position) => [unit.key, position]));
    used = pool
      .filter(file => taken.has(file.id))
      .map(file => ({ file, unit: taken.get(file.id) ?? null }))
      .sort((a, b) => (rank.get(a.unit ?? '') ?? periods.length) - (rank.get(b.unit ?? '') ?? periods.length) || (dateOf(a.file) ?? '').localeCompare(dateOf(b.file) ?? '') || a.file.name.localeCompare(b.file.name));
    outside = pool.length - used.length;
    const keys = periods.map(unit => unit.key);
    units = { keys, covered, missing: keys.filter(key => !covered.includes(key)) };
    // Nothing covers any period: either the documents carry no date at all, or they are all of other periods.
    if (!covered.length) state = placed.some(entry => entry.range) ? 'missing' : 'undated';
    else if (units.missing.length) state = 'partial';
  } else if (item.period === 'two_latest') {
    const sorted = [...pool].sort(newestFirst).slice(0, 2);
    used = sorted.map(file => ({ file, unit: null }));
    outside = pool.length - used.length;
    if (sorted.length < 2) state = 'partial';
  } else {
    const newest = [...pool].sort(newestFirst)[0]!;
    used = [{ file: newest, unit: null }];
    outside = pool.length - 1;
  }

  const dates = used.map(entry => dateOf(entry.file)).filter((value): value is string => Boolean(value));
  const newestDate = dates.length ? dates.reduce((latest, value) => (value > latest ? value : latest)) : null;
  const ageMonths = newestDate ? monthsBetween(newestDate, asOf) : null;

  if (state === 'ready' && item.maxAgeMonths) {
    if (!newestDate) state = 'undated';
    else if (addMonths(newestDate, item.maxAgeMonths) < asOf) state = 'too_old';
  }
  if (state === 'ready' && item.cutoff) {
    const reached = used.map(entry => endOf(entry.file)).filter((value): value is string => Boolean(value));
    const newestEnd = reached.length ? reached.reduce((latest, value) => (value > latest ? value : latest)) : null;
    if (!newestEnd) state = 'undated';
    else if (newestEnd < cutoffDateFor(item.cutoff, asOf)) state = 'too_old';
  }
  return { state, files: used.map(entry => ({ id: entry.file.id, source: source.get(entry.file.id) ?? 'matched', unit: entry.unit })), units, newestDate, ageMonths, outside };
}

/** The state of a line that asks for several subjects: ready only when every one is; missing only when none has anything. */
function combine(states: ItemState[]): ItemState {
  if (states.every(state => state === 'ready')) return 'ready';
  if (states.every(state => state === 'missing')) return 'missing';
  if (!states.includes('missing')) {
    if (states.includes('too_old')) return 'too_old';
    if (states.includes('undated')) return 'undated';
  }
  return 'partial';
}

/* ── The checklist ──────────────────────────────────────────────────────────────────────────────────────────────────── */

const notApplicable = (item: ChecklistItem, because: NotApplicableBecause, choice: ItemChoice | undefined, lastAsked: string | null, askAgainFrom: string | null = null): ItemResult => ({
  code: item.code,
  state: 'not_applicable',
  applicable: false,
  optional: item.optional,
  notApplicableBecause: because,
  decision: choice?.decision ?? null,
  files: [],
  subjects: null,
  units: null,
  newestDate: null,
  ageMonths: null,
  maxAgeMonths: item.maxAgeMonths,
  cutoffDate: null,
  outside: 0,
  lastAsked,
  askAgainFrom,
});

/** A line asked once every `months` months is switched on again one month before that time has passed, so an inspection a few days early does not miss it. */
export const askAgainFrom = (lastAsked: string, months: number): string => addMonths(lastAsked, months - 1);

/**
 * Whether a line is on without anybody switching it: off when it does not apply to the client (its condition), when it is only asked when switched on, or when it is
 * asked once every so many months and the client's last inspection asked for it more recently than that. `null` = on.
 */
export function automaticallyOff(item: ChecklistItem, input: Pick<MatchInput, 'asOf' | 'clientValues' | 'lastAsked'>): { because: NotApplicableBecause; askAgainFrom: string | null } | null {
  if (item.condition && !evaluate(item.condition, input.clientValues)) return { because: 'condition', askAgainFrom: null };
  if (item.ask === 'manual') return { because: 'manual', askAgainFrom: null };
  const last = input.lastAsked.get(item.code);
  if (item.ask === 'months' && item.askEveryMonths && last) {
    const again = askAgainFrom(last, item.askEveryMonths);
    if (input.asOf < again) return { because: 'interval', askAgainFrom: again };
  }
  return null;
}

export function evaluateItem(item: ChecklistItem, input: MatchInput): ItemResult {
  const choice = input.choices.get(item.code);
  const lastAsked = input.lastAsked.get(item.code) ?? null;
  if (choice?.decision === 'not_applicable') return notApplicable(item, 'decision', choice, lastAsked);
  // Switched on by hand (or ticked as done): the line counts, whatever its condition or rule says.
  const switchedOn = choice?.decision === 'asked' || choice?.decision === 'done';
  if (!switchedOn) {
    const off = automaticallyOff(item, input);
    if (off) return notApplicable(item, off.because, choice, lastAsked, off.askAgainFrom);
  }

  const base = { code: item.code, applicable: true, optional: item.optional, notApplicableBecause: null, decision: choice?.decision ?? null, maxAgeMonths: item.maxAgeMonths, cutoffDate: item.cutoff ? cutoffDateFor(item.cutoff, input.asOf) : null, lastAsked, askAgainFrom: null };
  const byHand = { ...base, state: (choice?.decision === 'done' ? 'done' : 'manual') as ItemState, files: [], subjects: null, units: null, newestDate: null, ageMonths: null, outside: 0 };
  if (!item.docTypes.length) return byHand;

  const subjects = item.scope === 'sample' ? input.sample : item.scope === 'parents' ? input.parents : null;
  // Nobody to ask it for (no leavers, no company above the client): off — unless somebody switched it on, then it is ticked by hand.
  if (subjects && subjects.length === 0) return switchedOn ? byHand : notApplicable(item, 'no_subjects', choice, lastAsked);

  let result: Omit<ItemResult, 'code' | 'applicable' | 'optional' | 'notApplicableBecause' | 'decision' | 'maxAgeMonths' | 'cutoffDate'>;
  if (subjects) {
    const perSubject: SubjectResult[] = subjects.map(subject => ({ id: subject.id, name: subject.name, ...evaluateSubject(item, subject.files, choice, input.asOf, input.added, false) }));
    const dates = perSubject.map(entry => entry.newestDate).filter((value): value is string => Boolean(value));
    const newestDate = dates.length ? dates.reduce((latest, value) => (value > latest ? value : latest)) : null;
    result = {
      state: combine(perSubject.map(entry => entry.state)),
      files: perSubject.flatMap(entry => entry.files),
      subjects: perSubject,
      units: null,
      newestDate,
      ageMonths: newestDate ? monthsBetween(newestDate, input.asOf) : null,
      outside: perSubject.reduce((sum, entry) => sum + entry.outside, 0),
    };
  } else {
    const found = evaluateSubject(item, input.files, choice, input.asOf, input.added, true);
    result = { ...found, subjects: null };
  }
  // "Done" is the office's word that the line is dealt with, for what the documents do not show.
  if (choice?.decision === 'done' && result.state !== 'ready') result.state = 'done';
  return { ...base, ...result };
}

/** Nothing to be ready for: no lines. */
export const emptySummary = (): Summary => ({ total: 0, ready: 0, partial: 0, missing: 0, tooOld: 0, undated: 0, manual: 0, notApplicable: 0, optionalOpen: 0, percent: 100 });

export function summarize(results: ReadonlyArray<Pick<ItemResult, 'state' | 'applicable' | 'optional'>>): Summary {
  const summary = emptySummary();
  for (const result of results) {
    if (!result.applicable) {
      summary.notApplicable += 1;
      continue;
    }
    const isReady = result.state === 'ready' || result.state === 'done';
    if (result.optional) {
      if (!isReady) summary.optionalOpen += 1;
      continue;
    }
    summary.total += 1;
    if (isReady) summary.ready += 1;
    else if (result.state === 'partial') summary.partial += 1;
    else if (result.state === 'missing') summary.missing += 1;
    else if (result.state === 'too_old') summary.tooOld += 1;
    else if (result.state === 'undated') summary.undated += 1;
    else if (result.state === 'manual') summary.manual += 1;
  }
  summary.percent = summary.total ? Math.round((summary.ready * 100) / summary.total) : 100;
  return summary;
}

/** The whole checklist for one client on one day. */
export function evaluateChecklist(input: MatchInput): { items: ItemResult[]; summary: Summary } {
  const results = input.items.map(item => evaluateItem(item, input));
  return { items: results, summary: summarize(results) };
}
