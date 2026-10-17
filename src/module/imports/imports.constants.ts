import type { SettingDefinitions } from '../../lib/settings/settings.service.js';
import type { AiFeature } from '../../lib/ai/ai.types.js';

export const IMPORTS_NAMESPACE = 'imports';
/** The permission area of the import screens (and of the files an import is reading). */
export const IMPORT_AREA = 'imports';
/** The purpose of a file that was uploaded to an import and is waiting to be read, reviewed and filed. */
export const IMPORT_FILE_PURPOSE = 'import_source';

/** `spreadsheet` · `documents` (a batch of files) · `inbox` (a message to the AI inbox of the dashboard, with or without files). */
export const JOB_KINDS = ['spreadsheet', 'documents', 'inbox'] as const;
export type JobKind = (typeof JOB_KINDS)[number];
/** The jobs whose files are read one by one by the AI queue (and accepted one by one). */
export const FILE_JOB_KINDS: readonly string[] = ['documents', 'inbox'];
/** How the activity log names a job: a message to the inbox is told about in its own words ("sent a message to the AI inbox"). */
export const auditTypeOf = (kind: string): string => (kind === 'inbox' ? 'inbox' : 'import');

/** `draft` (being set up) · `processing` (the background is working) · `ready` (waiting for a person) · `paused` · `done` · `cancelled`. */
export const JOB_STATUSES = ['draft', 'processing', 'ready', 'paused', 'done', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** What the background is doing while a job is `processing` (`understanding`: the AI reads the message of an inbox, before its files). */
export const JOB_ACTIVITIES = ['understanding', 'reading', 'checking', 'committing', 'accepting'] as const;
export type JobActivity = (typeof JOB_ACTIVITIES)[number];

/** `file` · `row` (of a spreadsheet) · `action` (something the message of an inbox asks for). */
export const ITEM_KINDS = ['file', 'row', 'action'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/**
 * What an action of the inbox makes or changes when it is accepted: a task, an appointment, a worker (a new one, or new details of one who works there), a worker who leaves,
 * a client (a new one, or new details).
 */
export const ACTION_TARGETS = ['task', 'event', 'employee', 'employee_stop', 'client'] as const;
export type ActionTarget = (typeof ACTION_TARGETS)[number];

/** The longest message the inbox takes, and the most actions one message becomes. */
export const MAX_INSTRUCTION_LENGTH = 4000;
export const MAX_INBOX_ACTIONS = 10;

/**
 * `pending` → `processing` → `review` (a file that was read, waiting for a person) or `ready` / `invalid` (a checked spreadsheet row) →
 * `accepted` · `rejected` · `skipped` · `error`.
 */
export const ITEM_STATUSES = ['pending', 'processing', 'review', 'ready', 'invalid', 'accepted', 'rejected', 'skipped', 'error'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

/** Items that still need the background (and so keep a job `processing`). */
export const WORKING_STATUSES: readonly ItemStatus[] = ['pending', 'processing'];
/** Items a person can still accept. */
export const ACCEPTABLE_STATUSES: readonly ItemStatus[] = ['review', 'ready', 'invalid', 'error'];

export const SHEET_TARGETS = ['client', 'employee', 'hours'] as const;
export type SheetTarget = (typeof SHEET_TARGETS)[number];

export const DUPLICATE_POLICIES = ['skip', 'fill', 'overwrite'] as const;
export type DuplicatePolicy = (typeof DUPLICATE_POLICIES)[number];

/** The queues of the background (see QueueService). */
export const QUEUE_FILE = 'import-file';
export const QUEUE_SHEET = 'import-sheet';
export const QUEUE_ACCEPT = 'import-accept';
export const QUEUE_INBOX = 'import-inbox';

/**
 * Settings → Import. `duplicates` says what a spreadsheet row does when the record exists already: `skip` leaves it alone, `fill` only fills the
 * fields that are empty, `overwrite` replaces what is there. A person can choose differently for one import.
 */
export const IMPORT_DEFINITIONS = {
  maxFilesPerImport: { type: 'int', default: 2000, min: 10, max: 10_000, group: 'limits' },
  maxZipMegabytes: { type: 'int', default: 200, min: 10, max: 1000, group: 'limits' },
  skipKnownFiles: { type: 'bool', default: true, group: 'files' },
  duplicates: { type: 'enum', default: 'fill', options: DUPLICATE_POLICIES, group: 'spreadsheets' },
} satisfies SettingDefinitions;

/** The most a spreadsheet may hold that is worth reading, and how much of it the screens show. */
export const MAX_SHEET_ROWS = 20_000;
export const MAX_SHEET_COLUMNS = 80;
export const SHEET_PREVIEW_ROWS = 8;
/** Files that go through one upload request; the browser sends bigger imports in several. */
export const MAX_FILES_PER_REQUEST = 25;
export const MAX_ZIP_ENTRIES = 5_000;
/** One file inside a ZIP, and the sum of a ZIP's files, in megabytes (a bomb of tiny compressed files is refused). */
export const MAX_ZIP_ENTRY_MEGABYTES = 60;

/* ── Document types ───────────────────────────────────────────────────────────────────────────────────────────────── */

/** The codes of the document types (Settings → Documents) the import knows what to do with; the office may add more (they are only filed). */
export const DOC_TYPES = {
  idDocument: 'id_document',
  residencePermit: 'residence_permit',
  kvkExtract: 'kvk_extract',
  contract: 'contract',
  staffingInvoice: 'staffing_invoice',
  invoice: 'invoice',
  timesheet: 'timesheet',
  payslip: 'payslip',
  letter: 'letter',
  taxReturn: 'tax_return',
  inspection: 'inspection',
  gAccount: 'g_account',
  form: 'form',
  paymentBehaviour: 'payment_behaviour',
  trialBalance: 'trial_balance',
  annualAccounts: 'annual_accounts',
  other: 'other',
} as const;

/** The types the AI reads the values of (the others are only classified and filed). */
export const READABLE_TYPES: readonly string[] = [DOC_TYPES.idDocument, DOC_TYPES.residencePermit, DOC_TYPES.kvkExtract, DOC_TYPES.contract, DOC_TYPES.staffingInvoice, DOC_TYPES.timesheet, DOC_TYPES.letter];

/** Which switch of Settings → AI belongs to reading a type. */
export const FEATURE_OF_TYPE: Readonly<Record<string, AiFeature>> = {
  [DOC_TYPES.idDocument]: 'id_document',
  [DOC_TYPES.residencePermit]: 'id_document',
  [DOC_TYPES.kvkExtract]: 'kvk_extract',
  [DOC_TYPES.contract]: 'contract',
  [DOC_TYPES.staffingInvoice]: 'staffing_invoice',
  [DOC_TYPES.timesheet]: 'timesheet',
  [DOC_TYPES.letter]: 'letter',
};

/** What an item holds, per record: `{ person: { first_name: 'Jan' }, client: { … } }`, keyed by the field keys of the form of that record. */
export type ItemSections = Record<string, Record<string, unknown>>;
/** How sure the reading was (0–1), in the same shape as the values. */
export type ItemConfidence = Record<string, Record<string, number>>;

/** A hint on an item for the review list: `code` is a translation key of the `imports` page, `params` fill it in, `field` is `section.key` when it is about one value. */
export interface ItemWarning {
  code: string;
  params?: Record<string, string | number>;
  field?: string;
  /** `attention`: a person should look before this is accepted (accepting everything at once leaves it out); `info`: just so they know. */
  level: 'info' | 'attention';
}

/** The record an accepted item made or changed. */
export interface ItemResult {
  type: 'client' | 'person' | 'employee' | 'contract' | 'invoice' | 'hours' | 'file' | 'task' | 'event';
  id: string;
  /** What happened: `created` · `updated` · `filed` · `linked` · `stopped`. */
  action: string;
  label?: string;
  /** The day an appointment is on (the calendar opens on it). */
  date?: string;
}

/** What the AI made of the message of an inbox (kept in the job's options as `message`). */
export interface InboxMessage {
  /** `pending` (not read yet) · `read` · `empty` (it asks for nothing the system can do) · `failed` (the AI could not read it: `reason`). */
  status: 'pending' | 'read' | 'empty' | 'failed';
  reason?: string;
  /** One line on what the person asks, in their own language. */
  summary?: string;
}
