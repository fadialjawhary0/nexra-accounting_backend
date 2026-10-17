/*
 * The library of official PDF forms (Melding loonheffingen, Verzoek deblokkering G-rekening …), filling them in from the records, and the log of what was sent.
 * Permission area: `official_forms` (see address-book.constants.ts, where the area key and the address book live).
 */

export const OFFICIAL_FORM_ENTITY = 'official_form';
export const SUBMISSION_ENTITY = 'form_submission';

/** What a form is about, which decides what is asked after the client: the company, one of its people (owner, director, partner) or one of its workers. */
export const SUBJECTS = ['client', 'person', 'worker'] as const;
export type Subject = (typeof SUBJECTS)[number];

/** `none`; a calendar `year`; or a `range` (from – to). */
export const PERIOD_KINDS = ['none', 'year', 'range'] as const;
export type PeriodKind = (typeof PERIOD_KINDS)[number];

/** Codes of the `form_submission_status` list. */
export const SUBMISSION_STATUSES = ['prepared', 'sent', 'done', 'cancelled'] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];
/** A form that has been made but has not been dealt with yet (a second request for the same thing could be refused). */
export const PENDING_STATUSES: readonly string[] = ['prepared', 'sent'];

/** The fields of a PDF that a person can fill in. */
export const FILLABLE_KINDS = ['text', 'checkbox', 'radio', 'dropdown', 'list'] as const;

/** The reminder that says "nothing heard yet" for a form that was sent. */
export const FORM_FOLLOW_UP_TRIGGER = 'form_follow_up';
export const FORM_FOLLOW_UP_DEFAULTS = { offsets: [0], dayType: 'calendar', channels: ['in_app'], active: true } as const;
export const FORM_FOLLOW_UP_NAME = 'Formulier verstuurd, nog geen reactie';

/** The most fields a mapping may have, and the most values a form may be filled with. */
export const MAX_MAPPING_ENTRIES = 600;

/** The document type a filled form is filed as when the form does not say otherwise (it has a standard folder: “Formulieren Belastingdienst”). */
export const DEFAULT_FORM_DOC_TYPE = 'form';

/** Words a file-name pattern of a form may use (the same words as the document types). */
export const FORM_NAME_PATTERN_DEFAULT = '{type}_{number}_{date}';

/** The person roles that can sign for a company, most important first. */
export const SIGNING_ROLES = ['owner', 'director', 'partner'] as const;
