/**
 * What a new reminder rule for each document trigger starts with — also what the seed creates. IDs and permits are watched ahead (two months and two
 * weeks); documents with an end date a month and a week; documents that go stale (a KvK extract is good for 3 months) are watched too, but that rule
 * starts switched off — with hundreds of clients it would fill the inbox, and the office decides whether it wants it.
 */
export const DOCUMENT_REMINDER_DEFAULTS = {
  document_expiry: { offsets: [30, 7], dayType: 'calendar', channels: ['in_app', 'email'], active: true },
  document_age: { offsets: [14, 0], dayType: 'calendar', channels: ['in_app'], active: false },
  worker_document_expiry: { offsets: [60, 14], dayType: 'calendar', channels: ['in_app', 'email'], active: true },
} as const satisfies Record<string, { offsets: readonly number[]; dayType: 'calendar' | 'working'; channels: ReadonlyArray<'in_app' | 'email'>; active: boolean }>;

/** The names of the seeded rules (Dutch: the office's language). */
export const DOCUMENT_REMINDER_NAMES: Record<keyof typeof DOCUMENT_REMINDER_DEFAULTS, string> = {
  document_expiry: 'Document verloopt',
  document_age: 'Document is te oud',
  worker_document_expiry: 'ID of vergunning van een werknemer verloopt',
};
