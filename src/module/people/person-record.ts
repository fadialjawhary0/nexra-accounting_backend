import type { Person } from '../../generated/prisma/client.js';

export const PERSON_ENTITY = 'person';

/** The fields of the person form that live in a real column (lists and search need them): `field key → column`. The rest is `Person.data`. */
export const PERSON_COLUMNS = {
  first_name: 'firstName',
  last_name: 'lastName',
} as const;

/** `Jan van der Berg` from the person's columns and their name prefix ("van der"). */
export function personName(person: Pick<Person, 'firstName' | 'lastName' | 'data'>): string {
  const data = (person.data ?? {}) as Record<string, unknown>;
  const infix = typeof data.infix === 'string' ? data.infix.trim() : '';
  return [person.firstName, infix, person.lastName].filter(Boolean).join(' ');
}

/** The name pieces as plain text for the search text of a person (the values of the person form). */
export const nameText = (values: Record<string, unknown>): string => [values.first_name, values.infix, values.last_name].filter(value => typeof value === 'string' && value).join(' ');
