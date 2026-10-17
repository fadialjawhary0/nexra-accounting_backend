import type { SettingDefinitions } from '../../lib/settings/settings.service.js';

/*
 * Inspections ("Controle"): NEN 4400-1 inspections by a certifying body, audits and requests of the tax authority or the labour inspectorate. What an inspector asks for is a
 * checklist (versioned); what is ready for it is worked out from the client's documents. Permission area: `inspections`.
 */

export const INSPECTION_ENTITY = 'inspection';
export const CHECKLIST_ENTITY = 'checklist_template';
export const INSPECTIONS_AREA = 'inspections';
export const INSPECTIONS_NAMESPACE = 'inspections';
/** The running number of an inspection (Settings → Numbering). */
export const INSPECTION_NUMBER_KEY = 'inspection';

/** Codes of the `inspection_status` list. */
export const INSPECTION_STATUSES = ['planned', 'in_progress', 'awaiting_result', 'closed', 'cancelled'] as const;
export type InspectionStatus = (typeof INSPECTION_STATUSES)[number];
/** Still going on: a date to prepare for, an answer to give, a result to wait for. */
export const OPEN_STATUSES: readonly string[] = ['planned', 'in_progress', 'awaiting_result'];
/** Over: nothing more to prepare. A closed inspection keeps the checklist as it stood (the snapshot). */
export const TERMINAL_STATUSES: readonly string[] = ['closed', 'cancelled'];

/**
 * What a person can decide about a line of the checklist: switched off (`not_applicable` — not asked this time), switched on by hand (`asked` — also when the line's
 * condition or rule would leave it off), or ticked (`done` — shown in another way; a ticked line is on).
 */
export const ITEM_DECISIONS = ['not_applicable', 'asked', 'done'] as const;
export type ItemDecision = (typeof ITEM_DECISIONS)[number];

/** Codes of the `inspection_handover_method` list. */
export const HANDOVER_METHODS = ['zip', 'pdf', 'checklist', 'on_site', 'email', 'other'] as const;
export type HandoverMethod = (typeof HANDOVER_METHODS)[number];

/** The reminders (the rules are seeded; the office changes them in Settings → Notifications and reminders). */
export const INSPECTION_UPCOMING_TRIGGER = 'inspection_upcoming';
export const INSPECTION_RESPONSE_TRIGGER = 'inspection_response_due';
export const INSPECTION_FOLLOW_UP_TRIGGER = 'inspection_follow_up';
export const INSPECTION_REMINDER_DEFAULTS = {
  [INSPECTION_UPCOMING_TRIGGER]: { offsets: [30, 14, 7, 1], dayType: 'calendar', channels: ['in_app'], active: true },
  [INSPECTION_RESPONSE_TRIGGER]: { offsets: [3, 1, 0], dayType: 'working', channels: ['in_app'], active: true },
  [INSPECTION_FOLLOW_UP_TRIGGER]: { offsets: [3, 0], dayType: 'calendar', channels: ['in_app'], active: true },
} as const;
export const INSPECTION_REMINDER_NAMES = {
  [INSPECTION_UPCOMING_TRIGGER]: 'Controle komt eraan',
  [INSPECTION_RESPONSE_TRIGGER]: 'Controle: antwoord is verschuldigd',
  [INSPECTION_FOLLOW_UP_TRIGGER]: 'Controle: opvolging is verschuldigd',
} as const;

/** The AI feature that reads an inspector's request. */
export const INSPECTION_REQUEST_FEATURE = 'inspection_request';

/** The longest request text taken into an inspection or read by the AI. */
export const MAX_REQUEST_CHARACTERS = 20_000;
/** The most lines an inspection can have (the checklist plus the lines added by hand). */
export const MAX_CUSTOM_ITEMS = 100;
export const MAX_CHECKLIST_ITEMS = 200;

/**
 * Settings → Inspections. Every number has a sensible default (docs/11: NEN 4400-1 inspections come about every six months; the sample is the three most recent
 * leavers) and can be changed by the office.
 */
export const INSPECTIONS_DEFINITIONS = {
  /** How long after an inspection of a recurring kind the next one is planned (months); 0 = never plan one automatically. */
  recurrenceMonths: { type: 'int', default: 6, min: 0, max: 36, group: 'schedule' },
  /** Closing an inspection of a recurring kind plans the next one. */
  planNextOnClose: { type: 'bool', default: true, group: 'schedule' },
  /** A new inspection gets its dated folder (with the folders of the checklist's parts) in the client's documents. */
  createFolder: { type: 'bool', default: true, group: 'folders' },
  /** How many of the most recent leavers the inspector samples. */
  sampleSize: { type: 'int', default: 3, min: 1, max: 20, group: 'sample' },
  /** Joiners and leavers are listed from the previous inspection; when there was none, this many months back. */
  sampleLookbackMonths: { type: 'int', default: 12, min: 1, max: 60, group: 'sample' },
  /** Warn before a bundle is made when a document seems to hold a citizen service number (BSN). */
  bsnCheck: { type: 'bool', default: true, group: 'bundle' },
  /** A bundle bigger than this is not made (the files would not go through an e-mail anyway). */
  maxBundleMegabytes: { type: 'int', default: 150, min: 5, max: 500, group: 'bundle' },
} satisfies SettingDefinitions;
