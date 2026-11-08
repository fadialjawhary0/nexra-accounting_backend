import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../lib/database/prisma.service.js';
import type { SoftDeleteModel } from '../../lib/database/soft-delete.js';
import { CLIENT_ENTITY } from '../clients/client-record.js';
import { CONTRACT_ENTITY } from '../contracts/contract-record.js';
import { EMPLOYEE_ENTITY } from '../employees/employee-record.js';
import { OWNER_ROLE_KEY, matrixAllows } from '../roles/permission-catalog.js';

/*
 * What can be deleted, and what goes with it (Ahmad's notes, 06-11-2026). Deleting is soft: the rows stay, marked with one `Deletion`, and the app no longer shows them. A record
 * takes along what only exists because of it — a client its workers, contracts, documents, hours, invoices …; a worker its contracts, hours, statements and folder — so nothing
 * is left that points at something that is gone. Deleting needs the permission `<area>.remove` (only the owner has it until somebody gives it to a role).
 */

export type Row = Record<string, unknown>;

/** Why something cannot be deleted. */
export interface Refusal {
  code: string;
  details?: Record<string, unknown>;
}

export interface DeletionTarget {
  model: SoftDeleteModel;
  ids: string[];
}

export interface DeletionContext {
  prisma: PrismaService;
  user: AuthenticatedUser;
}

export interface DeletionSpec {
  /** Deleting needs `<area>.remove`. */
  area: string;
  model: SoftDeleteModel;
  /** Read with the row, for its label. */
  include?: Record<string, unknown>;
  label(row: Row): string;
  /** Besides `<area>.remove`: what else the person needs for this row (a document of the restricted personal data needs `personal_data.edit`). */
  permits?(row: Row, user: AuthenticatedUser): boolean;
  /** Why this one may not be deleted (a code — also the translation key `errors.api.<code>` — with what its text needs), or null. */
  guard?(row: Row, context: DeletionContext): Promise<Refusal | string | null> | Refusal | string | null;
  /** What goes with it — only rows that are not deleted yet. */
  children?(row: Row, prisma: PrismaService): Promise<DeletionTarget[]>;
  /** The period locks this record holds (an invoice, a statement): released while it is deleted, put back on a restore. */
  locks?: 'invoiceId' | 'statementId';
  /** Runs in the deletion's transaction once the rows are marked (`row` as it was before). */
  afterDelete?(row: Row, tx: Prisma.TransactionClient): Promise<void>;
  /** Runs in the restore's transaction once the rows are back (`row` as it is then). */
  afterRestore?(row: Row, tx: Prisma.TransactionClient): Promise<void>;
}

/** A value that must be unique is freed while its row is deleted: text gets a suffix, a number becomes a random negative one. `when`: only for these rows. */
export interface Tombstone {
  field: string;
  kind: 'text' | 'int';
  when?: (row: Row) => boolean;
}

/**
 * The values freed while deleted, so the same client number, e-mail address or name can be used again. Codes of what the system ships (document types, list items, VAT steps,
 * checklists, holidays …) are not freed on purpose: their row keeps the code, so running the seed again does not bring a deleted one back. A list item always keeps its code: records
 * that hold it keep showing its name, and adding the same choice again brings the row back (`ListsService.addItem`).
 */
export const TOMBSTONES: Partial<Record<SoftDeleteModel, Tombstone[]>> = {
  Client: [{ field: 'number', kind: 'text' }],
  User: [{ field: 'email', kind: 'text' }],
  Role: [{ field: 'key', kind: 'text' }],
  List: [{ field: 'key', kind: 'text', when: row => row.isSystem !== true }],
  DocumentType: [{ field: 'code', kind: 'text', when: row => row.isSystem !== true }],
  FolderTemplate: [{ field: 'code', kind: 'text', when: row => row.isSystem !== true }],
  ImportMapping: [{ field: 'name', kind: 'text' }],
  TaxReturn: [{ field: 'taxYear', kind: 'int' }],
};

/** Records whose unique form values (KvK number, client number …) are kept in `UniqueFieldValue`: released while deleted. */
export const UNIQUE_ENTITIES: Partial<Record<SoftDeleteModel, string>> = { Client: CLIENT_ENTITY, Employee: EMPLOYEE_ENTITY, Contract: CONTRACT_ENTITY };

/* ── Helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────── */

interface Delegate {
  findMany(args: unknown): Promise<Array<{ id: string }>>;
}

export const delegateName = (model: SoftDeleteModel): string => model.charAt(0).toLowerCase() + model.slice(1);
const delegate = (prisma: PrismaService, model: SoftDeleteModel): Delegate => (prisma as unknown as Record<string, Delegate>)[delegateName(model)]!;

/** The ids of the rows (not deleted) that match. */
const ids = async (prisma: PrismaService, model: SoftDeleteModel, where: Record<string, unknown>): Promise<string[]> =>
  (await delegate(prisma, model).findMany({ where, select: { id: true } })).map(row => row.id);

const text = (value: unknown): string => (typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value));
const day = (value: unknown): string => (value instanceof Date ? `${String(value.getUTCDate()).padStart(2, '0')}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${value.getUTCFullYear()}` : '');
const nested = (row: Row, key: string): Row => (row[key] && typeof row[key] === 'object' ? (row[key] as Row) : {});
const personName = (person: Row): string => [person.firstName, person.infix, person.lastName].map(text).filter(Boolean).join(' ');
/** How the office names the two kinds of tax return. */
const RETURN_KINDS: Record<string, string> = { income_tax: 'IB', corporate_tax: 'VPB' };
const clientLabel = (client: Row): string => [text(client.number), text(client.name)].filter(Boolean).join(' – ');

/** The versions of a document: its first one and every file that names it as its root. */
const versionsOf = (row: Row) => {
  const root = text(row.rootId) || text(row.id);
  return { OR: [{ id: root }, { rootId: root }] };
};

/** A document can be deleted by people who may change what it belongs to (a client's papers: clients, personal papers: personal data). */
const mayChangeDocument = (row: Row, user: AuthenticatedUser): boolean => !row.area || matrixAllows(user.matrix, `${text(row.area)}.edit`);

/** The standard folders below a standard folder (by code), at any depth. */
async function templateTree(prisma: PrismaService, code: string): Promise<string[]> {
  const found: string[] = [];
  let frontier = [code];
  while (frontier.length) {
    const rows = await prisma.folderTemplate.findMany({ where: { parentCode: { in: frontier } }, select: { id: true, code: true } });
    const fresh = rows.filter(row => !found.includes(row.id));
    found.push(...fresh.map(row => row.id));
    frontier = fresh.map(row => row.code);
  }
  return found;
}

/** A folder and every folder below it. */
async function folderTree(prisma: PrismaService, roots: string[]): Promise<string[]> {
  const all = [...roots];
  let frontier = roots;
  while (frontier.length) {
    frontier = await ids(prisma, 'Folder', { parentId: { in: frontier } });
    all.push(...frontier.filter(id => !all.includes(id)));
  }
  return all;
}

/** What goes with a set of workers: their contracts (with the contract documents), hours, statements, their folder and what is in it, and the forms about them. */
async function workerParts(prisma: PrismaService, employees: string[]): Promise<DeletionTarget[]> {
  if (!employees.length) return [];
  const contracts = await ids(prisma, 'Contract', { employeeId: { in: employees } });
  const folders = await folderTree(prisma, await ids(prisma, 'Folder', { employeeId: { in: employees } }));
  const contractDocuments = await prisma.contractDocument.findMany({ where: { contractId: { in: contracts } }, select: { id: true, fileId: true } });
  return [
    { model: 'Contract', ids: contracts },
    { model: 'ContractDocument', ids: contractDocuments.map(row => row.id) },
    { model: 'Folder', ids: folders },
    { model: 'StoredFile', ids: await ids(prisma, 'StoredFile', { OR: [{ folderId: { in: folders } }, { id: { in: contractDocuments.map(row => row.fileId) } }] }) },
    { model: 'HourEntry', ids: await ids(prisma, 'HourEntry', { employeeId: { in: employees } }) },
    { model: 'SalaryStatement', ids: await ids(prisma, 'SalaryStatement', { employeeId: { in: employees } }) },
    { model: 'FormSubmission', ids: await ids(prisma, 'FormSubmission', { employeeId: { in: employees } }) },
  ];
}

