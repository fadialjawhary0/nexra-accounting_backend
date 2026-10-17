import type { SettingDefinitions } from '../../lib/settings/settings.service.js';

/** The form of the details of one day of work (where, for which hirer, a note). */
export const HOUR_ENTRY_ENTITY = 'hour_entry';
/** The permission area that guards hours. */
export const HOURS_AREA = 'hours';
/** The permission area that guards what is paid: salary statements, and every amount that comes with the hours. */
export const STATEMENTS_AREA = 'salary_statements';

export const HOURS_NAMESPACE = 'hours';

export const ENTRY_SOURCES = ['manual', 'copy', 'import', 'ai'] as const;
export type EntrySource = (typeof ENTRY_SOURCES)[number];

/** Form fields the logic reads out of an entry's `data`. */
export const ENTRY_FIELD = { workplace: 'workplace', hirer: 'hirer', assignment: 'assignment', note: 'note' } as const;

/**
 * Settings → Hours & pay. The numbers behind the advice and the statements; every one has a sensible default and can be changed by the office.
 * (Whole numbers only: the holiday allowance is a whole percentage, and the vacation hours built up are a percentage of the hours worked —
 * 10 means 0,1 hour per hour.)
 */
export const HOURS_DEFINITIONS = {
  /** Hours on one day above this are flagged (never refused). */
  maxHoursPerDay: { type: 'int', default: 12, min: 4, max: 24, group: 'entry' },
  warnOutsideEmployment: { type: 'bool', default: true, group: 'entry' },
  warnOutsideContract: { type: 'bool', default: true, group: 'entry' },
  /** Shown under the wages on a statement; a contract with its own percentage wins. */
  holidayAllowancePercent: { type: 'int', default: 8, min: 0, max: 30, group: 'pay' },
  /** Vacation hours built up per 100 hours worked; a contract with its own number wins. 0 = none are shown. */
  vacationAccrualPercent: { type: 'int', default: 0, min: 0, max: 100, group: 'pay' },
} satisfies SettingDefinitions;

/** The most one entry can hold: a day. */
export const MAX_ENTRY_MINUTES = 1440;
