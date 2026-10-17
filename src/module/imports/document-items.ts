import type { ItemSections } from './imports.constants.js';

/*
 * The shapes of the parts of an import item that are not an ordinary form: they are written by the reading of a file (document-evaluator.service.ts)
 * and read when the item is accepted (document-accept.service.ts). Everything is a plain value, so it can be stored and edited as JSON.
 */

/** `data.file` — what the document itself says, and what accepting it should do besides filing it. */
export interface FileData {
  /** The date on the document (`YYYY-MM-DD`): the extract date, the date of a letter, the first day of an inspection. */
  doc_date?: string;
  /** Also make the person a worker of the client (ID documents, contracts). */
  create_employee?: boolean;
  /** The file sat in a `0-GESTOPT` folder (or a person says so): a client or worker that is made is stopped right away. */
  stopped?: boolean;
  /** KvK extract: the role the person has at the company (code of the `person_role` list). */
  person_role?: string;
  subject?: string;
  sender?: string;
  deadline?: string;
  topic?: string;
  summary?: string;
}

export interface InvoiceLineData {
  worker_name: string | null;
  employee_id: string | null;
  from: string | null;
  to: string | null;
  /** Billed time in whole minutes. */
  minutes: number | null;
  rate: number | null;
  amount: number | null;
  description: string | null;
}

/** `data.invoice` — an invoice of a staffing company. */
export interface InvoiceData {
  number?: string;
  invoice_date?: string;
  due_date?: string;
  period_from?: string;
  period_to?: string;
  vat_percent?: number;
  total_excl_vat?: number;
  total_incl_vat?: number;
  /** The company that sent it. */
  party_name?: string;
  party_kvk?: string;
  party_vat?: string;
  party_iban?: string;
  /** The company when it is known already. */
  counterparty_id?: string;
  lines: InvoiceLineData[];
}

export interface HoursEntryData {
  worker_name: string;
  employee_id: string | null;
  date: string;
  /** Worked time in whole minutes. */
  minutes: number | null;
  start: string | null;
  end: string | null;
  break_minutes: number | null;
  note: string | null;
}

/** `data.hours` — the days of a timesheet. */
export interface HoursData {
  period_from?: string;
  period_to?: string;
  entries: HoursEntryData[];
}

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

export const fileData = (data: ItemSections): FileData => record(data.file) as FileData;
export const invoiceData = (data: ItemSections): InvoiceData => ({ ...(record(data.invoice) as Partial<InvoiceData>), lines: Array.isArray(record(data.invoice).lines) ? (record(data.invoice).lines as InvoiceLineData[]) : [] });
export const hoursData = (data: ItemSections): HoursData => ({ ...(record(data.hours) as Partial<HoursData>), entries: Array.isArray(record(data.hours).entries) ? (record(data.hours).entries as HoursEntryData[]) : [] });

/** The keys of the person form that belong to a document: a newer document replaces what is there. */
export const DOCUMENT_KEYS: ReadonlySet<string> = new Set(['id_type', 'id_number', 'id_expiry', 'permit_type', 'permit_number', 'permit_expiry']);

/** The first day and the last day of a list of days (`YYYY-MM-DD`); `null` when there are none. */
export function spanOf(days: ReadonlyArray<string | null | undefined>): { from: string; to: string } | null {
  const valid = days.filter((day): day is string => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)).sort();
  return valid.length ? { from: valid[0]!, to: valid[valid.length - 1]! } : null;
}
