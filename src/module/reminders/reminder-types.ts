import type { SettingDefinitions } from '../../lib/settings/settings.service.js';

export const REMINDERS_NAMESPACE = 'reminders';

/** When reminders are made: at all, and from which hour of the day (office time). */
export const REMINDERS_DEFINITIONS = {
  enabled: { type: 'bool', default: true, group: 'schedule' },
  runHour: { type: 'int', default: 7, min: 0, max: 23, group: 'schedule' },
} satisfies SettingDefinitions;

/** Something with a date that somebody wants to be reminded of: a contract that ends, a probation that runs out. */
export interface ReminderItem {
  subjectType: string;
  subjectId: string;
  /** The day that is watched (`YYYY-MM-DD`); only items that have not passed yet are handed in. */
  dueOn: string;
  /** The client it concerns: client-specific holidays count for working-day offsets, and its responsible staff member can be a recipient. */
  clientId: string | null;
  /** The people it belongs to (a task's assignee): a rule that tells "the responsible person" tells them instead of the client's responsible staff member. */
  userIds?: string[];
  /** Values for the notification text (`worker`, `client`, `date` …). */
  params: Record<string, string | number>;
  /** The screen that shows the subject. */
  link: string;
}

/** What a feature tells the reminder engine: which dates can be watched and where to find them. */
export interface ReminderProvider {
  /** `contract_end` … */
  trigger: string;
  /** Code of the `notification_type` list the notification gets. */
  type: string;
  /** Key in `NOTIFICATION_TEXTS`. */
  textKey: string;
  /** The permission a person needs to be told about it (they must be able to open what it is about). */
  requires: string;
  names: { nl: string; en: string };
  description: { nl: string; en: string };
  /** What a new rule for this trigger starts with (and what the seed creates). */
  defaults: { offsets: number[]; dayType: 'calendar' | 'working'; channels: Array<'in_app' | 'email'> };
  /** Every item that can still be reminded of. */
  items(today: string): Promise<ReminderItem[]>;
}

export interface Recipients {
  roles: string[];
  users: string[];
  responsible: boolean;
}
