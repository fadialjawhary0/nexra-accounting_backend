/** Name of an appointment in the audit log and in the links of the app. */
export const EVENT_ENTITY = 'calendar_event';

/** What a person can add to the calendar themselves. Everything else on the calendar is worked out from other records (see AgendaFeedService). */
export const STORED_EVENT_TYPES = ['meeting', 'team', 'reminder'] as const;
export type StoredEventType = (typeof STORED_EVENT_TYPES)[number];

/** Every kind of entry the calendar can show (the legend of the page). */
export const EVENT_TYPES = ['deadline', 'inspection', 'contract', 'task', 'meeting', 'team', 'reminder', 'holiday'] as const;

/** The most days one request for the calendar may span, and the longest an appointment may last. */
export const MAX_RANGE_DAYS = 400;
export const MAX_EVENT_DAYS = 62;
export const MAX_GUESTS = 50;
/** A reminder can be set up to four weeks before. */
export const MAX_REMINDER_MINUTES = 40_320;
