import { Injectable } from '@nestjs/common';
import { asRecord, columnValues } from '../../common/record-values.js';
import { formatDay, isValidDay, todayInAmsterdam } from '../../common/dates.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { ClientsService } from '../clients/clients.service.js';
import { isEmptyValue } from '../forms/form-doc.js';
import { FormRecordsService } from '../forms/form-records.service.js';
import { FormValidationService } from '../forms/form-validation.service.js';
import { FormsService } from '../forms/forms.service.js';
import { PERSON_COLUMNS } from '../people/person-record.js';
import { PeopleService } from '../people/people.service.js';
import { DOCUMENT_KEYS, fileData, hoursData, invoiceData, spanOf, type FileData, type HoursEntryData, type InvoiceData, type InvoiceLineData } from './document-items.js';
import { DocumentMatcherService } from './document-matcher.service.js';
import { DOC_TYPES, type ItemConfidence, type ItemSections, type ItemWarning } from './imports.constants.js';
import { parseDutchDate } from './value-coercion.js';

/** What the evaluation needs to know about an item (the reading of a file, or an edit by a person). */
export interface EvaluationInput {
  principal: AuthenticatedUser;
  docType: string | null;
  data: ItemSections;
  confidence: ItemConfidence;
  clientId: string | null;
  employeeId: string | null;
  personId: string | null;
  /** What the person (or an earlier evaluation) chose: `create` · `update` · `attach` · `skip`. */
  action: string | null;
  /** `true` straight after a file was read: the values are matched with what exists and merged into it. `false` after an edit: only checked. */
  fresh: boolean;
  /** What the path of the file says: a worker's folder name, a `0-GESTOPT` folder, a client number that is not (yet) a client. */
  hints: { workerFolder: string | null; stopped: boolean; unknownClientNumber: string | null };
  /** What the document says about who it is for, for finding the client. */
  match: { clientNames: string[]; clientKvks: string[] };
  /** The parts of the AI's answer that are not forms (invoice, lines, entries, letter …). */
  extras: Record<string, unknown>;
  /** Warnings from the reading itself (the AI was off, a model failed …). */
  carried: ItemWarning[];
}

export interface Evaluation {
  docType: string | null;
  action: string | null;
  clientId: string | null;
  employeeId: string | null;
  personId: string | null;
  data: ItemSections;
  warnings: ItemWarning[];
  /** `section.field` → message key; `item.*` for what is wrong with the item as a whole. */
  errors: Record<string, string>;
  /** One line for the list. */
  summary: string;
}

