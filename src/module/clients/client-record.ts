import type { Client } from '../../generated/prisma/client.js';

// The helpers every record module shares live in common/record-values.ts; clients and people re-export what their own code reads.
export { columnValues, day, splitValues } from '../../common/record-values.js';
export { PERSON_COLUMNS, PERSON_ENTITY, personName } from '../people/person-record.js';

export const CLIENT_ENTITY = 'client';
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

export const displayLabel = (client: Pick<Client, 'number' | 'name'>): string => `${client.number} – ${client.name}`;

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
