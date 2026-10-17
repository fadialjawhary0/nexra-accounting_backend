import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { ApiResult, paged } from '../../common/api-result.js';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import { addDays, daysBetween, formatDay, isValidDay, parseDay, todayInAmsterdam } from '../../common/dates.js';
import { pageMeta, toOrderBy, toSkipTake } from '../../common/pagination.js';
import { asRecord } from '../../common/record-values.js';
import { fold } from '../../common/text.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { validationFailed } from '../../common/validation/failure.js';
import { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import type { ExportTable } from '../../lib/exports/export.types.js';
import { ExportsService } from '../../lib/exports/exports.service.js';
import { SettingsService } from '../../lib/settings/settings.service.js';
import { workKindOf, type WorkKind } from '../employees/employee-record.js';
import { FilesService } from '../files/files.service.js';
import { valuesFor } from '../forms/field-access.js';
import { FormRecordsService } from '../forms/form-records.service.js';
import { FormValidationService } from '../forms/form-validation.service.js';
import { FormsService } from '../forms/forms.service.js';
import { firstOfMonth, isMonth, lastOfMonth, minutesToHours, toCents } from '../hours/hours-time.js';
import { PeriodLocksService } from '../hours/period-locks.service.js';
import { personName } from '../people/person-record.js';
import { COUNTED_STATUSES } from '../reconciliation/reconciliation.constants.js';
import { ReconciliationService, type LineCoverageView } from '../reconciliation/reconciliation.service.js';
import { matrixAllows } from '../roles/permission-catalog.js';
import type { CancelInvoiceDto, CreateInvoiceDto, CreditInvoiceDto, InvoiceExportQuery, InvoiceLineDto, InvoiceListQuery, InvoiceStatusDto, InvoiceWorkersQuery, IssueInvoiceDto, PartiesQuery, UpdateInvoiceDto } from './dto/invoice.dto.js';
import { InvoiceDocumentsService } from './invoice-documents.service.js';
import { hoursAmountCents, invoiceTotals } from './invoice-calc.js';
import { InvoiceNumberingService } from './invoice-numbering.service.js';
import { DETAIL_INCLUDE, LIST_INCLUDE, OPEN_STATUSES, euros, listView, partyLabel, partyOf, workerBrief, type DetailRow, type ListRow } from './invoice-record.js';
import { INVOICE_DEFINITIONS, INVOICE_ENTITY, INVOICE_FILE_PURPOSE, INVOICES_NAMESPACE, MAX_INVOICE_DAYS, type InvoiceDirection, type InvoiceStatus, type LineKind } from './invoices.constants.js';

const AREA = 'invoices';

/** A line as it will be saved: dates as text, money in cents. */
interface Prepared {
  kind: LineKind;
  employeeId: string | null;
  rawName: string;
  description: string;
  fromDate: string | null;
  toDate: string | null;
  minutes: number;
  rateCents: number | null;
  amountCents: number;
}

/** Which statuses an invoice can move to by hand, per direction (a credit note has no "checked"). */
const NEXT: Record<InvoiceDirection, Partial<Record<InvoiceStatus, InvoiceStatus[]>>> = {
  outgoing: { sent: ['paid'], paid: ['sent'] },
  incoming: { received: ['checked', 'paid'], checked: ['received', 'paid'], paid: ['checked', 'received'] },
};

interface Issue {
  code: 'unmatched_lines' | 'over_invoiced';
  count: number;
}

/**
 * Invoices about hours: what a staffing company bills a client for the workers it supplied (incoming), and what a client bills a company that used its
 * workers (outgoing). The lines say worker, period, hours and rate; which registered hours they cover is worked out by the reconciliation, never stored.
 * An outgoing invoice is a draft until it is issued — it then gets its number, Word and PDF documents and closes the days it bills; a mistake after that
 * is taken back with a credit note. An incoming invoice is received, checked against the hours, and paid.
 */
@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly forms: FormsService,
    private readonly validation: FormValidationService,
    private readonly records: FormRecordsService,
    private readonly locks: PeriodLocksService,
    private readonly numbering: InvoiceNumberingService,
    private readonly documents: InvoiceDocumentsService,
    private readonly reconciliation: ReconciliationService,
    private readonly files: FilesService,
    private readonly exports: ExportsService,
  ) {
    settings.register(INVOICES_NAMESPACE, INVOICE_DEFINITIONS, { exposed: true });
  }

  /* ── Reading ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  private listWhere(query: InvoiceListQuery, withStatus = true): Prisma.InvoiceWhereInput {
    const terms = fold(query.search ?? '').split(' ').filter(Boolean);
    const today = parseDay(todayInAmsterdam());
    const month = query.month && isMonth(query.month) ? { from: firstOfMonth(query.month), to: lastOfMonth(query.month) } : null;
    const from = month?.from ?? (query.from && isValidDay(query.from) ? query.from : null);
    const to = month?.to ?? (query.to && isValidDay(query.to) ? query.to : null);
    const status = query.status ?? (query.open || query.overdue ? 'all' : undefined);
    return {
      ...(query.direction && { direction: query.direction }),
      ...(query.clientId && { clientId: query.clientId }),
      ...(query.partyId && { OR: [{ counterpartyId: query.partyId }, { otherClientId: query.partyId }] }),
      ...(query.employeeId && { lines: { some: { employeeId: query.employeeId } } }),
      ...(withStatus && (status === 'all' ? {} : status ? { status } : { status: { not: 'cancelled' } })),
      ...(from && { periodTo: { gte: parseDay(from) } }),
      ...(to && { periodFrom: { lte: parseDay(to) } }),
      ...((query.open || query.overdue) && { status: { in: [...OPEN_STATUSES] }, kind: 'invoice' }),
      ...(query.overdue && { dueDate: { lt: today } }),
      ...(terms.length && { AND: terms.map(term => ({ searchText: { contains: term } })) }),
    };
  }

  async list(query: InvoiceListQuery): Promise<ApiResult> {
    const where = this.listWhere(query);
    const orderBy = toOrderBy(query.sort, ['invoiceDate', 'dueDate', 'number', 'total', 'status', 'createdAt', 'periodFrom', 'client.number'], [{ invoiceDate: { sort: 'desc', nulls: 'first' } }, { createdAt: 'desc' }]) as Prisma.InvoiceOrderByWithRelationInput[];
    const [total, rows] = await Promise.all([this.prisma.invoice.count({ where }), this.prisma.invoice.findMany({ where, include: LIST_INCLUDE, orderBy, ...toSkipTake(query) })]);
    const today = todayInAmsterdam();
    return paged(
      rows.map(row => listView(row, today)),
      pageMeta(total, query, query.stats ? { counts: await this.stats(query) } : {}),
    );
  }

  /** The counters above the list: what is still to be done and what is to be paid, per direction (the status filter does not apply to them). */
  private async stats(query: InvoiceListQuery) {
    const base = this.listWhere({ ...query, status: 'all', open: false, overdue: false } as InvoiceListQuery, false);
    const today = parseDay(todayInAmsterdam());
    const [byStatus, overdue] = await Promise.all([
      this.prisma.invoice.groupBy({ by: ['direction', 'status'], where: { ...base, kind: 'invoice' }, _count: { _all: true }, _sum: { total: true } }),
      this.prisma.invoice.groupBy({ by: ['direction'], where: { ...base, kind: 'invoice', status: { in: [...OPEN_STATUSES] }, dueDate: { lt: today } }, _count: { _all: true }, _sum: { total: true } }),
    ]);
    const empty = () => ({ count: 0, total: 0 });
    const result: Record<InvoiceDirection, { byStatus: Record<string, { count: number; total: number }>; overdue: { count: number; total: number } }> = {
      incoming: { byStatus: {}, overdue: empty() },
      outgoing: { byStatus: {}, overdue: empty() },
    };
    for (const row of byStatus) result[row.direction as InvoiceDirection].byStatus[row.status] = { count: row._count._all, total: row._sum.total?.toNumber() ?? 0 };
    for (const row of overdue) result[row.direction as InvoiceDirection].overdue = { count: row._count._all, total: row._sum.total?.toNumber() ?? 0 };
    return result;
  }

  private async detailRow(id: string): Promise<DetailRow> {
    const row = await this.prisma.invoice.findUnique({ where: { id }, include: DETAIL_INCLUDE });
    if (!row) throw new NotFoundException({ code: 'not_found', message: 'Invoice not found' });
    return row;
  }

  private allowed(row: DetailRow) {
    const direction = row.direction as InvoiceDirection;
    const status = row.status as InvoiceStatus;
    const invoice = row.kind === 'invoice';
    const draft = direction === 'outgoing' && status === 'draft' && invoice;
    const credited = row.credits.some(credit => credit.status !== 'cancelled');
    const next = (NEXT[direction][status] ?? []).filter(target => invoice || target !== 'checked');
    return {
      edit: draft || (direction === 'incoming' && status === 'received' && invoice),
      issue: draft,
      remove: draft,
      cancel: direction === 'incoming' && (status === 'received' || status === 'checked'),
      credit: invoice && (COUNTED_STATUSES as readonly string[]).includes(status) && !credited,
      documents: direction === 'outgoing' && (status === 'sent' || status === 'paid'),
      next,
    };
  }

  /** One invoice with its lines, how well each line is backed by registered hours, its documents and what is still open. */
  async one(id: string, user: AuthenticatedUser) {
    const row = await this.detailRow(id);
    const { doc } = await this.forms.live(INVOICE_ENTITY);
    const [coverage, fileRows] = await Promise.all([this.reconciliation.lineCoverage(id), this.prisma.storedFile.findMany({ where: { id: { in: [row.fileId, row.pdfFileId].filter((value): value is string => Boolean(value)) } } })]);
    const brief = (fileId: string | null) => {
      const file = fileRows.find(entry => entry.id === fileId);
      return file && file.isActive ? { id: file.id, name: file.name, size: file.size, mimeType: file.mimeType } : null;
    };
    const lines = row.lines.map(line => ({
      id: line.id,
      kind: line.kind as LineKind,
      employee: line.employee ? workerBrief(line.employee) : null,
      rawName: line.rawName,
      description: line.description,
      from: line.fromDate ? formatDay(line.fromDate) : null,
      to: line.toDate ? formatDay(line.toDate) : null,
      minutes: line.minutes,
      rate: line.rate ? euros(line.rate) : null,
      amount: euros(line.amount),
      coverage: coverage.get(line.id) ?? null,
    }));
    const hours = lines.filter(line => line.kind === 'hours');
    const issues = this.issuesOf(hours);
    const wrongMath = hours.filter(line => line.rate !== null && toCents(line.amount) !== hoursAmountCents(line.minutes, toCents(line.rate))).length;
    return {
      ...listView({ ...row, lines: row.lines.map(line => ({ kind: line.kind, minutes: line.minutes, employeeId: line.employeeId })) } as ListRow, todayInAmsterdam()),
      client: { id: row.client.id, number: row.client.number, name: row.client.name, isActive: row.client.isActive },
      vatPercent: row.vatPercent.toNumber(),
      vatShifted: row.vatShifted,
      gAccountPercent: row.gAccountPercent.toNumber(),
      locale: row.locale,
      note: row.note,
      values: valuesFor(doc, this.records.publicValues(asRecord(row.data)), user.matrix),
      creditOf: row.creditOf,
      credits: row.credits,
      cancelReason: row.cancelReason,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      issuedAt: row.issuedAt?.toISOString() ?? null,
      lines,
      files: { word: brief(row.fileId), pdf: brief(row.pdfFileId) },
      warnings: [...issues.map(issue => ({ code: issue.code, severity: 'warning' as const, count: issue.count })), ...(wrongMath ? [{ code: 'line_math', severity: 'warning' as const, count: wrongMath }] : [])],
      allowed: this.allowed(row),
    };
  }

  private issuesOf(lines: Array<{ employee: unknown; coverage: LineCoverageView | null }>): Issue[] {
    const issues: Issue[] = [];
    const unmatched = lines.filter(line => !line.employee).length;
    const over = lines.filter(line => line.coverage && line.coverage.unbacked > 0).length;
    if (unmatched) issues.push({ code: 'unmatched_lines', count: unmatched });
    if (over) issues.push({ code: 'over_invoiced', count: over });
    return issues;
  }

  /* ── Pickers ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  /** The companies an invoice can be with: clients of the office (with their number) and the companies that are not clients. */
  async parties(query: PartiesQuery) {
    const terms = fold(query.search ?? '').split(' ').filter(Boolean);
    const limit = query.limit ?? 20;
    const [clients, companies] = await Promise.all([
      this.prisma.client.findMany({
        where: { isActive: true, ...(query.exceptClientId && { id: { not: query.exceptClientId } }), AND: terms.map(term => ({ OR: [{ number: { contains: term, mode: 'insensitive' as const } }, { name: { contains: term, mode: 'insensitive' as const } }] })) },
        orderBy: { number: 'asc' },
        take: limit,
        select: { id: true, number: true, name: true },
      }),
      this.prisma.counterparty.findMany({ where: { isActive: true, AND: terms.map(term => ({ searchText: { contains: term } })) }, orderBy: { name: 'asc' }, take: limit, select: { id: true, name: true, kvk: true } }),
    ]);
    return [
      ...companies.map(company => ({ type: 'counterparty' as const, id: company.id, name: company.name, number: null, hint: company.kvk ?? '' })),
      ...clients.map(client => ({ type: 'client' as const, id: client.id, name: client.name, number: client.number, hint: '' })),
    ];
  }

  /**
   * The workers of a client whose hours an invoice could bill: what is registered in the period, what an invoice of that direction already covers, what is
   * left, the dates of what is left, the rate last billed for the worker and — for people who may see what is paid — the hourly rate they are paid.
   */
  async workers(query: InvoiceWorkersQuery, user: AuthenticatedUser) {
    if (!isValidDay(query.from) || !isValidDay(query.to)) throw validationFailed({ from: 'validation.invalidDate' });
    if (query.to < query.from) throw validationFailed({ to: 'validation.endBeforeStart' });
    const range = { gte: parseDay(query.from), lte: parseDay(query.to) };
    const withHours = await this.prisma.hourEntry.groupBy({ by: ['employeeId'], where: { employee: { clientId: query.clientId }, date: range } });
    const ids = withHours.map(row => row.employeeId);
    if (!ids.length) return [];
    const [workers, figures, last, rates] = await Promise.all([
      this.prisma.employee.findMany({ where: { id: { in: ids } }, include: { person: true } }),
      this.reconciliation.forWorkers(ids, query.from, query.to),
      this.prisma.$queryRaw<Array<{ employeeId: string; rate: Prisma.Decimal }>>`
        SELECT DISTINCT ON (l."employeeId") l."employeeId", l."rate"
        FROM "InvoiceLine" l JOIN "Invoice" i ON i."id" = l."invoiceId"
        WHERE l."employeeId" IN (${Prisma.join(ids)}) AND l."rate" IS NOT NULL AND i."direction" = ${query.direction} AND i."kind" = 'invoice' AND i."status" <> 'cancelled'
        ORDER BY l."employeeId", i."createdAt" DESC`,
      matrixAllows(user.matrix, 'salary_statements.view')
        ? this.prisma.rateHistory.findMany({ where: { employeeId: { in: ids }, validFrom: { lte: parseDay(todayInAmsterdam()) } }, orderBy: { validFrom: 'desc' } })
        : Promise.resolve([]),
    ]);
    const lastRate = new Map(last.map(row => [row.employeeId, Number(row.rate)]));
    const payRate = new Map<string, number>();
    for (const row of rates) if (!payRate.has(row.employeeId)) payRate.set(row.employeeId, row.rate.toNumber());
    return workers
      .map(worker => {
        const figure = figures.get(worker.id);
        const invoiced = figure?.invoiced[query.direction] ?? 0;
        const registered = figure?.registered ?? 0;
        const open = (figure?.days ?? []).filter(day => day.registered > day[query.direction]);
        return {
          employeeId: worker.id,
          name: personName(worker.person),
          kind: workKindOf(worker.data) as WorkKind,
          registered,
          invoiced,
          free: Math.max(0, registered - invoiced),
          firstFree: open[0]?.date ?? null,
          lastFree: open[open.length - 1]?.date ?? null,
          lastRate: lastRate.get(worker.id) ?? null,
          ...(payRate.has(worker.id) && { payRate: payRate.get(worker.id) }),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'nl'));
  }

  /** What a new invoice starts with (Settings → Invoices): the VAT percentage, the payment term in days, the percentage for the G-account and the document language. */
  defaults() {
    return {
      vatPercent: this.settings.get<number>(`${INVOICES_NAMESPACE}.vatPercent`),
      paymentDays: this.settings.get<number>(`${INVOICES_NAMESPACE}.paymentDays`),
      gAccountPercent: this.settings.get<number>(`${INVOICES_NAMESPACE}.gAccountPercent`),
      locale: this.settings.get<string>('locale.documentLocale') === 'en' ? 'en' : 'nl',
    };
  }

  /** The number the next outgoing invoice of a client dated `date` would get (shown in the "issue" dialog; the number is only used when the invoice is issued). */
  async nextNumber(clientId: string, date: string | undefined) {
    const day = date && isValidDay(date) ? date : todayInAmsterdam();
    await this.clientOrThrow(clientId);
    return { number: await this.numbering.peek(clientId, day), date: day };
  }

  /* ── Making and changing ──────────────────────────────────────────────────────────────────────────────────────── */

  private async clientOrThrow(id: string) {
    const client = await this.prisma.client.findUnique({ where: { id }, select: { id: true, number: true, name: true, isActive: true } });
    if (!client) throw validationFailed({ clientId: 'validation.invalid' });
    return client;
  }

  /** Exactly one other party; it must exist, and it is not the invoice's own client. */
  private async resolveParty(counterpartyId: string | null | undefined, otherClientId: string | null | undefined, clientId: string) {
    if (Boolean(counterpartyId) === Boolean(otherClientId)) throw validationFailed({ party: 'validation.required' });
    if (counterpartyId) {
      const company = await this.prisma.counterparty.findUnique({ where: { id: counterpartyId }, select: { id: true, isActive: true } });
      if (!company) throw validationFailed({ party: 'validation.invalid' });
      return { counterpartyId: company.id, otherClientId: null };
    }
    if (otherClientId === clientId) throw validationFailed({ party: 'validation.invalid' });
    const client = await this.prisma.client.findUnique({ where: { id: otherClientId as string }, select: { id: true } });
    if (!client) throw validationFailed({ party: 'validation.invalid' });
    return { counterpartyId: null, otherClientId: client.id };
  }

  private period(from: string, to: string): { periodFrom: string; periodTo: string } {
    const problems: Record<string, string> = {};
    if (!isValidDay(from)) problems.periodFrom = 'validation.invalidDate';
    if (!isValidDay(to)) problems.periodTo = 'validation.invalidDate';
    if (!Object.keys(problems).length) {
      if (to < from) problems.periodTo = 'validation.endBeforeStart';
      else if (daysBetween(from, to) + 1 > MAX_INVOICE_DAYS) problems.periodTo = 'validation.invalid';
    }
    if (Object.keys(problems).length) throw validationFailed(problems);
    return { periodFrom: from, periodTo: to };
  }

  private optionalDay(value: string | undefined, field: string): string | null {
    if (value === undefined || value === '') return null;
    if (!isValidDay(value)) throw validationFailed({ [field]: 'validation.invalidDate' });
    return value;
  }

  /** Checks the lines of an invoice and turns them into what is saved: each worker must belong to the right client, hours need a period and a time, amounts default to hours × rate. */
  private async prepareLines(input: InvoiceLineDto[], context: { direction: InvoiceDirection; clientId: string; otherClientId: string | null; periodFrom: string; periodTo: string }): Promise<Prepared[]> {
    const problems: Record<string, string> = {};
    const ids = [...new Set(input.map(line => line.employeeId).filter((id): id is string => Boolean(id)))];
    const workers = new Map((ids.length ? await this.prisma.employee.findMany({ where: { id: { in: ids } }, include: { person: true } }) : []).map(worker => [worker.id, worker]));
    const lines: Prepared[] = [];
    input.forEach((raw, index) => {
      const at = (field: string) => `lines.${index}.${field}`;
      const kind = raw.kind ?? 'hours';
      if (kind !== 'hours') {
        const description = (raw.description ?? '').trim();
        if (!description) problems[at('description')] = 'validation.required';
        if (raw.amount === null || raw.amount === undefined) problems[at('amount')] = 'validation.required';
        lines.push({ kind, employeeId: null, rawName: '', description, fromDate: null, toDate: null, minutes: 0, rateCents: null, amountCents: toCents(raw.amount ?? 0) });
        return;
      }
      const worker = raw.employeeId ? workers.get(raw.employeeId) : undefined;
      if (raw.employeeId && !worker) problems[at('employeeId')] = 'validation.invalid';
      // The issuer bills its own workers; a client that gets an invoice may also be billed for workers of the company it is with.
      if (worker && !(context.direction === 'outgoing' ? worker.clientId === context.clientId : [context.clientId, context.otherClientId].includes(worker.clientId))) problems[at('employeeId')] = 'validation.invalid';
      const rawName = (raw.rawName ?? '').trim();
      if (!worker && !raw.employeeId && !rawName) problems[at('rawName')] = 'validation.required';
      const from = raw.from || context.periodFrom;
      const to = raw.to || context.periodTo;
      if (!isValidDay(from)) problems[at('from')] = 'validation.invalidDate';
      if (!isValidDay(to)) problems[at('to')] = 'validation.invalidDate';
      else if (isValidDay(from) && to < from) problems[at('to')] = 'validation.endBeforeStart';
      const minutes = raw.minutes ?? 0;
      if (minutes < 1) problems[at('minutes')] = 'validation.required';
      const rateCents = raw.rate === null || raw.rate === undefined ? null : toCents(raw.rate);
      let amountCents = 0;
      if (raw.amount !== null && raw.amount !== undefined) amountCents = toCents(raw.amount);
      else if (rateCents !== null) amountCents = hoursAmountCents(minutes, rateCents);
      else problems[at('amount')] = 'validation.required';
      lines.push({ kind, employeeId: worker?.id ?? null, rawName: worker ? personName(worker.person) : rawName, description: (raw.description ?? '').trim(), fromDate: from, toDate: to, minutes, rateCents, amountCents });
    });
    if (Object.keys(problems).length) throw validationFailed(problems);
    return lines;
  }

  private amounts(input: { vatPercent?: number; vatShifted?: boolean; gAccountPercent?: number; gAccountAmount?: number | null }, lines: Prepared[], current?: { vatPercent: number; vatShifted: boolean; gAccountPercent: number }) {
    const vatPercent = input.vatPercent ?? current?.vatPercent ?? this.settings.get<number>(`${INVOICES_NAMESPACE}.vatPercent`);
    const vatShifted = input.vatShifted ?? current?.vatShifted ?? false;
    let gPercent = input.gAccountPercent ?? current?.gAccountPercent ?? this.settings.get<number>(`${INVOICES_NAMESPACE}.gAccountPercent`);
    const typed = input.gAccountAmount === undefined || input.gAccountAmount === null ? null : toCents(input.gAccountAmount);
    const totals = invoiceTotals({ lines, vatBasisPoints: Math.round(vatPercent * 100), vatShifted, gAccountBasisPoints: Math.round(gPercent * 100), gAccountCents: typed });
    // An amount typed by hand sets the percentage the screens show.
    if (typed !== null) gPercent = totals.totalCents ? Math.round((typed / totals.totalCents) * 10_000) / 100 : 0;
    return { vatPercent, vatShifted, gPercent, totals };
  }

  private async formValues(input: Record<string, unknown>, existing: Record<string, unknown>, user: AuthenticatedUser) {
    const { doc } = await this.forms.live(INVOICE_ENTITY);
    const { values, errors } = await this.validation.check(INVOICE_ENTITY, input, existing, user.matrix, doc);
    if (Object.keys(errors).length) throw new UnprocessableEntityException({ code: 'validation_failed', message: 'Validation failed', fields: errors });
    return { doc, values };
  }

  private searchText(parts: Array<string | null | undefined>): string {
    return fold(parts.filter(Boolean).join(' '));
  }

  /** An incoming invoice carries the number on the document: required, and one company does not send the same number twice. */
  private async assertIncomingNumber(clientId: string, party: { counterpartyId: string | null; otherClientId: string | null }, number: string | undefined, exceptId?: string): Promise<string> {
    const text = number?.trim() ?? '';
    if (!text) throw validationFailed({ number: 'validation.required' });
    const duplicate = await this.prisma.invoice.findFirst({
      where: { clientId, direction: 'incoming', status: { not: 'cancelled' }, number: { equals: text, mode: 'insensitive' }, counterpartyId: party.counterpartyId, otherClientId: party.otherClientId, ...(exceptId && { id: { not: exceptId } }) },
      select: { id: true },
    });
    if (duplicate) throw new ConflictException({ code: 'invoice_duplicate', message: 'This invoice number is already registered for this company.', fields: { number: 'validation.numberInUse' }, details: { id: duplicate.id } });
    return text;
  }

  private lineData(lines: Prepared[]): Prisma.InvoiceLineUncheckedCreateWithoutInvoiceInput[] {
    return lines.map((line, index) => ({
      sortOrder: index,
      kind: line.kind,
      employeeId: line.employeeId,
      rawName: line.rawName,
      description: line.description,
      fromDate: line.fromDate ? parseDay(line.fromDate) : null,
      toDate: line.toDate ? parseDay(line.toDate) : null,
      minutes: line.minutes,
      rate: line.rateCents === null ? null : new Prisma.Decimal(line.rateCents).div(100),
      amount: new Prisma.Decimal(line.amountCents).div(100),
    }));
  }

  /** The incoming invoice's own file: it must have been uploaded for invoices, and it is filed in the client's invoices folder. */
  private async attachFile(invoiceId: string, clientId: string, fileId: string | null | undefined, previous: string | null): Promise<void> {
    if (fileId === undefined || fileId === previous) return;
    if (fileId === null) {
      await this.prisma.invoice.update({ where: { id: invoiceId }, data: { fileId: null } });
      await this.files.retire(previous);
      return;
    }
    await this.files.uploaded(fileId, [INVOICE_FILE_PURPOSE]);
    const folder = await this.documents.folderOf(clientId);
    await this.files.place([fileId], { entityType: 'client', entityId: clientId, folderId: folder?.id ?? null });
    const dated = await this.prisma.invoice.findUnique({ where: { id: invoiceId }, select: { invoiceDate: true } });
    await this.files.tag([fileId], { docType: 'staffing_invoice', docDate: dated?.invoiceDate ? formatDay(dated.invoiceDate) : null, links: [{ entityType: 'invoice', entityId: invoiceId }] });
    await this.prisma.invoice.update({ where: { id: invoiceId }, data: { fileId } });
    await this.files.retire(previous);
  }

  async create(dto: CreateInvoiceDto, user: AuthenticatedUser) {
    const client = await this.clientOrThrow(dto.clientId);
    if (!client.isActive) throw new UnprocessableEntityException({ code: 'client_stopped', message: 'This client has stopped.', fields: { clientId: 'validation.invalid' } });
    const party = await this.resolveParty(dto.counterpartyId, dto.otherClientId, client.id);
    const period = this.period(dto.periodFrom, dto.periodTo);
    const invoiceDate = this.optionalDay(dto.invoiceDate, 'invoiceDate');
    let dueDate = this.optionalDay(dto.dueDate, 'dueDate');
    if (dto.direction === 'incoming') {
      if (!invoiceDate) throw validationFailed({ invoiceDate: 'validation.required' });
      dueDate ??= addDays(invoiceDate, this.settings.get<number>(`${INVOICES_NAMESPACE}.paymentDays`));
    }
    const number = dto.direction === 'incoming' ? await this.assertIncomingNumber(client.id, party, dto.number) : null;
    const lines = await this.prepareLines(dto.lines, { direction: dto.direction, clientId: client.id, otherClientId: party.otherClientId, ...period });
    const money = this.amounts(dto, lines);
    const { doc, values } = await this.formValues(dto.values ?? {}, {}, user);
    const partyName = await this.partyName(party);

    const created = await this.prisma.$transaction(tx =>
      tx.invoice.create({
        data: {
          direction: dto.direction,
          kind: 'invoice',
          clientId: client.id,
          counterpartyId: party.counterpartyId,
          otherClientId: party.otherClientId,
          number,
          invoiceDate: invoiceDate ? parseDay(invoiceDate) : null,
          dueDate: dueDate ? parseDay(dueDate) : null,
          periodFrom: parseDay(period.periodFrom),
          periodTo: parseDay(period.periodTo),
          status: dto.direction === 'outgoing' ? 'draft' : 'received',
          vatPercent: new Prisma.Decimal(money.vatPercent),
          vatShifted: money.vatShifted,
          subtotal: new Prisma.Decimal(money.totals.subtotalCents).div(100),
          vatAmount: new Prisma.Decimal(money.totals.vatCents).div(100),
          total: new Prisma.Decimal(money.totals.totalCents).div(100),
          gAccountPercent: new Prisma.Decimal(money.gPercent),
          gAccountAmount: new Prisma.Decimal(money.totals.gAccountCents).div(100),
          locale: dto.locale ?? (this.settings.get<string>('locale.documentLocale') === 'en' ? 'en' : 'nl'),
          note: dto.note?.trim() ?? '',
          data: FormRecordsService.merge({}, this.records.encode(doc, values)) as Prisma.InputJsonObject,
          searchText: this.searchText([number, partyName, client.number, client.name, String(values.reference ?? ''), String(values.assignment ?? ''), dto.note]),
          createdById: user.id,
          lines: { create: this.lineData(lines) },
        },
      }),
    );
    if (dto.direction === 'incoming' && dto.fileId) await this.attachFile(created.id, client.id, dto.fileId, null);
    await this.audit.log({
      action: 'created',
      entityType: 'invoice',
      entityId: created.id,
      entityLabel: this.label(number, client.number, partyName),
      after: { direction: dto.direction, party: partyName, period: `${period.periodFrom} – ${period.periodTo}`, lines: lines.length, total: money.totals.totalCents / 100, ...this.records.auditSnapshot(doc, values) },
    });
    return this.one(created.id, user);
  }

  async update(id: string, dto: UpdateInvoiceDto, user: AuthenticatedUser) {
    const row = await this.detailRow(id);
    if (!this.allowed(row).edit) throw new ConflictException({ code: 'invoice_locked', message: 'This invoice can no longer be changed.' });
    const direction = row.direction as InvoiceDirection;
    const party =
      dto.counterpartyId !== undefined || dto.otherClientId !== undefined
        ? await this.resolveParty(dto.counterpartyId === undefined ? (dto.otherClientId ? null : row.counterpartyId) : dto.counterpartyId, dto.otherClientId === undefined ? (dto.counterpartyId ? null : row.otherClientId) : dto.otherClientId, row.clientId)
        : { counterpartyId: row.counterpartyId, otherClientId: row.otherClientId };
    const period = this.period(dto.periodFrom ?? formatDay(row.periodFrom), dto.periodTo ?? formatDay(row.periodTo));
    const invoiceDate = dto.invoiceDate === undefined ? (row.invoiceDate ? formatDay(row.invoiceDate) : null) : this.optionalDay(dto.invoiceDate, 'invoiceDate');
    const dueDate = dto.dueDate === undefined ? (row.dueDate ? formatDay(row.dueDate) : null) : this.optionalDay(dto.dueDate, 'dueDate');
    if (direction === 'incoming' && !invoiceDate) throw validationFailed({ invoiceDate: 'validation.required' });
    const number = direction === 'incoming' ? await this.assertIncomingNumber(row.clientId, party, dto.number ?? row.number ?? undefined, row.id) : row.number;

    const current = dto.lines
      ? await this.prepareLines(dto.lines, { direction, clientId: row.clientId, otherClientId: party.otherClientId, ...period })
      : row.lines.map<Prepared>(line => ({
          kind: line.kind as LineKind,
          employeeId: line.employeeId,
          rawName: line.rawName,
          description: line.description,
          fromDate: line.fromDate ? formatDay(line.fromDate) : null,
          toDate: line.toDate ? formatDay(line.toDate) : null,
          minutes: line.minutes,
          rateCents: line.rate === null ? null : toCents(line.rate.toNumber()),
          amountCents: toCents(line.amount.toNumber()),
        }));
    const money = this.amounts(dto, current, { vatPercent: row.vatPercent.toNumber(), vatShifted: row.vatShifted, gAccountPercent: row.gAccountPercent.toNumber() });
    const { doc, values } = await this.formValues(dto.values ?? {}, this.records.decode(asRecord(row.data)), user);
    const stored = FormRecordsService.merge(asRecord(row.data), this.records.encode(doc, values));
    const partyName = await this.partyName(party);
    const merged = { ...this.records.publicValues(asRecord(stored)) };

    await this.prisma.$transaction(async tx => {
      if (dto.lines) await tx.invoiceLine.deleteMany({ where: { invoiceId: id } });
      await tx.invoice.update({
        where: { id },
        data: {
          counterpartyId: party.counterpartyId,
          otherClientId: party.otherClientId,
          number,
          invoiceDate: invoiceDate ? parseDay(invoiceDate) : null,
          dueDate: dueDate ? parseDay(dueDate) : null,
          periodFrom: parseDay(period.periodFrom),
          periodTo: parseDay(period.periodTo),
          vatPercent: new Prisma.Decimal(money.vatPercent),
          vatShifted: money.vatShifted,
          subtotal: new Prisma.Decimal(money.totals.subtotalCents).div(100),
          vatAmount: new Prisma.Decimal(money.totals.vatCents).div(100),
          total: new Prisma.Decimal(money.totals.totalCents).div(100),
          gAccountPercent: new Prisma.Decimal(money.gPercent),
          gAccountAmount: new Prisma.Decimal(money.totals.gAccountCents).div(100),
          ...(dto.locale && { locale: dto.locale }),
          ...(dto.note !== undefined && { note: dto.note.trim() }),
          data: stored as Prisma.InputJsonObject,
          searchText: this.searchText([number, partyName, row.client.number, row.client.name, String(merged.reference ?? ''), String(merged.assignment ?? ''), dto.note ?? row.note]),
          ...(dto.lines && { lines: { create: this.lineData(current) } }),
        },
      });
    });
    if (direction === 'incoming' && dto.fileId !== undefined) await this.attachFile(id, row.clientId, dto.fileId, row.fileId);
    await this.audit.log({
      action: 'updated',
      entityType: 'invoice',
      entityId: id,
      entityLabel: this.label(number, row.client.number, partyName),
      before: { total: row.total.toNumber(), lines: row.lines.length },
      after: { total: money.totals.totalCents / 100, lines: current.length },
    });
    return this.one(id, user);
  }

  /** A draft that was never issued has no legal standing: it can simply be deleted. */
  async remove(id: string) {
    const row = await this.detailRow(id);
    if (!this.allowed(row).remove) throw new ConflictException({ code: 'invoice_locked', message: 'Only a draft can be deleted.' });
    await this.prisma.invoice.delete({ where: { id } });
    await this.audit.log({ action: 'deleted', entityType: 'invoice', entityId: id, entityLabel: this.label(row.number, row.client.number, partyLabel(partyOf(row))), before: { total: row.total.toNumber(), lines: row.lines.length } });
    return { deleted: true };
  }

  /* ── The life of an invoice ───────────────────────────────────────────────────────────────────────────────────── */

  /**
   * Issues an outgoing draft: it gets its number (the client's next one, or a free one typed), its dates, a Word and a PDF, and closes the days it bills.
   * Lines that bill more than is registered, or name nobody, need a reason.
   */
  async issue(id: string, dto: IssueInvoiceDto, user: AuthenticatedUser) {
    const row = await this.detailRow(id);
    if (!this.allowed(row).issue) throw new ConflictException({ code: 'invoice_not_draft', message: 'Only a draft can be issued.' });
    const coverage = await this.reconciliation.lineCoverage(id);
    const issues = this.issuesOf(row.lines.filter(line => line.kind === 'hours').map(line => ({ employee: line.employee, coverage: coverage.get(line.id) ?? null })));
    const reason = dto.reason?.trim() ?? '';
    if (issues.length && !reason) {
      throw new UnprocessableEntityException({ code: 'invoice_mismatch', message: 'Some lines do not match the registered hours. Give a reason to issue the invoice anyway.', fields: { reason: 'validation.required' }, details: { issues } });
    }
    const today = todayInAmsterdam();
    const invoiceDate = this.optionalDay(dto.invoiceDate, 'invoiceDate') ?? today;
    const dueDate = this.optionalDay(dto.dueDate, 'dueDate') ?? addDays(invoiceDate, this.settings.get<number>(`${INVOICES_NAMESPACE}.paymentDays`));
    if (dueDate < invoiceDate) throw validationFailed({ dueDate: 'validation.endBeforeStart' });
    const partyName = partyLabel(partyOf(row));
    const lockLines = this.lockLines(row);

    const number = await this.prisma.$transaction(async tx => {
      const given = dto.number?.trim() ? await this.numbering.claim(tx, row.clientId, dto.number, invoiceDate, row.id) : await this.numbering.allocate(tx, row.clientId, invoiceDate);
      await tx.invoice.update({
        where: { id },
        data: {
          number: given,
          invoiceDate: parseDay(invoiceDate),
          dueDate: parseDay(dueDate),
          status: 'sent',
          issuedAt: new Date(),
          issuedById: user.id,
          note: [row.note, reason].filter(Boolean).join(' · '),
          searchText: this.searchText([given, partyName, row.client.number, row.client.name, String(asRecord(row.data).reference ?? ''), String(asRecord(row.data).assignment ?? '')]),
        },
      });
      await this.locks.lockForInvoice(tx, { id, lines: lockLines }, user.id);
      return given;
    });

    let made: { word: boolean; pdf: boolean } = { word: false, pdf: false };
    try {
      made = await this.documents.make(id, await this.tableOf(id, row.locale === 'en' ? 'en' : 'nl'), user);
    } catch (error) {
      // The invoice stands; the documents can be made again from its page.
      this.logger.warn(`The documents of invoice ${id} could not be made: ${(error as Error).message}`);
    }
    await this.audit.log({
      action: 'issued',
      entityType: 'invoice',
      entityId: id,
      entityLabel: this.label(number, row.client.number, partyName),
      before: { status: 'draft' },
      after: { status: 'sent', number, invoiceDate, dueDate, total: row.total.toNumber() },
      meta: { word: made.word, pdf: made.pdf, ...(issues.length && { reason, issues: issues.map(issue => issue.code) }) },
    });
    return this.one(id, user);
  }

  /** Moves an invoice along: received → checked (the hours match, or a reason) → paid; sent → paid; and back again when somebody made a mistake. */
  async transition(id: string, dto: InvoiceStatusDto, user: AuthenticatedUser) {
    const row = await this.detailRow(id);
    const from = row.status as InvoiceStatus;
    const to = dto.status as InvoiceStatus;
    if (!this.allowed(row).next.includes(to)) throw new ConflictException({ code: 'invoice_status_change', message: 'This invoice cannot move to that status.' });
    const direction = row.direction as InvoiceDirection;
    const label = this.label(row.number, row.client.number, partyLabel(partyOf(row)));
    const needsApprove = to === 'checked' || (to === 'received' && from === 'checked') || (to === 'received' && from === 'paid');
    if (needsApprove && !matrixAllows(user.matrix, `${AREA}.approve`)) throw new ForbiddenException({ code: 'forbidden', message: 'You may not do this.' });

    const data: Prisma.InvoiceUpdateInput = { status: to };
    let after: Record<string, unknown> = { status: to };
    let reason = '';
    if (to === 'paid') {
      const paidOn = this.optionalDay(dto.paidOn, 'paidOn') ?? todayInAmsterdam();
      data.paidOn = parseDay(paidOn);
      after = { ...after, paidOn };
    } else {
      data.paidOn = null;
    }
    const lockLines = this.lockLines(row);
    if (to === 'checked') {
      const lines = row.lines.filter(line => line.kind === 'hours');
      if (lines.some(line => !line.employeeId)) throw new UnprocessableEntityException({ code: 'invoice_unmatched', message: 'Every line needs a worker before the invoice can be checked.', details: { count: lines.filter(line => !line.employeeId).length } });
      const coverage = await this.reconciliation.lineCoverage(id);
      const issues = this.issuesOf(lines.map(line => ({ employee: line.employee, coverage: coverage.get(line.id) ?? null })));
      reason = dto.reason?.trim() ?? '';
      if (issues.length && !reason) {
        throw new UnprocessableEntityException({ code: 'invoice_mismatch', message: 'Some lines bill more than is registered. Give a reason to mark the invoice as checked anyway.', fields: { reason: 'validation.required' }, details: { issues } });
      }
      if (reason) data.note = [row.note, reason].filter(Boolean).join(' · ');
    }

    await this.prisma.$transaction(async tx => {
      await tx.invoice.update({ where: { id }, data });
      if (to === 'checked' && direction === 'incoming') await this.locks.lockForInvoice(tx, { id, lines: lockLines }, user.id);
      if (to === 'received') await this.locks.unlockInvoice(tx, id);
    });
    await this.audit.log({ action: 'updated', entityType: 'invoice', entityId: id, entityLabel: label, before: { status: from }, after, ...(reason && { meta: { reason } }) });
    return this.one(id, user);
  }

  /** An invoice that came in by mistake (or that the company withdrew) is cancelled with a reason; its days are open again. */
  async cancel(id: string, dto: CancelInvoiceDto, user: AuthenticatedUser) {
    const row = await this.detailRow(id);
    if (!this.allowed(row).cancel) throw new ConflictException({ code: 'invoice_credit_needed', message: 'An invoice that was issued is taken back with a credit note.' });
    const reason = dto.reason?.trim() ?? '';
    if (!reason) throw validationFailed({ reason: 'validation.required' });
    await this.prisma.$transaction(async tx => {
      await tx.invoice.update({ where: { id }, data: { status: 'cancelled', cancelledAt: new Date(), cancelledById: user.id, cancelReason: reason, paidOn: null } });
      await this.locks.unlockInvoice(tx, id);
    });
    await this.audit.log({ action: 'cancelled', entityType: 'invoice', entityId: id, entityLabel: this.label(row.number, row.client.number, partyLabel(partyOf(row))), before: { status: row.status }, after: { status: 'cancelled' }, meta: { reason } });
    return this.one(id, user);
  }

  /**
   * A credit note takes a whole invoice back: the same lines with the opposite sign. An outgoing one is issued at once (next number, documents); for an
   * incoming one the number on the company's own credit note is typed. Neither the invoice nor its credit note counts as invoiced hours any more.
   */
  async credit(id: string, dto: CreditInvoiceDto, user: AuthenticatedUser) {
    const row = await this.detailRow(id);
    if (!this.allowed(row).credit) throw new ConflictException({ code: 'invoice_not_creditable', message: 'This invoice cannot be credited.' });
    const reason = dto.reason?.trim() ?? '';
    if (!reason) throw validationFailed({ reason: 'validation.required' });
    const direction = row.direction as InvoiceDirection;
    const day = this.optionalDay(dto.invoiceDate, 'invoiceDate') ?? todayInAmsterdam();
    const party = { counterpartyId: row.counterpartyId, otherClientId: row.otherClientId };
    const typed = direction === 'incoming' ? await this.assertIncomingNumber(row.clientId, party, dto.number) : null;
    const partyName = partyLabel(partyOf(row));

    const created = await this.prisma.$transaction(async tx => {
      const number = direction === 'incoming' ? (typed as string) : dto.number?.trim() ? await this.numbering.claim(tx, row.clientId, dto.number, day) : await this.numbering.allocate(tx, row.clientId, day);
      const credit = await tx.invoice.create({
        data: {
          direction,
          kind: 'credit',
          clientId: row.clientId,
          counterpartyId: row.counterpartyId,
          otherClientId: row.otherClientId,
          creditOfId: row.id,
          number,
          invoiceDate: parseDay(day),
          dueDate: parseDay(day),
          periodFrom: row.periodFrom,
          periodTo: row.periodTo,
          status: direction === 'outgoing' ? 'sent' : 'received',
          vatPercent: row.vatPercent,
          vatShifted: row.vatShifted,
          subtotal: row.subtotal.negated(),
          vatAmount: row.vatAmount.negated(),
          total: row.total.negated(),
          gAccountPercent: row.gAccountPercent,
          gAccountAmount: row.gAccountAmount.negated(),
          locale: row.locale,
          note: reason,
          data: row.data as Prisma.InputJsonObject,
          searchText: this.searchText([number, partyName, row.client.number, row.client.name, 'credit creditnota']),
          issuedAt: direction === 'outgoing' ? new Date() : null,
          issuedById: direction === 'outgoing' ? user.id : null,
          createdById: user.id,
          lines: {
            create: row.lines.map((line, index) => ({
              sortOrder: index,
              kind: line.kind,
              employeeId: line.employeeId,
              rawName: line.rawName,
              description: line.description,
              fromDate: line.fromDate,
              toDate: line.toDate,
              minutes: -line.minutes,
              rate: line.rate,
              amount: line.amount.negated(),
            })),
          },
        },
      });
      await this.locks.unlockInvoice(tx, row.id);
      return credit;
    });

    let made: { word: boolean; pdf: boolean } = { word: false, pdf: false };
    if (direction === 'outgoing') {
      try {
        made = await this.documents.make(created.id, await this.tableOf(created.id, row.locale === 'en' ? 'en' : 'nl'), user);
      } catch (error) {
        this.logger.warn(`The documents of credit note ${created.id} could not be made: ${(error as Error).message}`);
      }
    }
    await this.audit.log({ action: 'credited', entityType: 'invoice', entityId: row.id, entityLabel: this.label(row.number, row.client.number, partyName), before: { status: row.status }, after: { creditNote: created.number }, meta: { reason, creditId: created.id } });
    await this.audit.log({ action: 'created', entityType: 'invoice', entityId: created.id, entityLabel: this.label(created.number, row.client.number, partyName), after: { kind: 'credit', creditOf: row.number, total: created.total.toNumber() }, meta: { reason, word: made.word, pdf: made.pdf } });
    return this.one(created.id, user);
  }

  /** Makes the Word and PDF of an issued invoice again (the template changed, or LibreOffice was not there the first time). */
  async makeDocuments(id: string, user: AuthenticatedUser) {
    const row = await this.detailRow(id);
    if (!this.allowed(row).documents) throw new ConflictException({ code: 'invoice_no_documents', message: 'Only an issued invoice has documents.' });
    const made = await this.documents.make(id, await this.tableOf(id, row.locale === 'en' ? 'en' : 'nl'), user);
    await this.audit.log({ action: 'generated', entityType: 'invoice', entityId: id, entityLabel: this.label(row.number, row.client.number, partyLabel(partyOf(row))), meta: { pdf: made.pdf, template: made.template?.name ?? null } });
    return this.one(id, user);
  }

  private lockLines(row: DetailRow) {
    return row.lines.filter(line => line.kind === 'hours').map(line => ({ employeeId: line.employeeId, from: line.fromDate ? formatDay(line.fromDate) : null, to: line.toDate ? formatDay(line.toDate) : null }));
  }

  private label(number: string | null, clientNumber: string, partyName: string): string {
    return `${number ?? 'concept'} · ${clientNumber} · ${partyName}`;
  }

  private async partyName(party: { counterpartyId: string | null; otherClientId: string | null }): Promise<string> {
    if (party.counterpartyId) return (await this.prisma.counterparty.findUniqueOrThrow({ where: { id: party.counterpartyId }, select: { name: true } })).name;
    const client = await this.prisma.client.findUniqueOrThrow({ where: { id: party.otherClientId as string }, select: { number: true, name: true } });
    return `${client.number} – ${client.name}`;
  }

  /* ── Exports ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  /** One invoice as a table: its lines and its totals (also what the document falls back to when no template can be filled). */
  async tableOf(id: string, locale: AppLocale): Promise<ExportTable> {
    const row = await this.detailRow(id);
    const nl = locale === 'nl';
    const credit = row.kind === 'credit';
    const party = partyLabel(partyOf(row));
    const rows: Array<Record<string, unknown>> = row.lines.map(line => ({
      description: [line.employee ? personName(line.employee.person) : line.rawName, line.description].filter(Boolean).join(' – '),
      period: line.fromDate && line.toDate ? `${formatDay(line.fromDate)} – ${formatDay(line.toDate)}` : '',
      hours: line.kind === 'hours' ? minutesToHours(line.minutes) : '',
      rate: line.rate ? euros(line.rate) : '',
      amount: euros(line.amount),
    }));
    rows.push({ description: nl ? 'Totaal van de regels' : 'Total of the lines', amount: euros(row.subtotal) });
    if (!row.vatShifted) rows.push({ description: `${nl ? 'BTW' : 'VAT'} ${row.vatPercent.toNumber()}%`, amount: euros(row.vatAmount) });
    else rows.push({ description: nl ? 'BTW verlegd' : 'VAT reverse-charged', amount: 0 });
    rows.push({ description: nl ? 'Totaal' : 'Total', amount: euros(row.total) });
    if (euros(row.gAccountAmount) !== 0) rows.push({ description: nl ? 'Waarvan naar de G-rekening' : 'Of which to the G-account', amount: euros(row.gAccountAmount) });
    return {
      title: `${credit ? (nl ? 'Creditnota' : 'Credit note') : nl ? 'Factuur' : 'Invoice'} ${row.number ?? ''}`.trim(),
      subtitle: `${row.client.number} – ${row.client.name} · ${party} · ${formatDay(row.periodFrom)} – ${formatDay(row.periodTo)}`,
      locale,
      columns: [
        { key: 'description', header: nl ? 'Omschrijving' : 'Description', width: 40 },
        { key: 'period', header: nl ? 'Periode' : 'Period', width: 24 },
        { key: 'hours', header: nl ? 'Uren' : 'Hours', type: 'number', width: 10 },
        { key: 'rate', header: nl ? 'Tarief' : 'Rate', type: 'money', width: 12 },
        { key: 'amount', header: nl ? 'Bedrag' : 'Amount', type: 'money', width: 14 },
      ],
      rows,
    };
  }

  /** The invoices a list shows (every one that matches, not just the page), as a table for Excel, PDF or Word. */
  async listTable(query: InvoiceExportQuery, locale: AppLocale): Promise<ExportTable> {
    const where = this.listWhere(query);
    this.exports.assertSize(await this.prisma.invoice.count({ where }));
    const rows = await this.prisma.invoice.findMany({ where, include: LIST_INCLUDE, orderBy: [{ invoiceDate: { sort: 'desc', nulls: 'first' } }, { createdAt: 'desc' }] });
    const today = todayInAmsterdam();
    const nl = locale === 'nl';
    const statusText: Record<string, { nl: string; en: string }> = {
      draft: { nl: 'Concept', en: 'Draft' },
      sent: { nl: 'Verstuurd', en: 'Sent' },
      received: { nl: 'Ontvangen', en: 'Received' },
      checked: { nl: 'Gecontroleerd', en: 'Checked' },
      paid: { nl: 'Betaald', en: 'Paid' },
      cancelled: { nl: 'Geannuleerd', en: 'Cancelled' },
    };
    return {
      title: nl ? 'Facturen' : 'Invoices',
      subtitle: [query.direction ? (nl ? (query.direction === 'incoming' ? 'Inkomend' : 'Uitgaand') : query.direction === 'incoming' ? 'Incoming' : 'Outgoing') : '', query.month ?? ''].filter(Boolean).join(' · ') || undefined,
      locale,
      columns: [
        { key: 'number', header: nl ? 'Nummer' : 'Number', width: 14 },
        { key: 'direction', header: nl ? 'Richting' : 'Direction', width: 11 },
        { key: 'client', header: nl ? 'Klant' : 'Client', width: 26 },
        { key: 'party', header: nl ? 'Bedrijf' : 'Company', width: 28 },
        { key: 'date', header: nl ? 'Factuurdatum' : 'Invoice date', type: 'date', width: 12 },
        { key: 'due', header: nl ? 'Vervaldatum' : 'Due date', type: 'date', width: 12 },
        { key: 'period', header: nl ? 'Periode' : 'Period', width: 24 },
        { key: 'hours', header: nl ? 'Uren' : 'Hours', type: 'number', width: 8 },
        { key: 'subtotal', header: nl ? 'Excl. btw' : 'Excl. VAT', type: 'money', width: 12 },
        { key: 'total', header: nl ? 'Incl. btw' : 'Incl. VAT', type: 'money', width: 12 },
        { key: 'status', header: nl ? 'Status' : 'Status', width: 14 },
        { key: 'paid', header: nl ? 'Betaald op' : 'Paid on', type: 'date', width: 12 },
      ],
      rows: rows.map(row => {
        const view = listView(row, today);
        return {
          number: view.number ?? '',
          direction: view.direction === 'incoming' ? (nl ? 'Inkomend' : 'Incoming') : nl ? 'Uitgaand' : 'Outgoing',
          client: `${view.client.number} – ${view.client.name}`,
          party: partyLabel(view.party),
          date: view.invoiceDate,
          due: view.dueDate,
          period: `${view.periodFrom} – ${view.periodTo}`,
          hours: minutesToHours(view.minutes),
          subtotal: view.subtotal,
          total: view.total,
          status: `${view.kind === 'credit' ? (nl ? 'Creditnota · ' : 'Credit note · ') : ''}${statusText[view.status]?.[nl ? 'nl' : 'en'] ?? view.status}`,
          paid: view.paidOn,
        };
      }),
    };
  }
}
