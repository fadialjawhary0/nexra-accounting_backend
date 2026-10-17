import { ConflictException, ForbiddenException, HttpException, Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import { asRecord } from '../../common/record-values.js';
import { isValidDay, todayInAmsterdam } from '../../common/dates.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import type { ImportItem } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { ClientPeopleService } from '../clients/client-people.service.js';
import { ClientsService } from '../clients/clients.service.js';
import { ContractLifecycleService } from '../contracts/contract-lifecycle.service.js';
import { ContractsService } from '../contracts/contracts.service.js';
import { CounterpartiesService } from '../counterparties/counterparties.service.js';
import { EmployeesService } from '../employees/employees.service.js';
import { FILE_PURPOSES, extensionOf } from '../files/files.constants.js';
import { FilesService } from '../files/files.service.js';
import { HoursService } from '../hours/hours.service.js';
import { InvoicesService } from '../invoices/invoices.service.js';
import { PeopleService } from '../people/people.service.js';
import { matrixAllows } from '../roles/permission-catalog.js';
import { fileData, hoursData, invoiceData } from './document-items.js';
import { DocumentEvaluatorService, type Evaluation } from './document-evaluator.service.js';
import { DocumentFilingService } from './document-filing.service.js';
import { DOC_TYPES, ACCEPTABLE_STATUSES, auditTypeOf, type ItemConfidence, type ItemResult, type ItemSections, type ItemWarning } from './imports.constants.js';
import { ImportLookupsService } from './import-lookups.service.js';
import { ImportsService } from './imports.service.js';
import { ItemDataService } from './item-data.service.js';

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** Notes about the file that no later check can work out again, so they stay on the item. */
export const KEPT_NOTES: readonly string[] = ['ai_unavailable', 'ai_failed', 'ai_file_too_large', 'ai_too_many_pages', 'ai_not_readable', 'duplicate_known', 'type_unsure', 'client_mismatch', 'client_unknown_number'];
/** Of those, the ones about which client the file belongs to. */
export const CLIENT_NOTES: readonly string[] = ['client_mismatch', 'client_unknown_number'];

/** Why an item could not be accepted: the message key of the item and, when a form refused values, which fields. */
export interface Failure {
  message: string;
  errors: Record<string, string>;
}

/** What an error of one of the services means for the item (`fields` are field keys of the record that was being saved: `prefix` puts the record in front). */
export function failureOf(error: unknown, prefix?: string): Failure {
  if (error instanceof HttpException) {
    const body = asRecord(error.getResponse());
    const fields = asRecord(body.fields) as Record<string, string>;
    const errors = Object.fromEntries(Object.entries(fields).map(([key, message]) => [prefix ? `${prefix}.${key}` : key, String(message)]));
    return { message: typeof body.code === 'string' ? body.code : 'failed', errors };
  }
  return { message: 'failed', errors: {} };
}

/**
 * Accepting an item of a file import: the person has looked at what was read, and now the records are made or changed — through the same services
 * that the screens use, as the person who accepts (so their permissions, validation and the audit trail all apply) — and the file is put in its
 * folder with its type and date. A step that was done is written on the item at once, so accepting again after a failure continues where it stopped.
 */
@Injectable()
export class DocumentAcceptService {
  private readonly logger = new Logger(DocumentAcceptService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly imports: ImportsService,
    private readonly data: ItemDataService,
    private readonly evaluator: DocumentEvaluatorService,
    private readonly filing: DocumentFilingService,
    private readonly files: FilesService,
    private readonly clients: ClientsService,
    private readonly clientPeople: ClientPeopleService,
    private readonly people: PeopleService,
    private readonly employees: EmployeesService,
    private readonly contracts: ContractsService,
    private readonly lifecycle: ContractLifecycleService,
    private readonly invoices: InvoicesService,
    private readonly counterparties: CounterpartiesService,
    private readonly hours: HoursService,
    private readonly lookups: ImportLookupsService,
  ) {}

  /** The current state of an item as the evaluation sees it (after an edit, or just before accepting). */
  async evaluate(item: ImportItem, user: AuthenticatedUser, overrides: Partial<Pick<ImportItem, 'docType' | 'clientId' | 'employeeId' | 'personId' | 'action'>> & { data?: ItemSections } = {}): Promise<Evaluation> {
    const hints = await this.filing.hints(item);
    // What the reading found out about the file itself stays; the rest is worked out again. A client chosen by hand settles what the folder said about it.
    const clientChanged = overrides.clientId !== undefined && overrides.clientId !== item.clientId;
    const carried = (Array.isArray(item.warnings) ? (item.warnings as unknown as ItemWarning[]) : []).filter(entry => KEPT_NOTES.includes(entry.code) && !(clientChanged && CLIENT_NOTES.includes(entry.code)));
    return this.evaluator.evaluate({
      principal: user,
      docType: overrides.docType ?? item.docType,
      data: overrides.data ?? this.data.open(item.data),
      confidence: item.confidence as ItemConfidence,
      clientId: overrides.clientId === undefined ? item.clientId : overrides.clientId,
      employeeId: overrides.employeeId === undefined ? item.employeeId : overrides.employeeId,
      personId: overrides.personId === undefined ? item.personId : overrides.personId,
      action: overrides.action === undefined ? item.action : overrides.action,
      fresh: false,
      hints: { workerFolder: hints.workerFolder, stopped: hints.stopped, unknownClientNumber: null },
      match: { clientNames: [], clientKvks: [] },
      extras: {},
      carried,
    });
  }

  /** Accepts one item as `user`. Returns the item as it is afterwards (`accepted`, or still waiting with what is wrong). */
  async accept(item: ImportItem, user: AuthenticatedUser): Promise<ImportItem> {
    if (!(ACCEPTABLE_STATUSES as readonly string[]).includes(item.status)) throw new ConflictException({ code: 'item_not_acceptable', message: 'This item cannot be accepted now.' });
    const evaluation = await this.evaluate(item, user);
    if (evaluation.action === 'skip') return this.imports.saveItem(item.id, { status: 'rejected', docType: evaluation.docType, action: 'skip', reviewedById: user.id });
    if (Object.keys(evaluation.errors).length) {
      const saved = await this.imports.saveItem(item.id, { status: 'review', ...this.stateOf(evaluation), message: '' });
      throw new UnprocessableEntityException({ code: 'item_invalid', message: 'This item has problems.', fields: evaluation.errors, details: { itemId: saved.id } });
    }
    this.allowed(evaluation, user);

    const results: ItemResult[] = [];
    let current = { ...evaluation };
    try {
      current = await this.make(item, current, user, results);
      await this.imports.saveItem(item.id, { status: 'accepted', ...this.stateOf(current), errors: {}, message: '', result: results, reviewedById: user.id });
      const job = await this.prisma.importJob.findUnique({ where: { id: item.jobId }, select: { kind: true } });
      await this.audit.log({ action: 'accepted', entityType: auditTypeOf(job?.kind ?? 'documents'), entityId: item.jobId, entityLabel: item.name, meta: { docType: current.docType, action: current.action, results: results.map(result => `${result.type}:${result.action}`) } });
    } catch (error) {
      const failure = failureOf(error, this.prefixFor(current.docType));
      this.logger.warn(`Accepting ${item.name} failed: ${failure.message}`);
      await this.imports.saveItem(item.id, { status: 'error', ...this.stateOf(current), errors: { ...failure.errors }, message: failure.message, result: results });
    }
    return this.prisma.importItem.findUniqueOrThrow({ where: { id: item.id } });
  }

  private stateOf(evaluation: Evaluation) {
    return {
      docType: evaluation.docType,
      action: evaluation.action,
      clientId: evaluation.clientId,
      employeeId: evaluation.employeeId,
      personId: evaluation.personId,
      data: evaluation.data,
      warnings: evaluation.warnings,
      errors: evaluation.errors,
      summary: evaluation.summary,
    };
  }

  private prefixFor(docType: string | null): string | undefined {
    return docType === DOC_TYPES.kvkExtract ? 'client' : docType === DOC_TYPES.contract ? 'contract' : docType === DOC_TYPES.staffingInvoice ? 'invoice' : docType === DOC_TYPES.timesheet ? 'hours' : 'person';
  }

  /** The right to do what accepting does: make or change records of those areas. */
  private allowed(evaluation: Evaluation, user: AuthenticatedUser): void {
    const file = fileData(evaluation.data);
    const needs: string[] = [];
    const attach = evaluation.action === 'attach';
    switch (evaluation.docType) {
      case DOC_TYPES.idDocument:
      case DOC_TYPES.residencePermit:
        needs.push(attach ? 'employees.edit' : file.create_employee ? 'employees.create' : 'employees.edit');
        break;
      case DOC_TYPES.kvkExtract:
        needs.push(attach || evaluation.action === 'update' ? 'clients.edit' : 'clients.create');
        break;
      case DOC_TYPES.contract:
        needs.push(attach ? 'contracts.edit' : 'contracts.create');
        if (file.create_employee) needs.push('employees.create');
        break;
      case DOC_TYPES.staffingInvoice:
        needs.push(attach ? 'clients.edit' : 'invoices.create');
        break;
      case DOC_TYPES.timesheet:
        needs.push(attach ? 'clients.edit' : 'hours.create', ...(attach ? [] : ['hours.edit']));
        break;
      default:
        needs.push(evaluation.employeeId && !evaluation.clientId ? 'employees.edit' : 'clients.edit');
    }
    const missing = needs.filter(capability => !matrixAllows(user.matrix, capability));
    if (missing.length) throw new ForbiddenException({ code: 'forbidden', message: 'You do not have access to this.', details: { missing } });
  }

  /* ── Making the records ───────────────────────────────────────────────────────────────────────────────────────── */

  private async make(item: ImportItem, evaluation: Evaluation, user: AuthenticatedUser, results: ItemResult[]): Promise<Evaluation> {
    const hints = await this.filing.hints(item);
    const file = fileData(evaluation.data);
    const docDate = isValidDay(text(file.doc_date)) ? text(file.doc_date) : null;
    const state = { ...evaluation };
    const remember = async (changes: Partial<Pick<ImportItem, 'clientId' | 'employeeId' | 'personId'>>) => {
      await this.prisma.importItem.update({ where: { id: item.id }, data: changes });
    };

    if (state.action !== 'attach') {
      switch (state.docType) {
        case DOC_TYPES.idDocument:
        case DOC_TYPES.residencePermit:
          await this.makePerson(state, user, results, remember);
          break;
        case DOC_TYPES.kvkExtract:
          await this.makeClient(state, user, results, remember);
          break;
        case DOC_TYPES.contract:
          await this.makeContract(item, state, hints.folderCode, docDate, user, results, remember);
          return state;
        case DOC_TYPES.staffingInvoice:
          await this.makeInvoice(item, state, hints.folderCode, docDate, user, results);
          return state;
        case DOC_TYPES.timesheet:
          await this.makeHours(state, user, results);
          break;
        default:
          break;
      }
    }
    await this.fileDocument(item, state, hints.folderCode, docDate, results);
    return state;
  }

  /** Puts the staged file with the record(s) it belongs to. */
  private async fileDocument(item: ImportItem, state: Evaluation, folderCode: string | null, docDate: string | null, results: ItemResult[], purpose?: string): Promise<void> {
    const target = await this.filing.target(state.docType, state.clientId, state.employeeId, folderCode);
    if (!target || !item.fileId) throw new UnprocessableEntityException({ code: 'validation_failed', message: 'Validation failed', fields: { 'item.client': 'imports.clientRequired' } });
    const allowed = purpose && FILE_PURPOSES[purpose]?.extensions.includes(extensionOf((await this.prisma.storedFile.findUnique({ where: { id: item.fileId }, select: { name: true } }))?.name ?? '')) ? purpose : undefined;
    const filed = await this.filing.file(item.fileId, target, state.docType, docDate, allowed);
    results.push({ type: 'file', id: filed.id, action: 'filed', label: filed.name });
  }

  /** A new person (not a worker): saved like the person dialogs do. */
  private async createPerson(values: Record<string, unknown>, user: AuthenticatedUser): Promise<string> {
    const plan = await this.people.planCreate(values, user);
    this.people.assertValid(plan);
    const { person, after } = await this.prisma.$transaction(tx => plan.commit(tx));
    await after();
    return person.id;
  }

  /** ID documents and permits: the person is made or filled in, and becomes a worker of the client when the review says so. */
  private async makePerson(state: Evaluation, user: AuthenticatedUser, results: ItemResult[], remember: (changes: Partial<Pick<ImportItem, 'clientId' | 'employeeId' | 'personId'>>) => Promise<void>): Promise<void> {
    const values = asRecord(state.data.person);
    const file = fileData(state.data);
    if (state.personId && Object.keys(values).length) {
      await this.people.update(state.personId, { values }, user);
      results.push({ type: 'person', id: state.personId, action: 'updated' });
    }
    if (file.create_employee && !state.employeeId && state.clientId) {
      const created = await this.employees.create({ values: { ...asRecord(state.data.employee), client: state.clientId }, person: state.personId ? { personId: state.personId } : { values } }, user);
      state.employeeId = created.id;
      state.personId = (await this.prisma.employee.findUniqueOrThrow({ where: { id: created.id }, select: { personId: true } })).personId;
      await remember({ employeeId: state.employeeId, personId: state.personId });
      results.push({ type: 'employee', id: created.id, action: 'created' });
      if (file.stopped) await this.employees.setStatus(created.id, { status: 'stopped', reason: 'import' }, user);
    } else if (!state.personId) {
      state.personId = await this.createPerson(values, user);
      await remember({ personId: state.personId });
      results.push({ type: 'person', id: state.personId, action: 'created' });
    }
  }

  /** KvK extracts (and a client a message to the inbox tells about): the client is made or filled in, and the owner / director is linked. */
  async makeClient(state: Evaluation, user: AuthenticatedUser, results: ItemResult[], remember: (changes: Partial<Pick<ImportItem, 'clientId' | 'employeeId' | 'personId'>>) => Promise<void>): Promise<void> {
    const values = asRecord(state.data.client);
    const file = fileData(state.data);
    if (state.clientId && state.action === 'update') {
      if (Object.keys(values).length) {
        await this.clients.update(state.clientId, { values }, user);
        results.push({ type: 'client', id: state.clientId, action: 'updated' });
      }
    } else if (!state.clientId) {
      const created = await this.clients.create({ values }, user);
      state.clientId = created.id;
      await remember({ clientId: created.id });
      results.push({ type: 'client', id: created.id, action: 'created', label: `${created.number} – ${created.name}` });
      if (file.stopped) await this.clients.setStatus(created.id, { status: 'stopped', reason: 'import' }, user);
    }
    const person = asRecord(state.data.person);
    if (state.clientId && (text(person.first_name) || text(person.last_name)) && matrixAllows(user.matrix, 'clients.edit')) {
      const role = text(file.person_role) || (await this.lookups.roleFor(text(values.legal_form) || text((await this.prisma.client.findUnique({ where: { id: state.clientId }, select: { legalForm: true } }))?.legalForm)));
      try {
        const link = await this.clientPeople.add(state.clientId, state.personId ? { personId: state.personId, role } : { values: person, role }, user);
        results.push({ type: 'person', id: link.person.id, action: state.personId ? 'linked' : 'created' });
      } catch (error) {
        // The person already has this role at the client: nothing to do.
        if (!(error instanceof HttpException) || asRecord(asRecord(error.getResponse()).fields).role !== 'validation.alreadyExists') throw error;
      }
    }
  }

  /** Contracts: the worker is made when needed, the contract is saved and — it exists on paper already — signed with the scan. */
  private async makeContract(
    item: ImportItem,
    state: Evaluation,
    folderCode: string | null,
    docDate: string | null,
    user: AuthenticatedUser,
    results: ItemResult[],
    remember: (changes: Partial<Pick<ImportItem, 'clientId' | 'employeeId' | 'personId'>>) => Promise<void>,
  ): Promise<void> {
    const file = fileData(state.data);
    if (!state.employeeId && file.create_employee && state.clientId) {
      const values = asRecord(state.data.person);
      if (state.personId) await this.people.update(state.personId, { values }, user).catch(() => undefined);
      const created = await this.employees.create({ values: { client: state.clientId }, person: state.personId ? { personId: state.personId } : { values } }, user);
      state.employeeId = created.id;
      state.personId = (await this.prisma.employee.findUniqueOrThrow({ where: { id: created.id }, select: { personId: true } })).personId;
      await remember({ employeeId: state.employeeId, personId: state.personId });
      results.push({ type: 'employee', id: created.id, action: 'created' });
      if (file.stopped) await this.employees.setStatus(created.id, { status: 'stopped', reason: 'import' }, user);
    }
    const terms = asRecord(state.data.contract);
    const contract = await this.contracts.create({ clientId: state.clientId!, employeeId: state.employeeId!, values: terms }, user);
    results.push({ type: 'contract', id: contract.id, action: 'created' });

    // The signed copy: filed as the contract's scan when its type allows, and the contract is marked signed (on the day it says, never in the future).
    const signedOn = [text(terms.signing_date), text(terms.start_date), todayInAmsterdam()].find(day => isValidDay(day) && day <= todayInAmsterdam())!;
    const staged = item.fileId ? await this.prisma.storedFile.findUnique({ where: { id: item.fileId }, select: { name: true } }) : null;
    const scan = staged ? FILE_PURPOSES.contract_scan!.extensions.includes(extensionOf(staged.name)) : false;
    if (scan && item.fileId) {
      const target = await this.filing.target(DOC_TYPES.contract, state.clientId, state.employeeId, folderCode);
      if (!target) throw new UnprocessableEntityException({ code: 'validation_failed', message: 'Validation failed', fields: { 'item.worker': 'imports.workerRequired' } });
      await this.filing.file(item.fileId, target, DOC_TYPES.contract, docDate, 'contract_scan');
      await this.lifecycle.sign(contract.id, { signedOn, fileId: item.fileId }, user);
      results.push({ type: 'file', id: item.fileId, action: 'filed', label: staged!.name });
    } else {
      await this.lifecycle.sign(contract.id, { signedOn }, user);
      await this.fileDocument(item, state, folderCode, docDate, results);
    }
  }

  /** Invoices of a staffing company: the company is made when it is new, the PDF is filed with the client, and the invoice is saved as received. */
  private async makeInvoice(item: ImportItem, state: Evaluation, folderCode: string | null, docDate: string | null, user: AuthenticatedUser, results: ItemResult[]): Promise<void> {
    const invoice = invoiceData(state.data);
    let counterpartyId = invoice.counterparty_id ?? null;
    if (!counterpartyId) {
      try {
        const created = await this.counterparties.create({ values: { name: text(invoice.party_name), kvk: invoice.party_kvk ?? null, vat_number: invoice.party_vat ?? null, iban: invoice.party_iban ?? null } }, user);
        counterpartyId = created.id;
      } catch (error) {
        const body = error instanceof HttpException ? asRecord(error.getResponse()) : {};
        if (body.code === 'counterparty_duplicate') counterpartyId = text(asRecord(body.details).id) || null;
        else throw error;
      }
    }
    const target = await this.filing.target(DOC_TYPES.staffingInvoice, state.clientId, null, folderCode);
    if (!target || !item.fileId) throw new UnprocessableEntityException({ code: 'validation_failed', message: 'Validation failed', fields: { 'item.client': 'imports.clientRequired' } });
    const staged = await this.prisma.storedFile.findUnique({ where: { id: item.fileId }, select: { name: true } });
    const allowed = FILE_PURPOSES.invoice_document!.extensions.includes(extensionOf(staged?.name ?? ''));
    await this.filing.file(item.fileId, target, DOC_TYPES.staffingInvoice, docDate, allowed ? 'invoice_document' : undefined);

    const created = await this.invoices.create(
      {
        direction: 'incoming',
        clientId: state.clientId!,
        ...(counterpartyId && { counterpartyId }),
        number: invoice.number,
        invoiceDate: invoice.invoice_date,
        dueDate: invoice.due_date,
        periodFrom: invoice.period_from!,
        periodTo: invoice.period_to!,
        ...(invoice.vat_percent !== undefined && { vatPercent: invoice.vat_percent }),
        lines: invoice.lines.map(line => ({
          kind: 'hours' as const,
          ...(line.employee_id ? { employeeId: line.employee_id } : { rawName: line.worker_name ?? undefined }),
          description: line.description ?? undefined,
          from: line.from ?? undefined,
          to: line.to ?? undefined,
          minutes: line.minutes ?? undefined,
          rate: line.rate ?? undefined,
          amount: line.amount ?? undefined,
        })),
        ...(allowed && { fileId: item.fileId }),
      },
      user,
    );
    results.push({ type: 'invoice', id: created.id, action: 'created' });
    if (!allowed) await this.fileDocument(item, state, folderCode, docDate, results);
  }

  /** Timesheets: every day becomes hours of the worker (days with clock times as an entry with those times, the others as total minutes). */
  private async makeHours(state: Evaluation, user: AuthenticatedUser, results: ItemResult[]): Promise<void> {
    const entries = hoursData(state.data).entries.filter(entry => entry.employee_id && entry.minutes);
    const cells: Array<{ employeeId: string; date: string; minutes: number }> = [];
    const failed: Record<string, string> = {};
    for (const [index, entry] of hoursData(state.data).entries.entries()) {
      if (!entry.employee_id || !entry.minutes) continue;
      const existing = await this.prisma.hourEntry.count({ where: { employeeId: entry.employee_id, date: new Date(`${entry.date}T00:00:00.000Z`) } });
      if (entry.start && entry.end && !existing) {
        try {
          await this.hours.create({ employeeId: entry.employee_id, date: entry.date, startTime: entry.start, endTime: entry.end, breakMinutes: entry.break_minutes ?? 0, values: entry.note ? { note: entry.note } : {} }, user, 'ai');
        } catch (error) {
          failed[`hours.entries.${index}`] = failureOf(error).message;
        }
      } else {
        cells.push({ employeeId: entry.employee_id, date: entry.date, minutes: entry.minutes });
      }
    }
    const indexOf = new Map(hoursData(state.data).entries.map((entry, index) => [`${entry.employee_id}|${entry.date}`, index]));
    for (let start = 0; start < cells.length; start += 400) {
      const batch = cells.slice(start, start + 400);
      for (const outcome of await this.hours.saveCells({ cells: batch }, user, 'ai')) {
        if (!outcome.ok) failed[`hours.entries.${indexOf.get(`${outcome.employeeId}|${outcome.date}`) ?? 0}`] = `imports.hours_${outcome.error ?? 'failed'}`;
      }
    }
    results.push({ type: 'hours', id: state.clientId ?? '', action: 'created', label: String(entries.length - Object.keys(failed).length) });
    if (Object.keys(failed).length) throw new UnprocessableEntityException({ code: 'hours_partly', message: 'Some days could not be saved.', fields: failed });
  }
}
