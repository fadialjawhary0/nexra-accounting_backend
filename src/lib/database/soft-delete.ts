import { Prisma } from '../../generated/prisma/client.js';

/*
 * Soft delete (Ahmad's notes, 06-11-2026): a deleted record stays in the database with `deletedAt` set, and the app never shows it again. Instead of a condition in every query,
 * the one Prisma client of the app adds `deletedAt: null` to every read (and bulk change) of these tables — lists, details, pickers, counts, search, reports, reminders.
 *
 * Not covered by the client (and handled where they are written): relations read through `include` / `select` / `_count` of another table, relation filters (`some`,
 * `every`), and raw SQL. A query that names `deletedAt` itself is left as it is — that is how the deletion module reaches deleted rows (`deletedAt: { not: null }`).
 */
export const SOFT_DELETE_MODELS = [
  'Client',
  'Employee',
  'Contract',
  'ContractDocument',
  'Template',
  'Invoice',
  'SalaryStatement',
  'HourEntry',
  'StoredFile',
  'Folder',
  'OfficialForm',
  'FormSubmission',
  'AddressBookEntry',
  'ChecklistTemplate',
  'Inspection',
  'VatPeriod',
  'TaxReturn',
  'Task',
  'CalendarEvent',
  'Counterparty',
  'ImportJob',
  'ImportMapping',
  'User',
  'Role',
  'List',
  'ListItem',
  'Holiday',
  'DocumentType',
  'FolderTemplate',
  'RequiredDocument',
  'ReminderRule',
  'MessageTemplate',
  'SurchargeRule',
  'ExportPreset',
  'VatStep',
] as const;
export type SoftDeleteModel = (typeof SOFT_DELETE_MODELS)[number];

const MODELS: ReadonlySet<string> = new Set(SOFT_DELETE_MODELS);

/** Reads and bulk changes: they never see a deleted row. Changing one row by its id (`update`, `delete`, `upsert`) is not filtered — it is always reached through a read first. */
const FILTERED: ReadonlySet<string> = new Set(['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate', 'groupBy', 'updateMany', 'updateManyAndReturn', 'deleteMany']);

/** Does the condition say something about `deletedAt` itself (at its top or in a top-level AND)? Then it is meant. */
function mentionsDeleted(where: unknown): boolean {
  if (!where || typeof where !== 'object') return false;
  const condition = where as Record<string, unknown>;
  if ('deletedAt' in condition) return true;
  const all = condition.AND;
  return Array.isArray(all) ? all.some(mentionsDeleted) : mentionsDeleted(all);
}

export const softDeleteExtension = Prisma.defineExtension({
  name: 'soft-delete',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        if (!MODELS.has(model) || !FILTERED.has(operation)) return query(args);
        const input = (args ?? {}) as { where?: Record<string, unknown> };
        if (mentionsDeleted(input.where)) return query(args);
        return query({ ...input, where: { ...input.where, deletedAt: null } } as typeof args);
      },
    },
  },
});

/** The condition for rows that are not deleted — for relations read through `include` / `select` / `_count` / `some`, which the client does not filter by itself. */
export const ALIVE = { deletedAt: null } as const;