const warning = (code: string, level: ItemWarning['level'], field?: string, params?: ItemWarning['params']): ItemWarning => ({ code, level, ...(field && { field }), ...(params && { params }) });
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const sameValue = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const personLabel = (values: Record<string, unknown>): string => [values.first_name, values.infix, values.last_name].map(text).filter(Boolean).join(' ');
const prefixed = (prefix: string, errors: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(errors).map(([key, message]) => [`${prefix}.${key}`, message]));
const dutchDay = (day: string | undefined): string => (day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day.slice(8, 10)}-${day.slice(5, 7)}-${day.slice(0, 4)}` : '');
const euro = (value: number): string => new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(value);

/** Clock times (`07:30`) as minutes since midnight. */
function clock(value: string | null | undefined): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec((value ?? '').trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/**
 * Turns what was read from a file (or what a person changed in the review list) into an item that can be accepted: the values are checked against the
 * live forms, matched with the clients, workers and people that exist, and every problem is written down — an error stops the item from being
 * accepted, a warning only asks for a look. Nothing here writes a record.
 */
@Injectable()
export class DocumentEvaluatorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly validation: FormValidationService,
    private readonly records: FormRecordsService,
    private readonly forms: FormsService,
    private readonly matcher: DocumentMatcherService,
    private readonly clients: ClientsService,
    private readonly people: PeopleService,
  ) {}

  async evaluate(input: EvaluationInput): Promise<Evaluation> {
    const context: Evaluation = {
      docType: input.docType,
      action: input.action,
      clientId: input.clientId,
      employeeId: input.employeeId,
      personId: input.personId,
      data: { ...input.data },
      warnings: [...input.carried],
      errors: {},
      summary: '',
    };
    switch (input.docType) {
      case DOC_TYPES.idDocument:
      case DOC_TYPES.residencePermit:
        return this.identity(input, context);
      case DOC_TYPES.kvkExtract:
        return this.kvk(input, context);
      case DOC_TYPES.contract:
        return this.contract(input, context);
      case DOC_TYPES.staffingInvoice:
        return this.invoice(input, context);
      case DOC_TYPES.timesheet:
        return this.timesheet(input, context);
      default:
        return this.fileOnly(input, context);
    }
  }

  /* ── Pieces every kind uses ───────────────────────────────────────────────────────────────────────────────────── */

  /** The values of a record that exists, as the form sees them (decrypted). */
  async existingPerson(personId: string): Promise<Record<string, unknown>> {
    const person = await this.people.findOrThrow(personId);
    return { ...this.records.decode(asRecord(person.data)), ...columnValues(PERSON_COLUMNS, person) };
  }

  async existingClient(clientId: string): Promise<Record<string, unknown>> {
    return this.clients.values(await this.clients.findOrThrow(clientId));
  }

  /** The values the form accepts (normalised), plus the ones it refused (so a person sees what was read and why it was refused). */
  private async checked(entity: 'person' | 'client' | 'contract' | 'employee', raw: Record<string, unknown>, existing: Record<string, unknown>, input: EvaluationInput): Promise<{ values: Record<string, unknown>; errors: Record<string, string> }> {
    const { values, errors } = await this.validation.check(entity, raw, existing, input.principal.matrix);
    const merged = { ...raw, ...values };
    return { values: Object.fromEntries(Object.entries(merged).filter(([, value]) => !isEmptyValue(value))), errors: prefixed(entity, errors) };
  }

  /**
   * Of the values read from a document, the ones that may be written into a record that exists: empty fields are filled, a document's own details
   * (ID and permit number and dates) replace the old ones, anything else that differs from what is there is left alone — and said so.
   */
  private fillOnly(section: string, read: Record<string, unknown>, existing: Record<string, unknown>, warnings: ItemWarning[]): Record<string, unknown> {
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(read)) {
      const current = existing[key];
      if (isEmptyValue(current) || DOCUMENT_KEYS.has(key) || sameValue(current, value)) patch[key] = value;
      else warnings.push(warning('kept_current', 'info', `${section}.${key}`, { value: Array.isArray(value) ? value.join(', ') : String(value) }));
    }
    return patch;
  }

  /** The client a document is about, from what it says (KvK number first, then the name). When a client is chosen already (by the folder), the document must not be about another one. */
  private async clientFromContent(input: EvaluationInput, context: Evaluation): Promise<void> {
    if (context.clientId) {
      for (const kvk of input.match.clientKvks) {
        const other = await this.matcher.clientByKvk(kvk);
        if (other && other.id !== context.clientId) {
          context.warnings.push(warning('client_mismatch', 'attention', undefined, { client: `${other.number} – ${other.name}` }));
          return;
        }
      }
      return;
    }
    for (const kvk of input.match.clientKvks) {
      const found = await this.matcher.clientByKvk(kvk);
      if (found) {
        context.clientId = found.id;
        context.warnings.push(warning('client_from_kvk', 'info', undefined, { client: `${found.number} – ${found.name}` }));
        return;
      }
    }
    for (const name of input.match.clientNames) {
      const found = await this.matcher.clientByName(name);
      if (found) {
        context.clientId = found.id;
        context.warnings.push(warning('client_from_name', 'attention', undefined, { client: `${found.number} – ${found.name}` }));
        return;
      }
    }
  }

  /** The worker a document is about: the one chosen, or the one whose name fits (the name in the values, then the folder of the path). */
  private async workerFor(input: EvaluationInput, context: Evaluation, personValues: Record<string, unknown>): Promise<void> {
    if (context.employeeId) {
      const row = await this.prisma.employee.findUnique({ where: { id: context.employeeId }, select: { personId: true, clientId: true } });
      if (row) {
        context.personId = row.personId;
        context.clientId ??= row.clientId;
      }
      return;
    }
    if (!context.clientId) return;
    const workers = await this.matcher.workersOf(context.clientId);
    for (const name of [personLabel(personValues), input.hints.workerFolder ?? '']) {
      if (!name) continue;
      const found = await this.matcher.workerByName(context.clientId, name, workers);
      if (found === 'ambiguous') {
        context.warnings.push(warning('worker_ambiguous', 'attention', undefined, { name }));
        return;
      }
      if (found) {
        context.employeeId = found.employeeId;
        context.personId = found.personId;
        context.warnings.push(warning('worker_matched', 'info', undefined, { worker: found.name }));
        return;
      }
    }
  }

  /** The person a document is about, when no worker was found: the BSN is unique; a name together with a date of birth is as good. */
  private async personFor(context: Evaluation, values: Record<string, unknown>): Promise<void> {
    if (context.personId) return;
    const byBsn = await this.matcher.personByBsn(text(values.bsn));
    if (byBsn) {
      context.personId = byBsn;
      context.warnings.push(warning('person_matched_bsn', 'info'));
      return;
    }
    const byName = await this.matcher.personByNameAndBirth(text(values.first_name), text(values.last_name), text(values.date_of_birth));
    if (byName) {
      context.personId = byName;
      context.warnings.push(warning('person_matched_name', 'info'));
    }
  }

  /* ── ID documents and permits ─────────────────────────────────────────────────────────────────────────────────── */

  private async identity(input: EvaluationInput, context: Evaluation): Promise<Evaluation> {
    const file = { ...fileData(input.data) };
    const read = { ...asRecord(input.data.person) };
    await this.clientFromContent(input, context);
    await this.workerFor(input, context, read);
    await this.personFor(context, read);

    const existing = context.personId ? await this.existingPerson(context.personId) : {};
    const patch = input.fresh && context.personId ? this.fillOnly('person', read, existing, context.warnings) : read;
    const { values, errors } = await this.checked('person', patch, existing, input);
    context.data.person = values;
    Object.assign(context.errors, errors);

    // Nothing was read for a person that exists (no AI, or nothing legible): the document is only filed.
    context.action ??= context.personId ? (Object.keys(values).length ? 'update' : 'attach') : 'create';
    if (context.action === 'attach' || context.action === 'skip') {
      for (const key of Object.keys(context.errors)) if (key.startsWith('person.')) delete context.errors[key];
    }
    const wantsWorker = context.action !== 'attach' && context.action !== 'skip' && !context.employeeId && (file.create_employee ?? Boolean(context.clientId));
    file.create_employee = wantsWorker;
    if (wantsWorker && !context.clientId) context.errors['item.client'] = 'imports.clientRequired';
    // The employment of the new worker (the first day, the job, the wage — what a message to the inbox said with the ID), checked like the worker's form.
    const employment = { ...asRecord(input.data.employee) };
    delete employment.client;
    if (wantsWorker && Object.keys(employment).length) {
      const checkedEmployment = await this.checked('employee', { ...employment, ...(context.clientId && { client: context.clientId }) }, {}, input);
      delete checkedEmployment.values.client;
      delete checkedEmployment.errors['employee.client'];
      context.data.employee = checkedEmployment.values;
      Object.assign(context.errors, checkedEmployment.errors);
    }
    if (!context.employeeId && !wantsWorker && !context.clientId) context.errors['item.client'] = 'imports.clientRequired';
    if (context.action === 'attach' && !context.employeeId && !context.clientId) context.errors['item.client'] = 'imports.clientRequired';

    const expiry = text(values[context.docType === DOC_TYPES.idDocument ? 'id_expiry' : 'permit_expiry']);
    if (expiry && isValidDay(expiry) && expiry < todayInAmsterdam()) context.warnings.push(warning('document_expired', 'attention', undefined, { date: dutchDay(expiry) }));
    if (!personLabel(values) && context.action !== 'attach' && context.action !== 'skip' && !context.personId) context.errors['person.last_name'] ??= 'validation.required';
    if (context.action === 'create' && !context.personId) {
      const similar = await this.matcher.similarPeople(text(values.first_name), text(values.last_name));
      if (similar.length) context.warnings.push(warning('person_possible_duplicate', 'attention', undefined, { name: similar.map(entry => entry.name).join(', ') }));
    }
    if (input.hints.stopped && file.stopped === undefined) file.stopped = true;
    context.data.file = file;
    context.summary = [personLabel(values), expiry ? dutchDay(expiry) : ''].filter(Boolean).join(' · ');
    return context;
  }

  /* ── KvK extracts ─────────────────────────────────────────────────────────────────────────────────────────────── */

  private async kvk(input: EvaluationInput, context: Evaluation): Promise<Evaluation> {
    const file = { ...fileData(input.data) };
    const read = { ...asRecord(input.data.client) };
    const readPerson = { ...asRecord(input.data.person) };
    await this.clientFromContent(input, context);

    const existing = context.clientId ? await this.existingClient(context.clientId) : {};
    const patch = input.fresh && context.clientId ? this.fillOnly('client', read, existing, context.warnings) : read;
    const toCheck = context.clientId ? patch : { ...patch, number: text(patch.number) || input.hints.unknownClientNumber || 'auto' };
    const { values, errors } = await this.checked('client', toCheck, existing, input);
    if (!context.clientId && values.number === 'auto') delete values.number;
    if (!context.clientId) {
      delete errors['client.number'];
      if (!values.number) context.warnings.push(warning('number_assigned', 'info'));
    }
    context.data.client = values;
    Object.assign(context.errors, errors);

    context.action ??= context.clientId ? 'update' : 'create';
    if (context.action === 'attach' || context.action === 'skip') {
      for (const key of Object.keys(context.errors)) if (key.startsWith('client.')) delete context.errors[key];
    }
    if ((context.action === 'update' || context.action === 'attach') && !context.clientId) context.errors['item.client'] = 'imports.clientRequired';
    if (context.action === 'create' && values.kvk) {
      const holder = await this.matcher.clientByKvk(text(values.kvk));
      if (holder) {
        context.clientId = holder.id;
        context.action = 'update';
        context.warnings.push(warning('client_from_kvk', 'info', undefined, { client: `${holder.number} – ${holder.name}` }));
        delete context.errors['client.kvk'];
      }
    }

    // The owner, partner or director named on the extract.
    if (personLabel(readPerson) && context.action !== 'attach' && context.action !== 'skip') {
      await this.personFor(context, readPerson);
      const person = await this.checked('person', readPerson, context.personId ? await this.existingPerson(context.personId) : {}, input);
      context.data.person = person.values;
      Object.assign(context.errors, person.errors);
    } else {
      delete context.data.person;
    }
    if (input.hints.stopped && file.stopped === undefined) file.stopped = true;
    context.data.file = file;
    context.summary = [text(values.name), text(values.kvk) ? `KvK ${text(values.kvk)}` : ''].filter(Boolean).join(' · ');
    return context;
  }

  /* ── Contracts ────────────────────────────────────────────────────────────────────────────────────────────────── */

  private async contract(input: EvaluationInput, context: Evaluation): Promise<Evaluation> {
    const file = { ...fileData(input.data) };
    const terms = { ...asRecord(input.data.contract) };
    const read = { ...asRecord(input.data.person) };
    await this.clientFromContent(input, context);
    await this.workerFor(input, context, read);
    if (!context.employeeId) await this.personFor(context, read);

    const contract = await this.checked('contract', terms, {}, input);
    context.data.contract = contract.values;
    Object.assign(context.errors, contract.errors);

    context.action ??= 'create';
    const wantsWorker = context.action === 'create' && !context.employeeId && (file.create_employee ?? Boolean(context.clientId && personLabel(read)));
    file.create_employee = wantsWorker;
    if (wantsWorker) {
      const existing = context.personId ? await this.existingPerson(context.personId) : {};
      const person = await this.checked('person', input.fresh && context.personId ? this.fillOnly('person', read, existing, context.warnings) : read, existing, input);
      context.data.person = person.values;
      Object.assign(context.errors, person.errors);
    } else if (!context.employeeId) {
      context.data.person = read;
    }
    if (!context.clientId) context.errors['item.client'] = 'imports.clientRequired';
    if (context.action === 'create' && !context.employeeId && !wantsWorker) context.errors['item.worker'] = 'imports.workerRequired';
    if (context.action === 'attach' && !context.employeeId) context.errors['item.worker'] = 'imports.workerRequired';
    if (context.action === 'attach') for (const key of Object.keys(context.errors)) if (key.startsWith('contract.') || key.startsWith('person.')) delete context.errors[key];
    file.doc_date ??= text(contract.values.signing_date) || undefined;
    context.data.file = file;
    context.summary = [personLabel(read), dutchDay(text(contract.values.start_date)), text(contract.values.end_date) ? `→ ${dutchDay(text(contract.values.end_date))}` : ''].filter(Boolean).join(' · ');
    return context;
  }

  /* ── Invoices of staffing companies ───────────────────────────────────────────────────────────────────────────── */

  private async invoice(input: EvaluationInput, context: Evaluation): Promise<Evaluation> {
    const file = { ...fileData(input.data) };
    let invoice: InvoiceData = invoiceData(input.data);
    if (input.fresh) invoice = this.invoiceFromAnswer(input.extras);
    await this.clientFromContent(input, context);

    const workers = context.clientId ? await this.matcher.workersOf(context.clientId) : [];
    const lines: InvoiceLineData[] = [];
    for (const [index, line] of invoice.lines.entries()) {
      let employeeId = line.employee_id;
      if (!employeeId && line.worker_name && context.clientId) {
        const found = await this.matcher.workerByName(context.clientId, line.worker_name, workers);
        if (found && found !== 'ambiguous') employeeId = found.employeeId;
        else if (found === 'ambiguous') context.warnings.push(warning('worker_ambiguous', 'attention', `invoice.lines.${index}`, { name: line.worker_name }));
      }
      lines.push({ ...line, employee_id: employeeId });
      if (line.minutes !== null && (line.minutes < 0 || line.minutes > 1_000_000)) context.errors[`invoice.lines.${index}`] = 'validation.invalid';
      for (const day of [line.from, line.to]) if (day && !isValidDay(day)) context.errors[`invoice.lines.${index}`] = 'validation.invalidDate';
    }
    invoice.lines = lines;

    // The company that sent it: known by its KvK number or its name, otherwise it is made when the invoice is accepted.
    if (!invoice.counterparty_id) {
      const known = await this.prisma.counterparty.findFirst({ where: invoice.party_kvk ? { kvk: invoice.party_kvk.replace(/\D/g, '') } : { name: { equals: invoice.party_name ?? '', mode: 'insensitive' } }, select: { id: true } });
      if (known && (invoice.party_kvk || invoice.party_name)) invoice.counterparty_id = known.id;
    }
    if (!invoice.counterparty_id && !text(invoice.party_name)) context.errors['invoice.party_name'] = 'validation.required';
    else if (!invoice.counterparty_id) context.warnings.push(warning('party_new', 'info', undefined, { name: text(invoice.party_name) }));

    const span = spanOf([...lines.flatMap(line => [line.from, line.to]), invoice.period_from, invoice.period_to]);
    if (span) {
      invoice.period_from ||= span.from;
      invoice.period_to ||= span.to;
    }
    for (const [key, field] of [['number', 'invoice.number'], ['invoice_date', 'invoice.invoice_date'], ['period_from', 'invoice.period_from'], ['period_to', 'invoice.period_to']] as const) {
      if (!text(invoice[key])) context.errors[field] = 'validation.required';
    }
    for (const key of ['invoice_date', 'due_date', 'period_from', 'period_to'] as const) if (invoice[key] && !isValidDay(invoice[key]!)) context.errors[`invoice.${key}`] = 'validation.invalidDate';
    if (!lines.length) context.errors['invoice.lines'] = 'imports.noLines';
    if (!context.clientId) context.errors['item.client'] = 'imports.clientRequired';

    if (context.clientId && invoice.number && (invoice.counterparty_id || invoice.party_name)) {
      const duplicate = await this.prisma.invoice.findFirst({ where: { direction: 'incoming', clientId: context.clientId, number: invoice.number, ...(invoice.counterparty_id && { counterpartyId: invoice.counterparty_id }) }, select: { id: true } });
      if (duplicate) context.errors['invoice.number'] = 'validation.alreadyExists';
    }
    const sum = lines.reduce((total, line) => total + (line.amount ?? 0), 0);
    if (invoice.total_excl_vat !== undefined && lines.some(line => line.amount !== null) && Math.abs(sum - invoice.total_excl_vat) > 0.05) {
      context.warnings.push(warning('total_differs', 'attention', 'invoice.total_excl_vat', { lines: sum.toFixed(2), total: invoice.total_excl_vat.toFixed(2) }));
    }

    context.action ??= 'create';
    if (context.action === 'attach') {
      for (const key of Object.keys(context.errors)) if (key.startsWith('invoice.')) delete context.errors[key];
    }
    context.data.invoice = invoice as unknown as Record<string, unknown>;
    context.data.file = { ...file, doc_date: file.doc_date ?? invoice.invoice_date };
    context.summary = [text(invoice.party_name), text(invoice.number), invoice.total_incl_vat !== undefined ? euro(invoice.total_incl_vat) : ''].filter(Boolean).join(' · ');
    return context;
  }

  /** The invoice block of the AI's answer as the item stores it (hours become minutes). */
  private invoiceFromAnswer(extras: Record<string, unknown>): InvoiceData {
    const header = asRecord(extras.invoice);
    const issuer = asRecord(extras.issuer);
    const lines = Array.isArray(extras.lines) ? (extras.lines as unknown[]) : [];
    const day = (value: unknown) => (typeof value === 'string' ? (parseDutchDate(value) ?? undefined) : undefined);
    const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
    return {
      number: text(header.number) || undefined,
      invoice_date: day(header.invoice_date),
      due_date: day(header.due_date),
      period_from: day(header.period_from),
      period_to: day(header.period_to),
      vat_percent: number(header.vat_percent),
      total_excl_vat: number(header.total_excl_vat),
      total_incl_vat: number(header.total_incl_vat),
      party_name: text(issuer.name) || undefined,
      party_kvk: text(issuer.kvk).replace(/\D/g, '') || undefined,
      party_vat: text(issuer.vat_number) || undefined,
      party_iban: text(issuer.iban).replace(/\s/g, '') || undefined,
      lines: lines.map(entry => {
        const line = asRecord(entry);
        const hours = number(line.hours);
        return {
          worker_name: text(line.worker_name) || null,
          employee_id: null,
          from: day(line.from) ?? null,
          to: day(line.to) ?? null,
          minutes: hours === undefined ? null : Math.round(hours * 60),
          rate: number(line.rate) ?? null,
          amount: number(line.amount) ?? null,
          description: text(line.description) || null,
        };
      }),
    };
  }

  /* ── Timesheets ───────────────────────────────────────────────────────────────────────────────────────────────── */

  private async timesheet(input: EvaluationInput, context: Evaluation): Promise<Evaluation> {
    const file = { ...fileData(input.data) };
    const sheet = input.fresh ? this.entriesFromAnswer(input.extras) : hoursData(input.data);
    if (input.fresh) {
      const header = asRecord(input.extras.sheet);
      if (text(header.client_name)) input.match.clientNames.push(text(header.client_name));
    }
    await this.clientFromContent(input, context);

    const known = context.clientId ? await this.matcher.workersOf(context.clientId) : null;
    const today = todayInAmsterdam();
    const entries: HoursEntryData[] = [];
    const clientsOfWorkers = new Set<string>();
    for (const [index, entry] of sheet.entries.entries()) {
      let employeeId = entry.employee_id;
      if (!employeeId) {
        const found = known ? await this.matcher.workerByName(context.clientId!, entry.worker_name, known) : await this.matcher.workerAnywhere(entry.worker_name);
        if (found === 'ambiguous') context.errors[`hours.entries.${index}`] = 'imports.workerAmbiguous';
        else if (!found) context.errors[`hours.entries.${index}`] = 'imports.workerUnknown';
        else employeeId = found.employeeId;
      }
      if (employeeId) {
        const owner = known?.find(worker => worker.employeeId === employeeId) ? context.clientId : (await this.prisma.employee.findUnique({ where: { id: employeeId }, select: { clientId: true } }))?.clientId;
        if (owner) clientsOfWorkers.add(owner);
      }
      if (!isValidDay(entry.date) || entry.date > formatDay(new Date(Date.parse(`${today}T00:00:00Z`) + 366 * 86_400_000)) || entry.date < '2000-01-01') context.errors[`hours.entries.${index}`] = 'validation.invalidDate';
      else if (entry.minutes === null || entry.minutes < 1 || entry.minutes > 1440) context.errors[`hours.entries.${index}`] ??= 'imports.noHours';
      entries.push({ ...entry, employee_id: employeeId });
    }
    if (!entries.length) context.errors['hours.entries'] = 'imports.noEntries';
    if (!context.clientId && clientsOfWorkers.size === 1) {
      context.clientId = [...clientsOfWorkers][0]!;
      context.warnings.push(warning('client_from_workers', 'info'));
    }
    if (!context.clientId) context.errors['item.client'] = 'imports.clientRequired';
    const span = spanOf(entries.map(entry => entry.date));
    context.action ??= 'create';
    if (context.action === 'attach') for (const key of Object.keys(context.errors)) if (key.startsWith('hours.')) delete context.errors[key];
    context.data.hours = { ...sheet, entries, period_from: span?.from, period_to: span?.to } as unknown as Record<string, unknown>;
    context.data.file = { ...file, doc_date: file.doc_date ?? span?.to };
    context.summary = [...new Set(entries.map(entry => entry.worker_name))].slice(0, 3).join(', ');
    return context;
  }

  private entriesFromAnswer(extras: Record<string, unknown>) {
    const header = asRecord(extras.sheet);
    const entries = Array.isArray(extras.entries) ? (extras.entries as unknown[]) : [];
    const merged = new Map<string, HoursEntryData>();
    for (const raw of entries) {
      const entry = asRecord(raw);
      const date = typeof entry.date === 'string' ? (parseDutchDate(entry.date) ?? entry.date) : '';
      const name = text(entry.worker_name);
      const start = clock(text(entry.start));
      const end = clock(text(entry.end));
      const breakMinutes = typeof entry.break_minutes === 'number' ? Math.round(entry.break_minutes) : 0;
      const hours = typeof entry.hours === 'number' && Number.isFinite(entry.hours) ? Math.round(entry.hours * 60) : null;
      const minutes = hours ?? (start !== null && end !== null ? (end >= start ? end - start : end + 1440 - start) - breakMinutes : null);
      const key = `${name.toLowerCase()}|${date}`;
      const earlier = merged.get(key);
      if (earlier) {
        // The same worker twice on a day (two shifts): the hours add up and the clock times no longer mean anything.
        earlier.minutes = (earlier.minutes ?? 0) + (minutes ?? 0);
        earlier.start = null;
        earlier.end = null;
        earlier.break_minutes = null;
        continue;
      }
      merged.set(key, { worker_name: name, employee_id: null, date, minutes, start: start === null ? null : text(entry.start), end: end === null ? null : text(entry.end), break_minutes: breakMinutes || null, note: text(entry.note) || null });
    }
    return { period_from: typeof header.period_from === 'string' ? (parseDutchDate(header.period_from) ?? undefined) : undefined, period_to: typeof header.period_to === 'string' ? (parseDutchDate(header.period_to) ?? undefined) : undefined, entries: [...merged.values()] };
  }

  /* ── Letters and everything else: only filed ──────────────────────────────────────────────────────────────────── */

  private async fileOnly(input: EvaluationInput, context: Evaluation): Promise<Evaluation> {
    const file: FileData = { ...fileData(input.data) };
    if (input.fresh && context.docType === DOC_TYPES.letter) {
      const letter = asRecord(input.extras.letter);
      const day = (value: unknown) => (typeof value === 'string' ? (parseDutchDate(value) ?? undefined) : undefined);
      file.doc_date ??= day(letter.letter_date);
      file.deadline ??= day(letter.deadline_date);
      file.subject ??= text(letter.subject) || undefined;
      file.sender ??= text(letter.sender) || undefined;
      file.topic ??= text(letter.topic) || undefined;
      file.summary ??= text(letter.summary) || undefined;
    }
    await this.clientFromContent(input, context);
    if (context.employeeId && !context.clientId) {
      const row = await this.prisma.employee.findUnique({ where: { id: context.employeeId }, select: { clientId: true } });
      context.clientId = row?.clientId ?? null;
    }
    if (!context.employeeId && input.hints.workerFolder && context.clientId && (input.docType === DOC_TYPES.payslip || input.docType === DOC_TYPES.idDocument)) {
      const found = await this.matcher.workerByName(context.clientId, input.hints.workerFolder);
      if (found && found !== 'ambiguous') context.employeeId = found.employeeId;
    }
    context.action ??= 'attach';
    if (context.action !== 'skip' && !context.clientId && !context.employeeId) context.errors['item.client'] = 'imports.clientRequired';
    if (!context.docType) context.errors['item.type'] = 'imports.typeRequired';
    if (input.hints.stopped && file.stopped === undefined) file.stopped = true;
    context.data = { ...context.data, file: file as Record<string, unknown> };
    context.summary = text(file.subject) || text(file.summary).slice(0, 120);
    return context;
  }
}
