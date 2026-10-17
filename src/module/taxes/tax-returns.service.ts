import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ApiResult, paged } from '../../common/api-result.js';
import { addDays, daysBetween, formatDay, isValidDay, parseDay, todayInAmsterdam } from '../../common/dates.js';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import { pageMeta, toSkipTake } from '../../common/pagination.js';
import { fold } from '../../common/text.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { validationFailed } from '../../common/validation/failure.js';
import { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import type { ExportTable } from '../../lib/exports/export.types.js';
import { ExportsService } from '../../lib/exports/exports.service.js';
import { personName } from '../people/person-record.js';
import type { ActiveDto, CreateReturnDto, ExtensionDto, GenerateReturnsDto, ReturnExportQuery, ReturnListQuery, UpdateReturnDto } from './dto/taxes.dto.js';
import { TaxDeadlinesService } from './tax-deadlines.service.js';
import { TaxListsService } from './tax-lists.service.js';
import { calendarYear } from './tax-periods.js';
import {
  CLIENT_FIELDS,
  EXTENSION_FORM_CODE,
  FILED_RETURN_STATUSES,
  INCOME_TAX_ROLES,
  OPEN_RETURN_STATUSES,
  RETURN_KINDS,
  TAX_RETURN_ENTITY,
  type ExtensionStatus,
  type ReturnKind,
} from './taxes.constants.js';

const RETURN_INCLUDE = {
  client: { select: { id: true, number: true, name: true, isActive: true, responsibleUserId: true } },
  person: { select: { id: true, firstName: true, lastName: true, data: true } },
} satisfies Prisma.TaxReturnInclude;
type ReturnRow = Prisma.TaxReturnGetPayload<{ include: typeof RETURN_INCLUDE }>;

const SORTS: Record<string, (direction: 'asc' | 'desc') => Prisma.TaxReturnOrderByWithRelationInput> = {
  number: direction => ({ client: { number: direction } }),
  client: direction => ({ client: { name: direction } }),
  person: direction => ({ person: { lastName: direction } }),
  taxYear: direction => ({ taxYear: direction }),
  status: direction => ({ status: direction }),
  filedOn: direction => ({ filedOn: { sort: direction, nulls: 'last' } }),
  extensionUntil: direction => ({ extensionUntil: { sort: direction, nulls: 'last' } }),
};

const day = (value: Date | null): string | null => (value ? formatDay(value) : null);
const split = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);

const isKind = (value: string): value is ReturnKind => (RETURN_KINDS as readonly string[]).includes(value);

/**
 * The yearly returns of the office's clients: income tax (IB) of an owner or a partner, corporate income tax (VPB) of a company. Each has a status, a deadline worked out from the
 * year and the Dutch calendar, the day it was filed, the filed return (a document of the client) and — when the deadline is moved — an extension that was asked for, granted or
 * refused. The rows of a year are made for the clients that have income tax / corporate tax switched on in their record.
 */
