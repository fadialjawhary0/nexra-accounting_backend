import { Prisma } from '../../generated/prisma/client.js';

export const EMPLOYEE_ENTITY = 'employee';
/** The permission area that guards workers. */
export const EMPLOYEE_AREA = 'employees';

/**
 * The fields of the employee form that live in a real column (the logic sorts, joins and links on them): `field key → column`.
 * Every other field is stored in `Employee.data`. The hourly rate is none of these: it lives in the rate history (`RATE_FIELD`).
 */
export const EMPLOYEE_COLUMNS = {
  client: 'clientId',
  function: 'functionCode',
  start_date: 'startDate',
  end_date: 'endDate',
} as const;

/** The columns that hold a day (read as `YYYY-MM-DD` text in lists). */
export const EMPLOYEE_DATE_COLUMNS: ReadonlySet<string> = new Set(['startDate', 'endDate']);

/** The form field that shows today's hourly rate; saving a different value adds a row to the rate history. */
export const RATE_FIELD = 'hourly_rate';

/** The sub-folder of a client's contracts folder where the folders of workers who left are kept (Ahmad's own `0-GESTOPT`). */
export const STOPPED_FOLDER_NAME = '0-GESTOPT';

/** Prefix of person-form fields in the keys of a worker list (`person.city`): the list shows fields of both forms. */
export const PERSON_PREFIX = 'person.';

/** Today's hourly rate as text (or `NULL`) — the latest rate that starts on or before today, in the office's time zone. */
export const currentRateSql = (alias: string): Prisma.Sql =>
  Prisma.sql`(SELECT r."rate"::text FROM "RateHistory" r WHERE r."employeeId" = ${Prisma.raw(`${alias}."id"`)} AND r."validFrom" <= (now() AT TIME ZONE 'Europe/Amsterdam')::date ORDER BY r."validFrom" DESC LIMIT 1)`;
