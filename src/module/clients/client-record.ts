import { formatDay } from '../../common/dates.js';
import type { Client, Person } from '../../generated/prisma/client.js';

export const CLIENT_ENTITY = 'client';
export const PERSON_ENTITY = 'person';
/** The permission area that guards clients and the people linked to them. */
export const CLIENT_AREA = 'clients';

/**
 * The fields of the client form that live in a real column (the logic sorts, joins and links on them): `field key → column`.
 * Every other field is stored in `Client.data`. The keys are system fields of the seeded form, so they always exist.
 */
export const CLIENT_COLUMNS = {
  number: 'number',
  name: 'name',
  legal_form: 'legalForm',
  kvk: 'kvk',
  vat_number: 'vatNumber',
  responsible_user: 'responsibleUserId',
} as const;

export const PERSON_COLUMNS = {
  first_name: 'firstName',
  last_name: 'lastName',
} as const;

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

/** The record's own columns as form values (`legal_form: 'bv'`). */
export function columnValues<Map extends Record<string, string>>(map: Map, row: Record<string, unknown>): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(map)) {
    const value = row[column];
    if (value !== null && value !== undefined && value !== '') values[key] = value;
  }
  return values;
}

export const displayLabel = (client: Pick<Client, 'number' | 'name'>): string => `${client.number} – ${client.name}`;

/** `Jan van der Berg` from the person's columns and their name prefix ("van der"). */
export function personName(person: Pick<Person, 'firstName' | 'lastName' | 'data'>): string {
  const data = (person.data ?? {}) as Record<string, unknown>;
  const infix = typeof data.infix === 'string' ? data.infix.trim() : '';
  return [person.firstName, infix, person.lastName].filter(Boolean).join(' ');
}

export const day = (value: Date | null): string | null => (value ? formatDay(value) : null);

/** `<number>- <name>` — the folder of a client, with characters a file name cannot hold replaced. */
export function folderNameOf(client: Pick<Client, 'number' | 'name'>): string {
  const name = client.name.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  return `${client.number}- ${name}`.slice(0, 120).trim();
}

/** Digits at the end of a client number ("K-042" → 42); `null` when there are none. Used to suggest the next number. */
export function numberOf(number: string): number | null {
  const match = /(\d{1,9})$/.exec(number);
  return match?.[1] ? Number(match[1]) : null;
}

/** Characters a client number may hold: it becomes part of a folder name. */
export const NUMBER_PATTERN = /^[A-Z0-9][A-Z0-9._ -]{0,19}$/;
