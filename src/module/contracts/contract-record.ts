import { addDays, addMonths, daysBetween, parseDay } from '../../common/dates.js';

export const CONTRACT_ENTITY = 'contract';
/** The permission area that guards contracts and the letters made for them. */
export const CONTRACT_AREA = 'contracts';

/**
 * The fields of the contract form that live in a real column (the logic sorts, joins and links on them): `field key → column`. Every other field —
 * including the wage — is stored in `Contract.data`. The client and the worker are not form fields: they are chosen first and then fixed.
 */
export const CONTRACT_COLUMNS = {
  type: 'type',
  start_date: 'startDate',
  end_date: 'endDate',
} as const;

/** The columns that hold a day (read as `YYYY-MM-DD` text in lists). */
export const CONTRACT_DATE_COLUMNS: ReadonlySet<string> = new Set(['startDate', 'endDate']);

/** Form fields the logic reads out of `data`. */
export const FIELD = {
  /** The length typed before the dates: with the start date it gives the end date (and a hand-picked end date gives it back when it is whole months). */
  durationMonths: 'duration_months',
  probationMonths: 'probation_months',
  hourlyRate: 'hourly_rate',
  monthlySalary: 'monthly_salary',
  function: 'function',
  signingDate: 'signing_date',
  signingPlace: 'signing_place',
} as const;

export const CONTRACT_TYPES = ['on_call', 'fixed_term', 'permanent', 'internship', 'freelance', 'services'] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];

/**
 * What the program knows about each contract type (the names come from the `contract_type` list). `employment` — an employment contract (the notice,
 * probation and chain rules apply); `end` — whether the end date is `required`, `optional` or `none`.
 */
export const TYPE_RULES: Record<ContractType, { employment: boolean; end: 'required' | 'optional' | 'none' }> = {
  on_call: { employment: true, end: 'optional' },
  fixed_term: { employment: true, end: 'required' },
  permanent: { employment: true, end: 'none' },
  internship: { employment: true, end: 'required' },
  freelance: { employment: false, end: 'optional' },
  services: { employment: false, end: 'optional' },
};

export const isContractType = (value: unknown): value is ContractType => typeof value === 'string' && (CONTRACT_TYPES as readonly string[]).includes(value);

/** The statuses of a contract (the names come from the `contract_status` list). */
export const CONTRACT_STATUSES = ['draft', 'sent', 'active', 'ended', 'terminated', 'cancelled'] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

/** A contract that is being prepared or in force counts as active; the others are history. */
export const OPEN_STATUSES: readonly ContractStatus[] = ['draft', 'sent', 'active'];

/** Where the screens of a contract are. */
export const contractLink = (id: string): string => `/contracts/${id}`;

/* ── Dates ─────────────────────────────────────────────────────────────────────────────────────────────────────────── */

export { addMonths };

/**
 * Whole months of a contract from its first to its last day, as a person counts them: 1 November to 30 April is 6 months, 1 November to
 * 31 October 12. A part month counts down (15 November to 10 January is 1 month). `null` without an end date.
 */
export function monthsBetween(start: string, end: string | null | undefined): number | null {
  if (!end || end < start) return null;
  const after = addDays(end, 1);
  let months = (parseDay(after).getUTCFullYear() - parseDay(start).getUTCFullYear()) * 12 + (parseDay(after).getUTCMonth() - parseDay(start).getUTCMonth());
  if (addMonths(start, months) > after) months -= 1;
  return Math.max(months, 0);
}

/** The last day of a contract of `months` months: the day before the same date that many months later (1 January + 9 months = 30 September). */
export const endAfterMonths = (start: string, months: number): string => addDays(addMonths(start, months), -1);

/** The length in months when the end date is exactly that many months after the start (as `endAfterMonths` counts); `null` for a part month. */
export function exactMonths(start: string, end: string | null | undefined): number | null {
  const months = monthsBetween(start, end);
  return months && endAfterMonths(start, months) === end ? months : null;
}

/** Calendar days from the first to the last day, both counted. */
export const daysInContract = (start: string, end: string): number => daysBetween(start, end) + 1;

/** The last day of a probation period that starts with the contract: 1 November + 1 month = 30 November. */
export const probationEnd = (start: string, months: number): string => addDays(addMonths(start, months), -1);

/** What a contract says about its length: "8 maanden", "1 maand", "12 maanden" — always in months, as a contract counts. */
export function durationWords(months: number | null, locale: 'nl' | 'en'): string {
  if (months === null) return '';
  return locale === 'nl' ? `${months} ${months === 1 ? 'maand' : 'maanden'}` : `${months} ${months === 1 ? 'month' : 'months'}`;
}
