import type { SettingDefinitions } from '../../lib/settings/settings.service.js';

/*
 * Taxes: the VAT tracker (one row per client per quarter with the steps of the office's own sheet), the yearly returns (income tax of an owner or partner, corporate income
 * tax of a company) with their extensions, and the employer registrations. Permission area: `taxes`.
 */

export const TAXES_AREA = 'taxes';
export const TAXES_NAMESPACE = 'taxes';
export const VAT_PERIOD_ENTITY = 'vat_period';
export const VAT_STEP_ENTITY = 'vat_step';
export const TAX_RETURN_ENTITY = 'tax_return';

/** What a VAT period covers (codes of the `vat_frequency` list; `none` = not VAT-liable, nothing to track). */
export const VAT_KINDS = ['quarter', 'month', 'year'] as const;
export type VatKind = (typeof VAT_KINDS)[number];

/** The yearly returns. */
export const RETURN_KINDS = ['income_tax', 'corporate_tax'] as const;
export type ReturnKind = (typeof RETURN_KINDS)[number];

/** Codes of the `tax_return_status` list. The logic knows these codes; the office can rename them (Settings → Lists). */
export const RETURN_STATUSES = ['not_started', 'collecting', 'in_progress', 'filed', 'assessment_received', 'not_required'] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];
/** Still to be filed: they have a deadline. */
export const OPEN_RETURN_STATUSES: readonly string[] = ['not_started', 'collecting', 'in_progress'];
/** Filed — the day of filing is kept. */
export const FILED_RETURN_STATUSES: readonly string[] = ['filed', 'assessment_received'];

/** Codes of the `tax_extension_status` list. */
export const EXTENSION_STATUSES = ['requested', 'granted', 'refused'] as const;
export type ExtensionStatus = (typeof EXTENSION_STATUSES)[number];

/** Codes of the `employer_registration_status` list (worked out, never typed in). */
export const EMPLOYER_STATES = ['registered', 'submitted', 'to_register', 'not_needed'] as const;
export type EmployerState = (typeof EMPLOYER_STATES)[number];

/** The official forms that belong here (codes in the library of official forms). */
export const EMPLOYER_FORM_CODE = 'melding_loonheffingen';
export const EXTENSION_FORM_CODE = 'aanvraag_uitstel';

/** The roles of a person at a client that make them the one an income-tax return is for (codes of the `person_role` list). */
export const INCOME_TAX_ROLES: readonly string[] = ['owner', 'partner'];

/** The keys of the client form (Settings → Forms) the tax screens read: the system fields people fill in once, reused here. */
export const CLIENT_FIELDS = {
  vatFrequency: 'vat_frequency',
  incomeTax: 'income_tax',
  corporateTax: 'corporate_tax',
  payrollTaxNumber: 'payroll_tax_number',
  payrollPeriod: 'payroll_period',
} as const;

/** The most rows a person can switch on, tick or off in one go. */
export const MAX_BULK_ROWS = 500;

/** The reminders (the rules are seeded; the office changes them in Settings → Notifications and reminders). */
export const VAT_DEADLINE_TRIGGER = 'vat_deadline';
export const RETURN_DEADLINE_TRIGGER = 'tax_return_deadline';
export const TAX_REMINDER_DEFAULTS = {
  [VAT_DEADLINE_TRIGGER]: { offsets: [14, 7, 3, 0], dayType: 'calendar', channels: ['in_app'], active: true },
  [RETURN_DEADLINE_TRIGGER]: { offsets: [30, 14, 7, 0], dayType: 'calendar', channels: ['in_app'], active: true },
} as const;
export const TAX_REMINDER_NAMES = {
  [VAT_DEADLINE_TRIGGER]: 'Btw-aangifte: deadline',
  [RETURN_DEADLINE_TRIGGER]: 'Aangifte inkomstenbelasting / vennootschapsbelasting: deadline',
} as const;

/**
 * Settings → Taxes. The deadlines are the law's (the VAT return at the end of the month after the quarter; income tax on 1 May; corporate tax five months after the financial
 * year), kept as settings so the office can follow a change of the rules — a deadline that falls on a weekend or a holiday moves to the next working day (the calendar decides).
 */
export const TAXES_DEFINITIONS = {
  /** A VAT return per quarter or month is due at the end of the month this many months after the period. */
  vatDueMonthsAfter: { type: 'int', default: 1, min: 0, max: 12, group: 'vat' },
  /** A VAT return per year is due at the end of the month this many months after the year. */
  vatYearDueMonthsAfter: { type: 'int', default: 3, min: 0, max: 12, group: 'vat' },
  /** Make the rows of the new quarter (month, year) for every active client with a VAT duty, without being asked. */
  createVatAutomatically: { type: 'bool', default: true, group: 'vat' },
  /** The income-tax return of a year is due in this month (1 = January) of the year after … */
  incomeTaxDueMonth: { type: 'int', default: 5, min: 1, max: 12, group: 'incomeTax' },
  /** … on this day of the month. */
  incomeTaxDueDay: { type: 'int', default: 1, min: 1, max: 31, group: 'incomeTax' },
  /** A normal extension of the income-tax return runs this many months beyond the deadline (the date a new request starts with). */
  incomeTaxExtensionMonths: { type: 'int', default: 4, min: 1, max: 24, group: 'incomeTax' },
  /** The corporate-tax return is due this many months after the end of the financial year. */
  corporateTaxDueMonths: { type: 'int', default: 5, min: 1, max: 12, group: 'corporateTax' },
  /** A normal extension of the corporate-tax return runs this many months beyond the deadline. */
  corporateTaxExtensionMonths: { type: 'int', default: 5, min: 1, max: 24, group: 'corporateTax' },
  /** Make the returns of the year that just ended for every active client that has income tax / corporate tax switched on, without being asked. */
  createReturnsAutomatically: { type: 'bool', default: true, group: 'returns' },
} satisfies SettingDefinitions;
