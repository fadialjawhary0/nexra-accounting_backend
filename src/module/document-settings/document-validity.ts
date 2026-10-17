import { DAY_PATTERN, addMonths, daysBetween } from '../../common/dates.js';

/** `valid`, `expiring` (inside the warning period), `expired`, or `none` (it has no end date or the date is not known). */
export type ValidityStatus = 'none' | 'valid' | 'expiring' | 'expired';

/** The part of a document type that decides how long a document is good for. */
export interface ValidityRule {
  validity: string;
  validityMonths: number | null;
  validityField: string | null;
  warnDays: number | null;
}

export interface Validity {
  /** The last day the document is good for (`YYYY-MM-DD`), when known. */
  until: string | null;
  status: ValidityStatus;
  /** Days from today to `until` (negative once it has passed). */
  daysLeft: number | null;
  /** Where the date comes from: typed on the file, worked out from the date on the document, or taken from the worker's record. */
  source: 'file' | 'age' | 'field' | null;
}

const NONE: Validity = { until: null, status: 'none', daysLeft: null, source: null };

/** The end of validity of one document: a rule, what is known about the file, and — for `field` rules — the value in the worker's record. */
export function validityOf(
  rule: ValidityRule | null | undefined,
  file: { docDate: string | null; validUntil: string | null },
  fieldValue: string | null,
  today: string,
  defaultWarnDays: number,
): Validity {
  if (!rule) return NONE;
  let until: string | null = null;
  let source: Validity['source'] = null;
  if (rule.validity === 'age' && file.docDate && rule.validityMonths && rule.validityMonths > 0) {
    until = addMonths(file.docDate, rule.validityMonths);
    source = 'age';
  } else if (rule.validity === 'date' && file.validUntil) {
    until = file.validUntil;
    source = 'file';
  } else if (rule.validity === 'field' && fieldValue && DAY_PATTERN.test(fieldValue)) {
    until = fieldValue;
    source = 'field';
  }
  if (!until) return NONE;
  const daysLeft = daysBetween(today, until);
  const warn = rule.warnDays ?? defaultWarnDays;
  return { until, daysLeft, source, status: daysLeft < 0 ? 'expired' : daysLeft <= warn ? 'expiring' : 'valid' };
}
