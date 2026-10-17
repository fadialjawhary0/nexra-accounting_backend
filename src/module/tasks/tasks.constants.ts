/** Name of a task in the audit log and in the links of the app. */
export const TASK_ENTITY = 'task';

/** The lookups behind a task's status and priority (Settings → Lists; the program logic knows the codes, so the lists cannot grow). */
export const TASK_STATUS_LIST = 'task_status';
export const TASK_PRIORITY_LIST = 'task_priority';

export const TASK_STATUSES = ['todo', 'in_progress', 'waiting', 'done'] as const;
export const DONE_STATUS = 'done';
/** A task that still has to be done. */
export const OPEN_TASK_STATUSES: readonly string[] = ['todo', 'in_progress', 'waiting'];

/** The priorities from the quietest to the loudest; a sort by priority follows this order, not the alphabet. */
export const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export const PRIORITY_RANK: Record<string, number> = { low: 1, medium: 2, high: 3, urgent: 4 };

export const MAX_TAGS = 8;
export const MAX_SUBTASKS = 40;

/** Reminder rule of tasks that fall due (Settings → Reminders): the person the task is assigned to is told, not the whole office. */
export const TASK_DUE_TRIGGER = 'task_due';
export const TASK_REMINDER_NAME = 'Taak: einddatum';
export const TASK_REMINDER_DEFAULTS = { offsets: [1, 0], dayType: 'calendar', channels: ['in_app'], active: true } as const;

/**
 * What a task can be about: the kind of record (the name the audit log and the links use) → the permission area a person needs to link it.
 * A person can only link what they may open themselves.
 */
export const LINK_AREAS: Record<string, string> = {
  client: 'clients',
  employee: 'employees',
  contract: 'contracts',
  invoice: 'invoices',
  inspection: 'inspections',
  file: 'documents',
};