/* ── What can be deleted ─────────────────────────────────────────────────────────────────────────────────────────── */

export const DELETION_SPECS: Record<string, DeletionSpec> = {
  client: {
    area: 'clients',
    model: 'Client',
    label: row => clientLabel(row),
    children: async (row, prisma) => {
      const clientId = text(row.id);
      const employees = await ids(prisma, 'Employee', { clientId });
      const folders = await folderTree(prisma, await ids(prisma, 'Folder', { clientId }));
      const contracts = await ids(prisma, 'Contract', { clientId });
      const contractDocuments = await prisma.contractDocument.findMany({ where: { contractId: { in: contracts } }, select: { id: true } });
      return [
        { model: 'Employee', ids: employees },
        ...(await workerParts(prisma, employees)),
        { model: 'Contract', ids: contracts },
        { model: 'ContractDocument', ids: contractDocuments.map(document => document.id) },
        { model: 'Folder', ids: folders },
        { model: 'StoredFile', ids: await ids(prisma, 'StoredFile', { OR: [{ clientId }, { folderId: { in: folders } }] }) },
        { model: 'HourEntry', ids: await ids(prisma, 'HourEntry', { clientId }) },
        { model: 'SalaryStatement', ids: await ids(prisma, 'SalaryStatement', { clientId }) },
        { model: 'Invoice', ids: await ids(prisma, 'Invoice', { clientId }) },
        { model: 'FormSubmission', ids: await ids(prisma, 'FormSubmission', { clientId }) },
        { model: 'Inspection', ids: await ids(prisma, 'Inspection', { clientId }) },
        { model: 'VatPeriod', ids: await ids(prisma, 'VatPeriod', { clientId }) },
        { model: 'TaxReturn', ids: await ids(prisma, 'TaxReturn', { clientId }) },
        { model: 'Task', ids: await ids(prisma, 'Task', { clientId }) },
        { model: 'CalendarEvent', ids: await ids(prisma, 'CalendarEvent', { clientId }) },
        { model: 'SurchargeRule', ids: await ids(prisma, 'SurchargeRule', { clientId }) },
        { model: 'Template', ids: await ids(prisma, 'Template', { clientId }) },
      ];
    },
  },
  employee: {
    area: 'employees',
    model: 'Employee',
    include: { person: true, client: { select: { number: true } } },
    label: row => [personName(nested(row, 'person')), text(nested(row, 'client').number) && `(${text(nested(row, 'client').number)})`].filter(Boolean).join(' '),
    children: (row, prisma) => workerParts(prisma, [text(row.id)]),
  },
  contract: {
    area: 'contracts',
    model: 'Contract',
    include: { employee: { include: { person: true } }, client: { select: { number: true } } },
    label: row => [personName(nested(nested(row, 'employee'), 'person')), text(nested(row, 'client').number), day(row.startDate)].filter(Boolean).join(' · '),
    children: async (row, prisma) => {
      const documents = await prisma.contractDocument.findMany({ where: { contractId: text(row.id) }, select: { id: true, fileId: true } });
      return [
        { model: 'ContractDocument', ids: documents.map(document => document.id) },
        { model: 'StoredFile', ids: await ids(prisma, 'StoredFile', { id: { in: documents.map(document => document.fileId) } }) },
      ];
    },
  },
  template: { area: 'templates', model: 'Template', label: row => text(row.name) },
  invoice: {
    area: 'invoices',
    model: 'Invoice',
    include: { client: { select: { number: true } } },
    label: row => [text(row.number) || day(row.createdAt), text(nested(row, 'client').number)].filter(Boolean).join(' · '),
    locks: 'invoiceId',
  },
  counterparty: { area: 'invoices', model: 'Counterparty', label: row => text(row.name) },
  salary_statement: {
    area: 'salary_statements',
    model: 'SalaryStatement',
    include: { employee: { include: { person: true } }, client: { select: { number: true } } },
    label: row => [personName(nested(nested(row, 'employee'), 'person')), text(nested(row, 'client').number), `${day(row.periodFrom)} – ${day(row.periodTo)}`].filter(Boolean).join(' · '),
    locks: 'statementId',
  },
  document: {
    area: 'documents',
    model: 'StoredFile',
    label: row => text(row.name),
    permits: mayChangeDocument,
    // Every version of the document goes.
    children: async (row, prisma) => [{ model: 'StoredFile', ids: await ids(prisma, 'StoredFile', versionsOf(row)) }],
  },
  // One version of a document (a wrong file uploaded as the newest one); the last version left is deleted with the document itself.
  document_version: {
    area: 'documents',
    model: 'StoredFile',
    label: row => `${text(row.name)} (v${text(row.version)})`,
    permits: mayChangeDocument,
    guard: async (row, { prisma }) => ((await prisma.storedFile.count({ where: { AND: [versionsOf(row), { isActive: true, NOT: { id: text(row.id) } }] } })) ? null : 'delete_last_version'),
    // The newest version left takes the place of a current one that is deleted; brought back, it is the current one again.
    afterDelete: async (row, tx) => {
      if (row.isCurrent !== true) return;
      const next = await tx.storedFile.findFirst({ where: { AND: [versionsOf(row), { isActive: true }] }, orderBy: { version: 'desc' }, select: { id: true } });
      if (next) await tx.storedFile.update({ where: { id: next.id }, data: { isCurrent: true } });
    },
    afterRestore: async (row, tx) => {
      if (row.isCurrent === true) await tx.storedFile.updateMany({ where: { AND: [versionsOf(row), { NOT: { id: text(row.id) } }] }, data: { isCurrent: false } });
    },
  },
  folder: {
    area: 'documents',
    model: 'Folder',
    label: row => text(row.name),
    permits: (_row, user) => matrixAllows(user.matrix, 'clients.edit'),
    // The main folder follows the client, a worker's folder the worker.
    guard: row => (!row.parentId ? 'delete_root_folder' : row.employeeId ? 'delete_worker_folder' : null),
    children: async (row, prisma) => {
      const folders = await folderTree(prisma, [text(row.id)]);
      return [
        { model: 'Folder', ids: folders },
        { model: 'StoredFile', ids: await ids(prisma, 'StoredFile', { folderId: { in: folders } }) },
      ];
    },
  },
  official_form: {
    area: 'official_forms',
    model: 'OfficialForm',
    label: row => text(row.nameNl),
    children: async (row, prisma) => [{ model: 'FormSubmission', ids: await ids(prisma, 'FormSubmission', { formId: text(row.id) }) }],
  },
  form_submission: {
    area: 'official_forms',
    model: 'FormSubmission',
    include: { form: { select: { nameNl: true } }, client: { select: { number: true } } },
    label: row => [text(nested(row, 'form').nameNl), text(nested(row, 'client').number), day(row.preparedOn)].filter(Boolean).join(' · '),
  },
  address: {
    area: 'official_forms',
    model: 'AddressBookEntry',
    label: row => [text(row.name), text(row.department)].filter(Boolean).join(' · '),
    // A form that sends its post here would lose its recipient: another one is chosen there first. (Sent forms keep the address they went to.)
    guard: async (row, { prisma }) => {
      const forms = await prisma.officialForm.count({ where: { recipientId: text(row.id) } });
      return forms ? { code: 'address_in_use', details: { forms } } : null;
    },
  },
  inspection: {
    area: 'inspections',
    model: 'Inspection',
    include: { client: { select: { number: true } } },
    label: row => [text(row.number), text(nested(row, 'client').number), day(row.date)].filter(Boolean).join(' · '),
  },
  tax_return: {
    area: 'taxes',
    model: 'TaxReturn',
    include: { client: { select: { number: true } } },
    label: row => [RETURN_KINDS[text(row.kind)] ?? text(row.kind), text(row.taxYear), text(nested(row, 'client').number)].filter(Boolean).join(' · '),
  },
  task: { area: 'tasks', model: 'Task', label: row => text(row.title) },
  event: { area: 'calendar', model: 'CalendarEvent', label: row => [text(row.title), day(row.startsOn)].filter(Boolean).join(' · ') },
  import: {
    area: 'imports',
    model: 'ImportJob',
    label: row => text(row.name),
    guard: row => (row.status === 'processing' ? 'delete_busy' : null),
  },
  import_mapping: { area: 'imports', model: 'ImportMapping', label: row => text(row.name), guard: row => (row.isSystem === true ? 'delete_system' : null) },
  user: {
    area: 'users',
    model: 'User',
    include: { role: { select: { key: true } } },
    label: row => text(row.name) || text(row.email),
    guard: async (row, { prisma, user }) => {
      if (row.id === user.id) return 'cannot_delete_self';
      if (nested(row, 'role').key === OWNER_ROLE_KEY && row.status === 'active') {
        const owners = await prisma.user.count({ where: { status: 'active', role: { key: OWNER_ROLE_KEY } } });
        if (owners <= 1) return { code: 'last_owner', details: { name: text(row.name) } };
      }
      return null;
    },
    // Signed out everywhere at once (an invitation link stops working by itself: it no longer finds its account).
    afterDelete: async (row, tx) => {
      await tx.session.updateMany({ where: { userId: text(row.id), revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'user_deleted' } });
    },
  },
  role: {
    area: 'users',
    model: 'Role',
    label: row => text(row.name),
    guard: async (row, { prisma }) => {
      if (row.isSystem === true) return 'system_role';
      const members = await prisma.user.count({ where: { roleId: text(row.id) } });
      return members ? { code: 'role_in_use', details: { members, name: text(row.name) } } : null;
    },
  },
  list: {
    area: 'settings',
    model: 'List',
    label: row => text(row.nameNl),
    guard: row => (row.isSystem === true ? 'delete_system' : null),
    children: async (row, prisma) => [{ model: 'ListItem', ids: await ids(prisma, 'ListItem', { listId: text(row.id) }) }],
  },
  // Every item of a choice list can go, built-in ones too. The fixed lists (the statuses) are what the program itself works with: it would still set them, and they cannot be added back.
  list_item: { area: 'settings', model: 'ListItem', include: { list: { select: { allowNewItems: true } } }, label: row => text(row.nameNl), guard: row => (nested(row, 'list').allowNewItems === false ? 'delete_system' : null) },
  holiday: { area: 'settings', model: 'Holiday', label: row => [text(row.nameNl), day(row.date)].filter(Boolean).join(' · ') },
  document_type: {
    area: 'settings',
    model: 'DocumentType',
    label: row => text(row.nameNl),
    // A type that documents have is switched off instead (they would lose it); its required-document rules go with it.
    guard: async (row, { prisma }) => {
      if (row.isSystem === true) return 'delete_system';
      const documents = await prisma.storedFile.count({ where: { docType: text(row.code) } });
      return documents ? { code: 'document_type_in_use', details: { documents } } : null;
    },
    children: async (row, prisma) => [{ model: 'RequiredDocument', ids: await ids(prisma, 'RequiredDocument', { typeCode: text(row.code) }) }],
  },
  folder_template: {
    area: 'settings',
    model: 'FolderTemplate',
    label: row => text(row.nameNl),
    guard: row => (row.isSystem === true ? 'delete_system' : null),
    // The standard folders inside it go with it; the folders clients already have stay.
    children: async (row, prisma) => [{ model: 'FolderTemplate', ids: await templateTree(prisma, text(row.code)) }],
  },
  required_document: { area: 'settings', model: 'RequiredDocument', include: { type: { select: { nameNl: true } } }, label: row => text(nested(row, 'type').nameNl) || text(row.typeCode) },
  reminder_rule: { area: 'settings', model: 'ReminderRule', label: row => text(row.name) },
  message_template: { area: 'settings', model: 'MessageTemplate', label: row => text(row.name) },
  surcharge_rule: { area: 'settings', model: 'SurchargeRule', label: row => text(row.name) },
  vat_step: { area: 'settings', model: 'VatStep', label: row => text(row.nameNl), guard: row => (row.isFiling === true ? 'delete_filing_step' : null) },
  checklist: { area: 'settings', model: 'ChecklistTemplate', label: row => text(row.nameNl) },
  export_preset: { area: 'reports', model: 'ExportPreset', label: row => text(row.name) },
};

export const DELETION_TYPES = Object.keys(DELETION_SPECS);
