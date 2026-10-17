import type { SettingDefinitions } from '../../lib/settings/settings.service.js';

/** The forms of an invoice's details and of a company that is not a client. */
export const INVOICE_ENTITY = 'invoice';
export const COUNTERPARTY_ENTITY = 'counterparty';

export const INVOICES_NAMESPACE = 'invoices';

/** Reminder rule of outgoing invoices that fall due and are not paid yet (Settings → Reminders): one message for a whole due day, to the owner role. */
export const INVOICE_DUE_TRIGGER = 'invoice_due';
export const INVOICE_REMINDER_NAME = 'Factuur: betaaltermijn';
export const INVOICE_REMINDER_DEFAULTS = { offsets: [3, 0], dayType: 'calendar', channels: ['in_app'], active: true } as const;

/** The purpose of an invoice's file: the PDF a company sent (uploaded), or the Word / PDF the system made. */
export const INVOICE_FILE_PURPOSE = 'invoice_document';
/** The sub-folder of a client's folder (a standard folder of the folder template) where invoices are filed. */
export const INVOICE_FOLDER_CODE = 'hours_invoices';

export type InvoiceDirection = 'incoming' | 'outgoing';
export type InvoiceStatus = 'draft' | 'sent' | 'received' | 'checked' | 'paid' | 'cancelled';
export type LineKind = 'hours' | 'markup' | 'other';

export const INVOICE_DIRECTIONS: readonly InvoiceDirection[] = ['incoming', 'outgoing'];
export const LINE_KINDS: readonly LineKind[] = ['hours', 'markup', 'other'];

/** Longest period one invoice covers, and the most hours one line bills (in minutes). */
export const MAX_INVOICE_DAYS = 366;
export const MAX_LINE_MINUTES = 1_000_000;

/** The columns of a company (form field key → column); every other field of the form lives in `data`. */
export const COUNTERPARTY_COLUMNS = { name: 'name', kvk: 'kvk', vat_number: 'vatNumber' } as const;

/**
 * Settings → Invoices. Every number has a sensible default and can be changed by the office. `numberFormat`: `year_dash` → 2026-0001, `year_plain` →
 * 20260001, `plain` → 0001 (one series that never restarts); every client numbers its own outgoing invoices, without gaps.
 */
export const INVOICE_DEFINITIONS = {
  vatPercent: { type: 'int', default: 21, min: 0, max: 100, group: 'defaults' },
  paymentDays: { type: 'int', default: 30, min: 0, max: 365, group: 'defaults' },
  gAccountPercent: { type: 'int', default: 0, min: 0, max: 100, group: 'defaults' },
  numberFormat: { type: 'enum', default: 'year_dash', options: ['year_dash', 'year_plain', 'plain'], group: 'numbering' },
  numberPadding: { type: 'int', default: 4, min: 1, max: 8, group: 'numbering' },
} satisfies SettingDefinitions;
