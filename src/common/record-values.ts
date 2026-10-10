import { formatDay } from './dates.js';

/*
 * Small helpers every record module shares (clients, people, workers …): a record keeps the fields the logic reads in real columns and
 * every other field of its form in a JSON `data` column; these split the values of a form into the two and put them back together.
 */

export const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

type Columns<Map extends Record<string, string>> = { [Key in Map[keyof Map]]?: string | null };

/** Cleaned values (by field key) → the table's columns and the rest of the record. A `null` clears a column (or removes a key of `data`). */
export function splitValues<Map extends Record<string, string>>(map: Map, values: Record<string, unknown>): { columns: Columns<Map>; data: Record<string, unknown> } {
  const columns: Record<string, string | null> = {};
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    const column = map[key];
    if (column) columns[column] = typeof value === 'string' ? value : null;
    else data[key] = value;
  }
  return { columns: columns as Columns<Map>, data };
}

/** The record's own columns as form values (`legal_form: 'bv'`). Dates become `YYYY-MM-DD`; empty columns are left out. */
export function columnValues<Map extends Record<string, string>>(map: Map, row: Record<string, unknown>): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(map)) {
    const raw = row[column];
    const value = raw instanceof Date ? formatDay(raw) : raw;
    if (value !== null && value !== undefined && value !== '') values[key] = value;
  }
  return values;
}

/** A date column as `YYYY-MM-DD` (or `null`). */
export const day = (value: Date | null | undefined): string | null => (value ? formatDay(value) : null);