@Injectable()
export class TaxReturnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly deadlines: TaxDeadlinesService,
    private readonly lists: TaxListsService,
    private readonly exports: ExportsService,
  ) {}

  /* ── Reading ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  async rowOrThrow(id: string): Promise<ReturnRow> {
    const row = await this.prisma.taxReturn.findUnique({ where: { id }, include: RETURN_INCLUDE });
    if (!row) throw new NotFoundException({ code: 'not_found', message: 'Return not found' });
    return row;
  }

  /** "042 Bakkerij – Inkomstenbelasting 2025 (J. Jansen)": the label the audit log uses. */
  label(row: Pick<ReturnRow, 'client' | 'kind' | 'taxYear' | 'person'>): string {
    const kind = row.kind === 'income_tax' ? 'Inkomstenbelasting' : 'Vennootschapsbelasting';
    return `${row.client.number} ${row.client.name} – ${kind} ${row.taxYear}${row.person ? ` (${personName(row.person)})` : ''}`;
  }

  /** The statutory deadline and the one that counts (the extension, once it is granted). */
  deadlineOf(row: Pick<ReturnRow, 'kind' | 'taxYear' | 'periodEnd' | 'clientId' | 'extensionStatus' | 'extensionUntil'>): { statutory: string; effective: string } {
    const statutory = this.deadlines.returnDue(row.kind as ReturnKind, { taxYear: row.taxYear, periodEnd: formatDay(row.periodEnd) }, row.clientId);
    const until = day(row.extensionUntil);
    const granted = row.extensionStatus === 'granted' && until !== null && until > statutory;
    return { statutory, effective: granted ? until : statutory };
  }

  async views(rows: readonly ReturnRow[], locale: AppLocale, today = todayInAmsterdam()) {
    if (!rows.length) return [];
    const clientIds = [...new Set(rows.map(row => row.clientId))];
    const fileIds = [...new Set(rows.map(row => row.fileId).filter((id): id is string => Boolean(id)))];
    const userIds = [...new Set(rows.map(row => row.assigneeId).filter((id): id is string => Boolean(id)))];
    const [statuses, extensions, files, users, forms] = await Promise.all([
      this.lists.names('tax_return_status', locale),
      this.lists.names('tax_extension_status', locale),
      fileIds.length ? this.prisma.storedFile.findMany({ where: { id: { in: fileIds } }, select: { id: true, name: true } }) : [],
      userIds.length ? this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [],
      this.prisma.formSubmission.findMany({
        where: { clientId: { in: clientIds }, form: { code: EXTENSION_FORM_CODE }, status: { not: 'cancelled' }, isActive: true },
        select: { id: true, clientId: true, status: true, preparedOn: true, sentOn: true, doneOn: true, periodStart: true, fileId: true },
        orderBy: { preparedOn: 'desc' },
      }),
    ]);
    const fileName = new Map(files.map(file => [file.id, file.name]));
    const userName = new Map(users.map(user => [user.id, user.name]));
    return rows.map(row => {
      const { statutory, effective } = this.deadlineOf(row);
      const open = OPEN_RETURN_STATUSES.includes(row.status);
      // The form that asked for the extension: the one the person linked, else the latest one made for this client in the year of the return.
      const submission = forms.find(form => form.id === row.extensionSubmissionId) ?? forms.find(form => form.clientId === row.clientId && form.periodStart !== null && form.periodStart.getUTCFullYear() === row.taxYear);
      return {
        id: row.id,
        kind: row.kind,
        client: { id: row.client.id, number: row.client.number, name: row.client.name, isActive: row.client.isActive },
        person: row.person ? { id: row.person.id, name: personName(row.person) } : null,
        taxYear: row.taxYear,
        periodStart: formatDay(row.periodStart),
        periodEnd: formatDay(row.periodEnd),
        status: row.status,
        statusName: statuses.get(row.status) ?? row.status,
        open,
        assignee: row.assigneeId ? { id: row.assigneeId, name: userName.get(row.assigneeId) ?? '' } : null,
        statutoryDue: statutory,
        deadline: effective,
        daysLeft: daysBetween(today, effective),
        overdue: row.isActive && open && effective < today,
        filedOn: day(row.filedOn),
        file: row.fileId ? { id: row.fileId, name: fileName.get(row.fileId) ?? '' } : null,
        extension: row.extensionStatus
          ? {
              status: row.extensionStatus,
              statusName: extensions.get(row.extensionStatus) ?? row.extensionStatus,
              requestedOn: day(row.extensionRequestedOn),
              until: day(row.extensionUntil),
              form: submission ? { id: submission.id, status: submission.status, preparedOn: formatDay(submission.preparedOn), sentOn: day(submission.sentOn), doneOn: day(submission.doneOn), fileId: submission.fileId } : null,
            }
          : null,
        note: row.note,
        isActive: row.isActive,
        deactivationReason: row.deactivationReason,
        createdAt: row.createdAt.toISOString(),
      };
    });
  }

  private where(query: Partial<ReturnListQuery>): Prisma.TaxReturnWhereInput {
    const terms = fold(query.search ?? '').split(' ').filter(Boolean).slice(0, 6);
    const state = query.state ?? 'active';
    const statuses = split(query.status);
    const and: Prisma.TaxReturnWhereInput[] = terms.map(term => ({
      OR: [{ client: { searchText: { contains: term } } }, { client: { number: { contains: term, mode: 'insensitive' } } }, { person: { searchText: { contains: term } } }],
    }));
    if (query.extension === 'any') and.push({ extensionStatus: { not: null } });
    else if (query.extension === 'none') and.push({ extensionStatus: null });
    else if (query.extension) and.push({ extensionStatus: query.extension });
    return {
      ...(query.kind && { kind: query.kind }),
      ...(query.taxYear && { taxYear: Number(query.taxYear) }),
      ...(query.clientId && { clientId: query.clientId }),
      ...(query.personId && { personId: query.personId }),
      ...(query.assigneeId && { assigneeId: query.assigneeId }),
      ...(state !== 'all' && { isActive: state === 'active' }),
      ...(statuses.length && { status: { in: statuses } }),
      ...(query.open && { status: { in: [...OPEN_RETURN_STATUSES] } }),
      AND: and,
    };
  }

  private orderBy(sort: string | undefined): Prisma.TaxReturnOrderByWithRelationInput[] {
    const order = split(sort)
      .map(part => part.split(':') as [string, string?])
      .filter(([key]) => key in SORTS)
      .map(([key, direction]) => SORTS[key]!(direction === 'desc' ? 'desc' : 'asc'));
    return [...(order.length ? order : [{ taxYear: 'desc' as const }, { client: { number: 'asc' as const } }]), { createdAt: 'asc' }];
  }

  /** The ids of the rows that match `due` (past their deadline, or due within a month): the deadline depends on the calendar, so it is worked out here. */
  private async dueIds(where: Prisma.TaxReturnWhereInput, due: string, today: string): Promise<string[]> {
    const rows = await this.prisma.taxReturn.findMany({ where: { AND: [where, { status: { in: [...OPEN_RETURN_STATUSES] } }] }, include: RETURN_INCLUDE });
    const limit = addDays(today, 30);
    return rows
      .filter(row => {
        const { effective } = this.deadlineOf(row);
        return due === 'overdue' ? effective < today : effective >= today && effective <= limit;
      })
      .map(row => row.id);
  }

  async list(query: ReturnListQuery, locale: AppLocale): Promise<ApiResult> {
    const today = todayInAmsterdam();
    let where = this.where(query);
    if (query.due) where = { AND: [where, { id: { in: await this.dueIds(where, query.due, today) } }] };
    const [total, rows] = await Promise.all([
      this.prisma.taxReturn.count({ where }),
      this.prisma.taxReturn.findMany({ where, orderBy: this.orderBy(query.sort), include: RETURN_INCLUDE, ...toSkipTake(query) }),
    ]);
    const extra: Record<string, unknown> = {};
    if (query.stats) {
      extra.stats = await this.stats(query, today);
      extra.years = await this.years(query.kind);
      extra.defaultYear = this.defaultYear(today);
    }
    return paged(await this.views(rows, locale, today), pageMeta(total, query, extra));
  }

  /** The counters above the list: how many returns, how many are still to be filed, how many are filed, how many are late and how many extensions are going on. */
  private async stats(query: ReturnListQuery, today: string) {
    const rows = await this.prisma.taxReturn.findMany({ where: this.where({ ...query, status: undefined, open: undefined, due: undefined, extension: undefined }), include: RETURN_INCLUDE });
    let open = 0;
    let filed = 0;
    let overdue = 0;
    let requested = 0;
    let granted = 0;
    for (const row of rows) {
      if (OPEN_RETURN_STATUSES.includes(row.status)) {
        open += 1;
        if (this.deadlineOf(row).effective < today) overdue += 1;
      } else if (FILED_RETURN_STATUSES.includes(row.status)) filed += 1;
      if (row.extensionStatus === 'requested') requested += 1;
      if (row.extensionStatus === 'granted') granted += 1;
    }
    return { total: rows.length, open, filed, overdue, extensionRequested: requested, extensionGranted: granted };
  }

  /** The tax years that have returns (newest first), and the one that is being worked on: the year that just ended. */
  private async years(kind: string | undefined): Promise<number[]> {
    const found = await this.prisma.taxReturn.groupBy({ by: ['taxYear'], where: { ...(kind && { kind }), isActive: true } });
    return [...new Set([...found.map(entry => entry.taxYear), Number(todayInAmsterdam().slice(0, 4)) - 1])].sort((a, b) => b - a);
  }

  private defaultYear(today: string): number {
    return Number(today.slice(0, 4)) - 1;
  }

  async one(id: string, locale: AppLocale) {
    return (await this.views([await this.rowOrThrow(id)], locale))[0]!;
  }

  /* ── Making returns ───────────────────────────────────────────────────────────────────────────────────────────── */

  private assertEditable(row: ReturnRow): void {
    if (!row.isActive) throw new ConflictException({ code: 'tax_return_inactive', message: 'This return is switched off.' });
  }

  async create(dto: CreateReturnDto, user: AuthenticatedUser, locale: AppLocale) {
    const problems: Record<string, string> = {};
    if (!isKind(dto.kind)) problems.kind = 'validation.selectOption';
    const client = await this.prisma.client.findUnique({ where: { id: dto.clientId }, select: { id: true, number: true, name: true, responsibleUserId: true } });
    if (!client) problems.clientId = 'validation.invalid';
    const kind = dto.kind as ReturnKind;
    let personId: string | null = null;
    if (kind === 'income_tax' && dto.personId) {
      const linked = await this.prisma.clientPerson.findFirst({ where: { clientId: dto.clientId, personId: dto.personId }, select: { personId: true } });
      if (!linked) problems.personId = 'validation.invalid';
      else personId = linked.personId;
    }
    const year = calendarYear(dto.taxYear);
    let periodStart = year.start;
    let periodEnd = year.end;
    if (kind === 'corporate_tax' && (dto.periodStart || dto.periodEnd)) {
      periodStart = dto.periodStart ?? year.start;
      periodEnd = dto.periodEnd ?? year.end;
      if (!isValidDay(periodStart)) problems.periodStart = 'validation.invalid';
      if (!isValidDay(periodEnd)) problems.periodEnd = 'validation.invalid';
      if (!problems.periodStart && !problems.periodEnd && periodEnd < periodStart) problems.periodEnd = 'validation.endBeforeStart';
    }
    if (Object.keys(problems).length) throw validationFailed(problems);

    const existing = await this.prisma.taxReturn.findFirst({ where: { kind, clientId: dto.clientId, personId, taxYear: dto.taxYear }, select: { id: true } });
    if (existing) throw new ConflictException({ code: 'tax_return_exists', message: 'This return exists already.', details: { existing: { id: existing.id } } });

    const created = await this.prisma.taxReturn.create({
      data: { kind, clientId: dto.clientId, personId, taxYear: dto.taxYear, periodStart: parseDay(periodStart), periodEnd: parseDay(periodEnd), assigneeId: client!.responsibleUserId, note: dto.note?.trim() ?? '', createdById: user.id },
      include: RETURN_INCLUDE,
    });
    await this.audit.log({ action: 'created', entityType: TAX_RETURN_ENTITY, entityId: created.id, entityLabel: this.label(created), after: { kind, taxYear: dto.taxYear, personId, periodStart, periodEnd } });
    return (await this.views([created], locale))[0]!;
  }

  /**
   * Makes the returns of one tax year for every active client that has income tax (or corporate tax) switched on in their record — income tax one per owner or partner who
   * was there that year, corporate tax one per client. Returns that exist already are left alone.
   */
  async generate(dto: Pick<GenerateReturnsDto, 'kind' | 'taxYear'>, source: 'automatic' | 'manual'): Promise<{ created: number; withoutPerson: number }> {
    if (!isKind(dto.kind)) throw validationFailed({ kind: 'validation.selectOption' });
    const kind = dto.kind;
    const field = kind === 'income_tax' ? CLIENT_FIELDS.incomeTax : CLIENT_FIELDS.corporateTax;
    const year = calendarYear(dto.taxYear);
    const clients = await this.prisma.client.findMany({
      where: { isActive: true, data: { path: [field], equals: true } },
      select: {
        id: true,
        responsibleUserId: true,
        people: { where: { role: { in: [...INCOME_TAX_ROLES] }, OR: [{ endedOn: null }, { endedOn: { gte: parseDay(year.start) } }], AND: [{ OR: [{ startedOn: null }, { startedOn: { lte: parseDay(year.end) } }] }] }, select: { personId: true } },
      },
    });
    if (!clients.length) return { created: 0, withoutPerson: 0 };
    const existing = await this.prisma.taxReturn.findMany({ where: { kind, taxYear: dto.taxYear, clientId: { in: clients.map(client => client.id) } }, select: { clientId: true, personId: true } });
    const have = new Set(existing.map(row => `${row.clientId}:${row.personId ?? ''}`));
    const haveAny = new Set(existing.map(row => row.clientId));
    const data: Prisma.TaxReturnCreateManyInput[] = [];
    let withoutPerson = 0;
    for (const client of clients) {
      const base = { kind, clientId: client.id, taxYear: dto.taxYear, periodStart: parseDay(year.start), periodEnd: parseDay(year.end), assigneeId: client.responsibleUserId };
      if (kind === 'corporate_tax') {
        if (!have.has(`${client.id}:`)) data.push({ ...base, personId: null });
        continue;
      }
      const people = [...new Set(client.people.map(link => link.personId))];
      if (!people.length) {
        // No owner or partner is recorded: one return without a person, so the client is not forgotten (a person can be chosen afterwards).
        if (!haveAny.has(client.id)) {
          data.push({ ...base, personId: null });
          withoutPerson += 1;
        }
        continue;
      }
      for (const personId of people) if (!have.has(`${client.id}:${personId}`)) data.push({ ...base, personId });
    }
    if (!data.length) return { created: 0, withoutPerson: 0 };
    const made = await this.prisma.taxReturn.createMany({ data, skipDuplicates: true });
    if (made.count) {
      await this.audit.log({
        action: 'created',
        entityType: TAX_RETURN_ENTITY,
        entityLabel: `${kind === 'income_tax' ? 'Inkomstenbelasting' : 'Vennootschapsbelasting'} ${dto.taxYear}`,
        after: { kind, taxYear: dto.taxYear, returns: made.count },
        meta: { source },
      });
    }
    return { created: made.count, withoutPerson };
  }

  /** Every night: the returns of the year that just ended, for both kinds. */
  async generateDefault(): Promise<number> {
    if (!this.deadlines.setting<boolean>('createReturnsAutomatically')) return 0;
    const taxYear = this.defaultYear(todayInAmsterdam());
    let made = 0;
    for (const kind of RETURN_KINDS) made += (await this.generate({ kind, taxYear }, 'automatic')).created;
    return made;
  }

  /* ── Changing ─────────────────────────────────────────────────────────────────────────────────────────────────── */

  async update(id: string, dto: UpdateReturnDto, locale: AppLocale) {
    const row = await this.rowOrThrow(id);
    this.assertEditable(row);
    const problems: Record<string, string> = {};

    let status = row.status;
    if (dto.status !== undefined && dto.status !== row.status) {
      if (!(await this.lists.activeCodes('tax_return_status')).has(dto.status)) problems.status = 'validation.selectOption';
      status = dto.status;
    }
    const filed = FILED_RETURN_STATUSES.includes(status);
    // The day of filing belongs to a return that is filed: it starts with today, a person can correct it, and it goes when the return is taken back.
    let filedOn: string | null = day(row.filedOn);
    if (!filed) filedOn = null;
    else if (dto.filedOn !== undefined) filedOn = dto.filedOn;
    else if (!filedOn) filedOn = todayInAmsterdam();
    if (filedOn && !isValidDay(filedOn)) problems.filedOn = 'validation.invalid';

    let assigneeId = row.assigneeId;
    if (dto.assigneeId !== undefined) {
      if (dto.assigneeId && !(await this.prisma.user.findFirst({ where: { id: dto.assigneeId, status: 'active' }, select: { id: true } }))) problems.assigneeId = 'validation.invalid';
      assigneeId = dto.assigneeId;
    }
    let fileId = row.fileId;
    if (dto.fileId !== undefined) {
      if (dto.fileId && !(await this.prisma.storedFile.findFirst({ where: { id: dto.fileId, clientId: row.clientId, isActive: true }, select: { id: true } }))) problems.fileId = 'validation.invalid';
      fileId = dto.fileId;
    }
    let periodStart = formatDay(row.periodStart);
    let periodEnd = formatDay(row.periodEnd);
    if (dto.periodStart !== undefined || dto.periodEnd !== undefined) {
      if (row.kind !== 'corporate_tax') problems.periodStart = 'validation.invalid';
      periodStart = dto.periodStart ?? periodStart;
      periodEnd = dto.periodEnd ?? periodEnd;
      if (!isValidDay(periodStart)) problems.periodStart = 'validation.invalid';
      if (!isValidDay(periodEnd)) problems.periodEnd = 'validation.invalid';
      if (!problems.periodStart && !problems.periodEnd && periodEnd < periodStart) problems.periodEnd = 'validation.endBeforeStart';
    }
    if (Object.keys(problems).length) throw validationFailed(problems);

    const note = dto.note === undefined ? row.note : dto.note.trim();
    const before = { status: row.status, filedOn: day(row.filedOn), assigneeId: row.assigneeId, fileId: row.fileId, note: row.note, periodStart: formatDay(row.periodStart), periodEnd: formatDay(row.periodEnd) };
    const after = { status, filedOn, assigneeId, fileId, note, periodStart, periodEnd };
    const diff = AuditService.changes(before, after);
    if (!Object.keys(diff.after).length) return this.one(id, locale);
    await this.prisma.taxReturn.update({
      where: { id },
      data: { status, filedOn: filedOn ? parseDay(filedOn) : null, assigneeId, fileId, note, periodStart: parseDay(periodStart), periodEnd: parseDay(periodEnd) },
    });
    await this.audit.log({ action: 'updated', entityType: TAX_RETURN_ENTITY, entityId: id, entityLabel: this.label(row), before: diff.before, after: diff.after });
    return this.one(id, locale);
  }

  /** The extension of the deadline: asked for, granted (with the new day), refused — or taken away again. */
  async setExtension(id: string, dto: ExtensionDto, locale: AppLocale) {
    const row = await this.rowOrThrow(id);
    this.assertEditable(row);
    const problems: Record<string, string> = {};
    const status = dto.status as ExtensionStatus | null;
    let requestedOn: string | null = null;
    let until: string | null = null;
    let submissionId: string | null = null;
    if (status) {
      requestedOn = dto.requestedOn === undefined ? (day(row.extensionRequestedOn) ?? todayInAmsterdam()) : dto.requestedOn;
      until = dto.until === undefined ? day(row.extensionUntil) : dto.until;
      if (requestedOn && !isValidDay(requestedOn)) problems.requestedOn = 'validation.invalid';
      if (until && !isValidDay(until)) problems.until = 'validation.invalid';
      if (status === 'granted' && !until) problems.until = 'validation.required';
      if (status === 'refused') until = null;
      if (status === 'requested' && !until && !problems.until) until = this.deadlines.suggestedExtension(row.kind as ReturnKind, { taxYear: row.taxYear, periodEnd: formatDay(row.periodEnd) }, row.clientId);
      if (until && !problems.until && until < this.deadlineOf(row).statutory) problems.until = 'taxes.extensionBeforeDeadline';
      const wanted = dto.submissionId === undefined ? row.extensionSubmissionId : dto.submissionId;
      if (wanted) {
        const found = await this.prisma.formSubmission.findFirst({ where: { id: wanted, clientId: row.clientId, form: { code: EXTENSION_FORM_CODE } }, select: { id: true } });
        if (!found) problems.submissionId = 'validation.invalid';
        else submissionId = found.id;
      }
    }
    if (Object.keys(problems).length) throw validationFailed(problems);

    const before = { extensionStatus: row.extensionStatus, extensionRequestedOn: day(row.extensionRequestedOn), extensionUntil: day(row.extensionUntil), extensionSubmissionId: row.extensionSubmissionId };
    const after = { extensionStatus: status, extensionRequestedOn: requestedOn, extensionUntil: until, extensionSubmissionId: submissionId };
    const diff = AuditService.changes(before, after);
    if (!Object.keys(diff.after).length) return this.one(id, locale);
    await this.prisma.taxReturn.update({
      where: { id },
      data: { extensionStatus: status, extensionRequestedOn: requestedOn ? parseDay(requestedOn) : null, extensionUntil: until ? parseDay(until) : null, extensionSubmissionId: submissionId },
    });
    await this.audit.log({ action: 'updated', entityType: TAX_RETURN_ENTITY, entityId: id, entityLabel: this.label(row), before: diff.before, after: diff.after });
    return this.one(id, locale);
  }

  /** Switches a return off (it stays for history) or on again. */
  async setActive(id: string, dto: ActiveDto, user: AuthenticatedUser, locale: AppLocale) {
    const row = await this.rowOrThrow(id);
    if (row.isActive === dto.isActive) return this.one(id, locale);
    await this.prisma.taxReturn.update({
      where: { id },
      data: dto.isActive ? { isActive: true, deactivatedAt: null, deactivatedById: null, deactivationReason: '' } : { isActive: false, deactivatedAt: new Date(), deactivatedById: user.id, deactivationReason: dto.reason?.trim() ?? '' },
    });
    await this.audit.log({ action: dto.isActive ? 'activated' : 'deactivated', entityType: TAX_RETURN_ENTITY, entityId: id, entityLabel: this.label(row), ...(dto.reason?.trim() && { meta: { reason: dto.reason.trim() } }) });
    return this.one(id, locale);
  }

  /* ── Export ───────────────────────────────────────────────────────────────────────────────────────────────────── */

  async exportTable(query: ReturnExportQuery, locale: AppLocale): Promise<ExportTable> {
    const today = todayInAmsterdam();
    let where = this.where(query);
    if (query.due) where = { AND: [where, { id: { in: await this.dueIds(where, query.due, today) } }] };
    this.exports.assertSize(await this.prisma.taxReturn.count({ where }));
    const rows = await this.prisma.taxReturn.findMany({ where, orderBy: this.orderBy(query.sort), include: RETURN_INCLUDE });
    const views = await this.views(rows, locale, today);
    const nl = locale === 'nl';
    const income = query.kind === 'income_tax';
    const title = query.kind === 'corporate_tax' ? (nl ? 'Vennootschapsbelasting' : 'Corporate income tax') : income ? (nl ? 'Inkomstenbelasting' : 'Income tax') : nl ? 'Aangiften' : 'Tax returns';
    const subtitle = [query.taxYear ?? '', query.open ? (nl ? 'alleen open' : 'open only') : '', query.search?.trim() ? `${nl ? 'Zoekterm' : 'Search'}: ${query.search.trim()}` : ''].filter(Boolean).join(' · ');
    return {
      title,
      subtitle: subtitle || undefined,
      locale,
      columns: [
        { key: 'number', header: nl ? 'Klantnr.' : 'Client no.', width: 10 },
        { key: 'client', header: nl ? 'Klant' : 'Client', width: 28 },
        ...(query.kind === 'corporate_tax' ? [] : [{ key: 'person', header: nl ? 'Voor' : 'For', width: 22 }]),
        { key: 'taxYear', header: nl ? 'Jaar' : 'Year', width: 8 },
        { key: 'status', header: 'Status', width: 20 },
        { key: 'deadline', header: nl ? 'Deadline' : 'Deadline', type: 'date' as const, width: 12 },
        { key: 'extension', header: nl ? 'Uitstel' : 'Extension', width: 16 },
        { key: 'extensionUntil', header: nl ? 'Uitstel tot' : 'Extended to', type: 'date' as const, width: 12 },
        { key: 'filedOn', header: nl ? 'Ingediend op' : 'Filed on', type: 'date' as const, width: 12 },
        { key: 'assignee', header: nl ? 'Verantwoordelijke' : 'Responsible', width: 20 },
        { key: 'note', header: nl ? 'Opmerking' : 'Note', width: 30 },
      ],
      rows: views.map(view => ({
        number: view.client.number,
        client: view.client.name,
        person: view.person?.name ?? '',
        taxYear: String(view.taxYear),
        status: view.statusName,
        deadline: view.deadline,
        extension: view.extension?.statusName ?? '',
        extensionUntil: view.extension?.until ?? null,
        filedOn: view.filedOn,
        assignee: view.assignee?.name ?? '',
        note: view.note,
      })),
    };
  }
}
