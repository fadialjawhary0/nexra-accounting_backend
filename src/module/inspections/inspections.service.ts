import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ApiResult, paged } from '../../common/api-result.js';
import { addDays, addMonths, isValidDay, todayInAmsterdam } from '../../common/dates.js';
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
import { SettingsService } from '../../lib/settings/settings.service.js';
import { CalendarService } from '../calendar/calendar.service.js';
import { NumberingService } from '../numbering/numbering.service.js';
import { ChecklistTemplatesService } from './checklist-templates.service.js';
import type { CreateInspectionDto, InspectionActiveDto, InspectionExportQuery, InspectionListQuery, InspectionStatusDto, UpdateInspectionDto } from './dto/inspections.dto.js';
import { InspectionChecklistService } from './inspection-checklist.service.js';
import { InspectionFoldersService } from './inspection-folders.service.js';
import { InspectionListsService } from './inspection-lists.service.js';
import type { Summary } from './inspection-matching.js';
import { INSPECTION_INCLUDE, customItemsOf, day, docOf, isOpen, searchTextOf, toDay, type InspectionRow } from './inspection-rows.js';
import { INSPECTIONS_NAMESPACE, INSPECTION_ENTITY, INSPECTION_NUMBER_KEY, INSPECTIONS_DEFINITIONS, OPEN_STATUSES, type InspectionStatus } from './inspections.constants.js';

const SORTS: Record<string, (direction: 'asc' | 'desc') => Prisma.InspectionOrderByWithRelationInput> = {
  date: direction => ({ date: direction }),
  number: direction => ({ number: direction }),
  client: direction => ({ client: { number: direction } }),
  status: direction => ({ status: direction }),
  type: direction => ({ type: direction }),
  body: direction => ({ body: direction }),
  responseDue: direction => ({ responseDue: { sort: direction, nulls: 'last' } }),
  createdAt: direction => ({ createdAt: direction }),
};

/** Where an inspection may go from each status; a closed or cancelled one is opened again by going back. */
const MOVES: Record<InspectionStatus, readonly InspectionStatus[]> = {
  planned: ['in_progress', 'awaiting_result', 'closed', 'cancelled'],
  in_progress: ['planned', 'awaiting_result', 'closed', 'cancelled'],
  awaiting_result: ['planned', 'in_progress', 'closed', 'cancelled'],
  closed: ['in_progress'],
  cancelled: ['planned', 'in_progress'],
};

const split = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);

type FollowUpRow = Prisma.InspectionFollowUpGetPayload<object>;

/** What a created inspection starts from when it follows another one (the next in a series). */
interface Carry {
  from: InspectionRow;
}

/**
 * Inspections: a body inspects a client on a day — planned in advance, prepared with a checklist, followed through to a result and the things to put right. This service
 * keeps the inspection itself (who, when, what status, what was found, the dated folder, the next one in the series); the checklist and what is ready is
 * `InspectionChecklistService`, the bundle for the inspector is `InspectionBundleService`.
 */
@Injectable()
export class InspectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly numbering: NumberingService,
    private readonly settings: SettingsService,
    private readonly calendar: CalendarService,
    private readonly templates: ChecklistTemplatesService,
    private readonly checklist: InspectionChecklistService,
    private readonly folders: InspectionFoldersService,
    private readonly lists: InspectionListsService,
    private readonly exports: ExportsService,
  ) {
    settings.register(INSPECTIONS_NAMESPACE, INSPECTIONS_DEFINITIONS, { exposed: true });
    numbering.register({ key: INSPECTION_NUMBER_KEY, label: { nl: 'Controlenummer', en: 'Inspection number' }, defaults: { prefix: 'CTR-', padding: 4 } });
  }

  private setting<T extends string | number | boolean>(name: keyof typeof INSPECTIONS_DEFINITIONS): T {
    return this.settings.get<T>(`${INSPECTIONS_NAMESPACE}.${name}`);
  }

  /* ── Reading ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  async rowOrThrow(id: string): Promise<InspectionRow> {
    const row = await this.prisma.inspection.findUnique({ where: { id }, include: INSPECTION_INCLUDE });
    if (!row) throw new NotFoundException({ code: 'not_found', message: 'Inspection not found' });
    return row;
  }

  /** The label the audit log and the exports use: "CTR-0012 – 042 Bakkerij". */
  label(row: Pick<InspectionRow, 'number' | 'client'>): string {
    return `${row.number} – ${row.client.number} ${row.client.name}`;
  }

  private async names(locale: AppLocale) {
    const [types, bodies, statuses, outcomes] = await Promise.all([this.lists.names('inspection_type', locale), this.lists.names('inspection_body', locale), this.lists.names('inspection_status', locale), this.lists.names('inspection_outcome', locale)]);
    return { types, bodies, statuses, outcomes };
  }

  /** The inspections as the screens show them: names in the person's language, readiness, what is still to do. */
  async views(rows: readonly InspectionRow[], locale: AppLocale, options: { readiness?: boolean } = {}) {
    if (!rows.length) return [];
    const ids = rows.map(row => row.id);
    const userIds = [...new Set(rows.map(row => row.assigneeId).filter((id): id is string => Boolean(id)))];
    const [names, users, followUps, handovers, summaries] = await Promise.all([
      this.names(locale),
      userIds.length ? this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [],
      this.prisma.inspectionFollowUp.groupBy({ by: ['inspectionId'], where: { inspectionId: { in: ids }, doneOn: null }, _count: { _all: true } }),
      this.prisma.inspectionHandover.groupBy({ by: ['inspectionId'], where: { inspectionId: { in: ids } }, _count: { _all: true } }),
      options.readiness === false ? new Map<string, Summary | null>() : this.checklist.summaries(rows),
    ]);
    const userName = new Map(users.map(user => [user.id, user.name]));
    const openFollowUps = new Map(followUps.map(entry => [entry.inspectionId, entry._count._all]));
    const handoverCount = new Map(handovers.map(entry => [entry.inspectionId, entry._count._all]));
    return rows.map(row => ({
      id: row.id,
      number: row.number,
      client: row.client,
      type: { code: row.type, name: names.types.get(row.type) ?? row.type },
      body: { code: row.body, name: names.bodies.get(row.body) ?? row.body },
      status: row.status,
      statusName: names.statuses.get(row.status) ?? row.status,
      outcome: row.outcome ? { code: row.outcome, name: names.outcomes.get(row.outcome) ?? row.outcome } : null,
      inspectorName: row.inspectorName,
      reference: row.reference,
      date: day(row.date)!,
      periodFrom: day(row.periodFrom),
      periodTo: day(row.periodTo),
      responseDue: day(row.responseDue),
      closedOn: day(row.closedOn),
      assignee: row.assigneeId ? { id: row.assigneeId, name: userName.get(row.assigneeId) ?? '' } : null,
      version: row.version ? { id: row.version.id, number: row.version.version, label: row.version.label, template: { id: row.version.template.id, name: locale === 'nl' ? row.version.template.nameNl : row.version.template.nameEn } } : null,
      hasFolder: row.folderId !== null,
      readiness: summaries.get(row.id) ?? null,
      openFollowUps: openFollowUps.get(row.id) ?? 0,
      handovers: handoverCount.get(row.id) ?? 0,
      isActive: row.isActive,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  private where(query: Partial<InspectionListQuery>, today: string): Prisma.InspectionWhereInput {
    const terms = fold(query.search ?? '').split(' ').filter(Boolean).slice(0, 6);
    const statuses = split(query.status);
    const types = split(query.type);
    const bodies = split(query.body);
    const state = query.state ?? 'active';
    const within = query.within ? Number(query.within) : null;
    const and: Prisma.InspectionWhereInput[] = [];
    if (query.open) and.push({ status: { in: [...OPEN_STATUSES] } });
    if (within !== null) and.push({ status: { in: [...OPEN_STATUSES] }, date: { gte: toDay(today), lte: toDay(addDays(today, within)) } });
    return {
      ...(state !== 'all' && { isActive: state === 'active' }),
      ...(query.clientId && { clientId: query.clientId }),
      ...(statuses.length && { status: { in: statuses } }),
      ...(types.length && { type: { in: types } }),
      ...(bodies.length && { body: { in: bodies } }),
      ...(query.assigneeId && { assigneeId: query.assigneeId }),
      ...((query.from || query.to) && { date: { ...(query.from && { gte: toDay(query.from) }), ...(query.to && { lte: toDay(query.to) }) } }),
      AND: [...and, ...terms.map(term => ({ searchText: { contains: term } }))],
    };
  }

  private orderBy(sort: string | undefined): Prisma.InspectionOrderByWithRelationInput[] {
    const order = split(sort)
      .map(part => part.split(':') as [string, string?])
      .filter(([key]) => key in SORTS)
      .map(([key, direction]) => SORTS[key]!(direction === 'asc' ? 'asc' : 'desc'));
    return [...(order.length ? order : [{ date: 'desc' as const }]), { createdAt: 'desc' }];
  }

  async list(query: InspectionListQuery, locale: AppLocale): Promise<ApiResult> {
    const today = todayInAmsterdam();
    const where = this.where(query, today);
    const [total, rows, stats] = await Promise.all([
      this.prisma.inspection.count({ where }),
      this.prisma.inspection.findMany({ where, orderBy: this.orderBy(query.sort), include: INSPECTION_INCLUDE, ...toSkipTake(query) }),
      query.stats ? this.stats(query, today) : Promise.resolve(undefined),
    ]);
    return paged(await this.views(rows, locale), pageMeta(total, query, stats ? { stats } : {}));
  }

  /** The same counters for the dashboard: what is open, how many of the inspections in the next 30 days are not ready, and the next one. */
  attention() {
    return this.stats({ page: 1, pageSize: 1 } as InspectionListQuery, todayInAmsterdam());
  }

  /** The counters above the list: what is open, what is coming, what is not ready, what is waiting for a result. */
  private async stats(query: InspectionListQuery, today: string) {
    const base = this.where({ ...query, status: undefined, open: undefined, within: undefined }, today);
    const open = { status: { in: [...OPEN_STATUSES] } };
    const soon = { ...open, date: { gte: toDay(today), lte: toDay(addDays(today, 30)) } };
    const year = today.slice(0, 4);
    const [openCount, soonRows, awaiting, closedThisYear] = await Promise.all([
      this.prisma.inspection.count({ where: { AND: [base, open] } }),
      this.prisma.inspection.findMany({ where: { AND: [base, soon] }, orderBy: { date: 'asc' }, include: INSPECTION_INCLUDE }),
      this.prisma.inspection.count({ where: { AND: [base, { status: 'awaiting_result' }] } }),
      this.prisma.inspection.count({ where: { AND: [base, { status: 'closed', closedOn: { gte: toDay(`${year}-01-01`), lte: toDay(`${year}-12-31`) } }] } }),
    ]);
    const summaries = await this.checklist.summaries(soonRows);
    const notReady = soonRows.filter(row => {
      const summary = summaries.get(row.id);
      return summary !== null && summary !== undefined && summary.ready < summary.total;
    });
    const next = soonRows[0];
    return {
      open: openCount,
      next30: soonRows.length,
      notReady: notReady.length,
      awaiting,
      closedThisYear,
      next: next ? { id: next.id, date: day(next.date)!, client: `${next.client.number} ${next.client.name}` } : null,
    };
  }

  /** One inspection: the record with its follow-ups (the checklist is `GET /inspections/:id/checklist`). */
  async one(id: string, locale: AppLocale) {
    const row = await this.rowOrThrow(id);
    const [[view], followUps, folder] = await Promise.all([
      this.views([row], locale),
      this.prisma.inspectionFollowUp.findMany({ where: { inspectionId: id }, orderBy: [{ doneOn: { sort: 'asc', nulls: 'first' } }, { dueDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }] }),
      this.folders.pathOf(row.folderId),
    ]);
    const userIds = [...new Set(followUps.map(entry => entry.assigneeId).filter((value): value is string => Boolean(value)))];
    const users = userIds.length ? await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [];
    const userName = new Map(users.map(user => [user.id, user.name]));
    return {
      ...view!,
      findings: row.findings,
      requestText: row.requestText,
      deactivationReason: row.deactivationReason,
      folder: row.folderId ? { id: row.folderId, path: folder ?? '' } : null,
      editable: row.isActive && isOpen(row),
      allowedStatuses: row.isActive ? MOVES[row.status as InspectionStatus] ?? [] : [],
      followUps: followUps.map(entry => this.followUpView(entry, userName)),
      customLines: customItemsOf(row.items).length,
    };
  }

  private followUpView(entry: FollowUpRow, userName: ReadonlyMap<string, string>) {
    return { id: entry.id, text: entry.text, dueDate: day(entry.dueDate), doneOn: day(entry.doneOn), assignee: entry.assigneeId ? { id: entry.assigneeId, name: userName.get(entry.assigneeId) ?? '' } : null };
  }

  /* ── Making and changing ──────────────────────────────────────────────────────────────────────────────────────── */

  private async assertDay(value: string | null | undefined, field: string, problems: Record<string, string>): Promise<void> {
    if (value && !isValidDay(value)) problems[field] = 'validation.invalid';
  }

  private async checkedAssignee(assigneeId: string | null | undefined, problems: Record<string, string>): Promise<string | null | undefined> {
    if (!assigneeId) return assigneeId === null ? null : undefined;
    const found = await this.prisma.user.findFirst({ where: { id: assigneeId, status: 'active' }, select: { id: true } });
    if (!found) problems.assigneeId = 'validation.invalid';
    return found?.id;
  }

  /** The edition an inspection of this kind is prepared with: the one asked for, else the newest published one of the checklist for the kind. */
  private async chosenVersion(versionId: string | null | undefined, type: string, problems: Record<string, string>): Promise<string | null> {
    if (versionId) {
      const version = await this.templates.versionById(versionId);
      if (!version || version.status !== 'published') {
        problems.versionId = 'validation.invalid';
        return null;
      }
      return version.id;
    }
    return (await this.templates.forType(type))?.version.id ?? null;
  }

  async create(dto: CreateInspectionDto, user: AuthenticatedUser, locale: AppLocale, carry?: Carry) {
    const problems: Record<string, string> = {};
    const client = await this.prisma.client.findUnique({ where: { id: dto.clientId }, select: { id: true, number: true, name: true, responsibleUserId: true } });
    if (!client) problems.clientId = 'validation.invalid';
    const [types, bodies] = await Promise.all([this.lists.activeCodes('inspection_type'), this.lists.activeCodes('inspection_body')]);
    if (!types.has(dto.type)) problems.type = 'validation.selectOption';
    if (!bodies.has(dto.body)) problems.body = 'validation.selectOption';
    if (!isValidDay(dto.date)) problems.date = 'validation.invalid';
    for (const field of ['periodFrom', 'periodTo', 'responseDue'] as const) await this.assertDay(dto[field], field, problems);
    if (dto.periodFrom && dto.periodTo && dto.periodTo < dto.periodFrom) problems.periodTo = 'validation.endBeforeStart';
    const assigneeId = (await this.checkedAssignee(dto.assigneeId, problems)) ?? client?.responsibleUserId ?? null;
    const versionId = await this.chosenVersion(dto.versionId, dto.type, problems);
    if (Object.keys(problems).length) throw validationFailed(problems);
    const known = client!;

    const [typeEntries, bodyEntries] = await Promise.all([this.lists.entries('inspection_type'), this.lists.entries('inspection_body')]);
    const typeEntry = typeEntries.find(entry => entry.code === dto.type);
    const bodyEntry = bodyEntries.find(entry => entry.code === dto.body);
    const inspectorName = dto.inspectorName?.trim() ?? carry?.from.inspectorName ?? '';
    const reference = dto.reference?.trim() ?? '';
    const created = await this.prisma.$transaction(async tx => {
      const number = await this.numbering.allocate(INSPECTION_NUMBER_KEY, tx);
      const row = await tx.inspection.create({
        data: {
          number: number.formatted,
          clientId: known.id,
          type: dto.type,
          body: dto.body,
          status: 'planned',
          inspectorName,
          reference,
          date: toDay(dto.date),
          periodFrom: dto.periodFrom ? toDay(dto.periodFrom) : null,
          periodTo: dto.periodTo ? toDay(dto.periodTo) : null,
          responseDue: dto.responseDue ? toDay(dto.responseDue) : null,
          versionId,
          assigneeId,
          requestText: dto.requestText?.trim() ?? '',
          createdById: user.id,
          searchText: searchTextOf([number.formatted, known.number, known.name, inspectorName, reference, typeEntry?.nameNl, typeEntry?.nameEn, bodyEntry?.nameNl, bodyEntry?.nameEn]),
        },
      });
      // The lines asked at every inspection that the office switched off (they do not apply to this client) or on by hand (the inspector keeps asking for them)
      // stay that way in the next inspection of the series. Lines asked once every so many months, or only when switched on, start from their rule again.
      if (carry && versionId) {
        const doc = docOf({ version: await tx.checklistVersion.findUnique({ where: { id: versionId }, include: { template: { select: { id: true, code: true, nameNl: true, nameEn: true } } } }) });
        const codes = new Set(doc.items.filter(item => item.ask === 'every').map(item => item.code));
        const carried = carry.from.items.filter(item => item.code && (item.decision === 'not_applicable' || item.decision === 'asked') && codes.has(item.code));
        if (carried.length) await tx.inspectionItem.createMany({ data: carried.map(item => ({ inspectionId: row.id, code: item.code, decision: item.decision, note: item.note, updatedById: user.id })) });
      }
      return row;
    });

    if (dto.createFolder ?? this.setting<boolean>('createFolder')) {
      const version = versionId ? await this.templates.versionById(versionId) : null;
      const sections = docOf({ version }).sections;
      const folderId = await this.folders.ensure({ clientId: known.id, clientLabel: `${known.number} ${known.name}`, bodyName: bodyEntry?.nameNl ?? dto.body, day: dto.date, sections });
      if (folderId) await this.prisma.inspection.update({ where: { id: created.id }, data: { folderId } });
    }
    await this.audit.log({
      action: 'created',
      entityType: INSPECTION_ENTITY,
      entityId: created.id,
      entityLabel: `${created.number} – ${known.number} ${known.name}`,
      after: { type: dto.type, body: dto.body, date: dto.date, ...(carry && { followsUp: carry.from.number }) },
    });
    return this.one(created.id, locale);
  }

  private assertOpen(row: InspectionRow): void {
    if (!row.isActive) throw new ConflictException({ code: 'inspection_inactive', message: 'This inspection is switched off.' });
    if (!isOpen(row)) throw new ConflictException({ code: 'inspection_closed', message: 'This inspection is closed — open it again to change it.' });
  }

  async update(id: string, dto: UpdateInspectionDto, locale: AppLocale) {
    const row = await this.rowOrThrow(id);
    this.assertOpen(row);
    const problems: Record<string, string> = {};
    const [types, bodies] = await Promise.all([this.lists.activeCodes('inspection_type'), this.lists.activeCodes('inspection_body')]);
    if (dto.type !== undefined && dto.type !== row.type && !types.has(dto.type)) problems.type = 'validation.selectOption';
    if (dto.body !== undefined && dto.body !== row.body && !bodies.has(dto.body)) problems.body = 'validation.selectOption';
    if (dto.date !== undefined && !isValidDay(dto.date)) problems.date = 'validation.invalid';
    for (const field of ['periodFrom', 'periodTo', 'responseDue'] as const) await this.assertDay(dto[field], field, problems);
    const periodFrom = dto.periodFrom === undefined ? day(row.periodFrom) : dto.periodFrom;
    const periodTo = dto.periodTo === undefined ? day(row.periodTo) : dto.periodTo;
    if (periodFrom && periodTo && periodTo < periodFrom && !problems.periodTo) problems.periodTo = 'validation.endBeforeStart';
    const assigneeId = await this.checkedAssignee(dto.assigneeId, problems);
    let versionId: string | null | undefined;
    if (dto.versionId !== undefined) {
      if (dto.versionId === null) versionId = null;
      else versionId = (await this.chosenVersion(dto.versionId, dto.type ?? row.type, problems)) ?? undefined;
    }
    if (Object.keys(problems).length) throw validationFailed(problems);

    const next = {
      type: dto.type ?? row.type,
      body: dto.body ?? row.body,
      date: dto.date ?? day(row.date)!,
      inspectorName: dto.inspectorName === undefined ? row.inspectorName : dto.inspectorName.trim(),
      reference: dto.reference === undefined ? row.reference : dto.reference.trim(),
      periodFrom: periodFrom ?? null,
      periodTo: periodTo ?? null,
      responseDue: dto.responseDue === undefined ? day(row.responseDue) : dto.responseDue,
      findings: dto.findings === undefined ? row.findings : dto.findings.trim(),
      requestText: dto.requestText === undefined ? row.requestText : dto.requestText.trim(),
    };
    const before = {
      type: row.type,
      body: row.body,
      date: day(row.date),
      inspectorName: row.inspectorName,
      reference: row.reference,
      periodFrom: day(row.periodFrom),
      periodTo: day(row.periodTo),
      responseDue: day(row.responseDue),
      findings: row.findings,
      requestText: row.requestText,
      ...(versionId !== undefined && { version: row.version?.version ?? null }),
      ...(assigneeId !== undefined && { assigneeId: row.assigneeId }),
    };
    const nextVersion = versionId === undefined ? undefined : versionId ? await this.templates.versionById(versionId) : null;
    const after = { ...next, ...(versionId !== undefined && { version: nextVersion?.version ?? null }), ...(assigneeId !== undefined && { assigneeId }) };
    const diff = AuditService.changes(before, after);
    if (!Object.keys(diff.after).length) return this.one(id, locale);

    const [typeEntries, bodyEntries] = await Promise.all([this.lists.entries('inspection_type'), this.lists.entries('inspection_body')]);
    const typeEntry = typeEntries.find(entry => entry.code === next.type);
    const bodyEntry = bodyEntries.find(entry => entry.code === next.body);
    await this.prisma.inspection.update({
      where: { id },
      data: {
        type: next.type,
        body: next.body,
        date: toDay(next.date),
        inspectorName: next.inspectorName,
        reference: next.reference,
        periodFrom: next.periodFrom ? toDay(next.periodFrom) : null,
        periodTo: next.periodTo ? toDay(next.periodTo) : null,
        responseDue: next.responseDue ? toDay(next.responseDue) : null,
        findings: next.findings,
        requestText: next.requestText,
        ...(versionId !== undefined && { versionId }),
        ...(assigneeId !== undefined && { assigneeId }),
        searchText: searchTextOf([row.number, row.client.number, row.client.name, next.inspectorName, next.reference, typeEntry?.nameNl, typeEntry?.nameEn, bodyEntry?.nameNl, bodyEntry?.nameEn]),
      },
    });
    await this.audit.log({ action: 'updated', entityType: INSPECTION_ENTITY, entityId: id, entityLabel: this.label(row), before: diff.before, after: diff.after });
    return this.one(id, locale);
  }

  /* ── Status ───────────────────────────────────────────────────────────────────────────────────────────────────── */

  /** Moves an inspection on. Closing writes down the checklist as it stands and — for a kind that comes back — plans the next one. */
  async setStatus(id: string, dto: InspectionStatusDto, user: AuthenticatedUser, locale: AppLocale) {
    const row = await this.rowOrThrow(id);
    if (!row.isActive) throw new ConflictException({ code: 'inspection_inactive', message: 'This inspection is switched off.' });
    const from = row.status as InspectionStatus;
    const to = dto.status as InspectionStatus;
    if (from === to) return this.one(id, locale);
    if (!MOVES[from]?.includes(to)) throw new ConflictException({ code: 'inspection_status_move', message: 'The inspection cannot move to that status from here.', details: { from, to } });

    const problems: Record<string, string> = {};
    let outcome: string | null = null;
    let closedOn: string | null = null;
    let snapshot: Prisma.InputJsonValue | typeof Prisma.DbNull = Prisma.DbNull;
    if (to === 'closed') {
      const outcomes = await this.lists.activeCodes('inspection_outcome');
      if (!dto.outcome || !outcomes.has(dto.outcome)) problems.outcome = 'validation.selectOption';
      outcome = dto.outcome ?? null;
      closedOn = dto.closedOn ?? todayInAmsterdam();
      if (!isValidDay(closedOn)) problems.closedOn = 'validation.invalid';
    }
    if (Object.keys(problems).length) throw validationFailed(problems);
    if (to === 'closed') snapshot = await this.checklist.snapshotOf(row);

    const findings = dto.findings === undefined ? row.findings : dto.findings.trim();
    await this.prisma.inspection.update({ where: { id }, data: { status: to, outcome, closedOn: closedOn ? toDay(closedOn) : null, snapshot, findings } });
    await this.audit.log({
      action: 'updated',
      entityType: INSPECTION_ENTITY,
      entityId: id,
      entityLabel: this.label(row),
      before: { status: from, outcome: row.outcome, closedOn: day(row.closedOn) },
      after: { status: to, outcome, closedOn },
    });
    if (to === 'closed' && (dto.planNext ?? this.setting<boolean>('planNextOnClose'))) await this.planNextFor(await this.rowOrThrow(id), user, locale, null);
    return this.one(id, locale);
  }

  /** Switches an inspection off (it stays for history) or on again. */
  async setActive(id: string, dto: InspectionActiveDto, user: AuthenticatedUser, locale: AppLocale) {
    const row = await this.rowOrThrow(id);
    if (row.isActive === dto.isActive) return this.one(id, locale);
    await this.prisma.inspection.update({
      where: { id },
      data: dto.isActive ? { isActive: true, deactivatedAt: null, deactivatedById: null, deactivationReason: '' } : { isActive: false, deactivatedAt: new Date(), deactivatedById: user.id, deactivationReason: dto.reason?.trim() ?? '' },
    });
    await this.audit.log({ action: dto.isActive ? 'activated' : 'deactivated', entityType: INSPECTION_ENTITY, entityId: id, entityLabel: this.label(row), ...(dto.reason?.trim() && { meta: { reason: dto.reason.trim() } }) });
    return this.one(id, locale);
  }

  /* ── The next one in the series ───────────────────────────────────────────────────────────────────────────────── */

  /**
   * Plans the inspection that follows this one: for a kind that comes back (a flag of the type: NEN 4400-1 is inspected about every six months) a number of months later,
   * moved to a working day — or on the day asked for. Nothing is planned when the client already has a later inspection of that kind that is not over.
   */
  async planNextFor(row: InspectionRow, user: AuthenticatedUser, locale: AppLocale, explicit: string | null): Promise<{ id: string } | null> {
    const meta = await this.lists.metaOf('inspection_type', row.type);
    if (!explicit && meta.recurring !== true) return null;
    const months = this.setting<number>('recurrenceMonths');
    if (!explicit && months <= 0) return null;
    const nextType = typeof meta.nextType === 'string' && (await this.lists.activeCodes('inspection_type')).has(meta.nextType) ? meta.nextType : row.type;
    const later = await this.prisma.inspection.findFirst({ where: { clientId: row.clientId, isActive: true, type: nextType, status: { in: [...OPEN_STATUSES] }, date: { gt: row.date } }, select: { id: true } });
    if (later && !explicit) return null;
    const date = explicit ?? this.calendar.nextWorkingDay(addMonths(day(row.date)!, months), row.clientId);
    const created = await this.create({ clientId: row.clientId, type: nextType, body: row.body, date, inspectorName: row.inspectorName, assigneeId: row.assigneeId }, user, locale, { from: row });
    return { id: created.id };
  }

  async planNext(id: string, date: string | undefined, user: AuthenticatedUser, locale: AppLocale) {
    const row = await this.rowOrThrow(id);
    if (date && !isValidDay(date)) throw validationFailed({ date: 'validation.invalid' });
    const created = await this.planNextFor(row, user, locale, date ?? null);
    if (!created) throw new ConflictException({ code: 'inspection_next_not_planned', message: 'This kind of inspection does not come back, or one is planned already.' });
    return this.one(created.id, locale);
  }

  /* ── Follow-up ────────────────────────────────────────────────────────────────────────────────────────────────── */

  async addFollowUp(id: string, dto: { text?: string; dueDate?: string | null; assigneeId?: string | null }, user: AuthenticatedUser, locale: AppLocale) {
    const row = await this.rowOrThrow(id);
    if (!row.isActive) throw new ConflictException({ code: 'inspection_inactive', message: 'This inspection is switched off.' });
    const problems: Record<string, string> = {};
    const text = dto.text?.trim() ?? '';
    if (!text) problems.text = 'validation.required';
    await this.assertDay(dto.dueDate, 'dueDate', problems);
    const assigneeId = await this.checkedAssignee(dto.assigneeId, problems);
    if (Object.keys(problems).length) throw validationFailed(problems);
    const created = await this.prisma.inspectionFollowUp.create({ data: { inspectionId: id, text, dueDate: dto.dueDate ? toDay(dto.dueDate) : null, assigneeId: assigneeId ?? null, createdById: user.id } });
    await this.audit.log({ action: 'updated', entityType: INSPECTION_ENTITY, entityId: id, entityLabel: this.label(row), before: { followUp: null }, after: { followUp: created.text, dueDate: day(created.dueDate) } });
    return this.one(id, locale);
  }

  async updateFollowUp(id: string, followUpId: string, dto: { text?: string; dueDate?: string | null; doneOn?: string | null; assigneeId?: string | null }, locale: AppLocale) {
    const row = await this.rowOrThrow(id);
    const found = await this.prisma.inspectionFollowUp.findFirst({ where: { id: followUpId, inspectionId: id } });
    if (!found) throw new NotFoundException({ code: 'not_found', message: 'Follow-up not found' });
    const problems: Record<string, string> = {};
    const text = dto.text === undefined ? found.text : dto.text.trim();
    if (!text) problems.text = 'validation.required';
    await this.assertDay(dto.dueDate, 'dueDate', problems);
    await this.assertDay(dto.doneOn, 'doneOn', problems);
    const assigneeId = await this.checkedAssignee(dto.assigneeId, problems);
    if (Object.keys(problems).length) throw validationFailed(problems);
    const next = {
      text,
      dueDate: dto.dueDate === undefined ? day(found.dueDate) : dto.dueDate,
      doneOn: dto.doneOn === undefined ? day(found.doneOn) : dto.doneOn,
      assigneeId: assigneeId === undefined ? found.assigneeId : assigneeId,
    };
    const diff = AuditService.changes({ text: found.text, dueDate: day(found.dueDate), doneOn: day(found.doneOn), assigneeId: found.assigneeId }, next);
    if (Object.keys(diff.after).length) {
      await this.prisma.inspectionFollowUp.update({ where: { id: followUpId }, data: { text, dueDate: next.dueDate ? toDay(next.dueDate) : null, doneOn: next.doneOn ? toDay(next.doneOn) : null, assigneeId: next.assigneeId } });
      await this.audit.log({ action: 'updated', entityType: INSPECTION_ENTITY, entityId: id, entityLabel: this.label(row), before: { followUp: found.text, ...diff.before }, after: { followUp: text, ...diff.after } });
    }
    return this.one(id, locale);
  }

  async removeFollowUp(id: string, followUpId: string, locale: AppLocale) {
    const row = await this.rowOrThrow(id);
    const found = await this.prisma.inspectionFollowUp.findFirst({ where: { id: followUpId, inspectionId: id } });
    if (!found) throw new NotFoundException({ code: 'not_found', message: 'Follow-up not found' });
    await this.prisma.inspectionFollowUp.delete({ where: { id: followUpId } });
    await this.audit.log({ action: 'updated', entityType: INSPECTION_ENTITY, entityId: id, entityLabel: this.label(row), before: { followUp: found.text }, after: { followUp: null } });
    return this.one(id, locale);
  }

  /* ── Export ───────────────────────────────────────────────────────────────────────────────────────────────────── */

  async exportTable(query: InspectionExportQuery, locale: AppLocale): Promise<ExportTable> {
    const today = todayInAmsterdam();
    const where = this.where(query, today);
    this.exports.assertSize(await this.prisma.inspection.count({ where }));
    const rows = await this.prisma.inspection.findMany({ where, orderBy: this.orderBy(query.sort), include: INSPECTION_INCLUDE });
    const views = await this.views(rows, locale);
    const nl = locale === 'nl';
    return {
      title: nl ? 'Controles' : 'Inspections',
      subtitle: query.search?.trim() ? `${nl ? 'Zoekterm' : 'Search'}: ${query.search.trim()}` : undefined,
      locale,
      columns: [
        { key: 'number', header: 'Nr.', width: 10 },
        { key: 'clientNumber', header: nl ? 'Klantnr.' : 'Client no.', width: 10 },
        { key: 'client', header: nl ? 'Klant' : 'Client', width: 26 },
        { key: 'type', header: nl ? 'Soort' : 'Type', width: 26 },
        { key: 'body', header: nl ? 'Instantie' : 'Body', width: 20 },
        { key: 'date', header: nl ? 'Datum' : 'Date', type: 'date', width: 12 },
        { key: 'status', header: 'Status', width: 18 },
        { key: 'outcome', header: nl ? 'Uitkomst' : 'Outcome', width: 22 },
        { key: 'inspector', header: nl ? 'Inspecteur' : 'Inspector', width: 20 },
        { key: 'responseDue', header: nl ? 'Antwoord uiterlijk' : 'Answer due', type: 'date', width: 14 },
        { key: 'ready', header: nl ? 'Gereed (%)' : 'Ready (%)', type: 'number', width: 10 },
        { key: 'open', header: nl ? 'Nog te doen' : 'Still to do', type: 'number', width: 10 },
        { key: 'assignee', header: nl ? 'Verantwoordelijke' : 'Responsible', width: 20 },
      ],
      rows: views.map(view => ({
        number: view.number,
        clientNumber: view.client.number,
        client: view.client.name,
        type: view.type.name,
        body: view.body.name,
        date: view.date,
        status: view.statusName,
        outcome: view.outcome?.name ?? '',
        inspector: view.inspectorName,
        responseDue: view.responseDue,
        ready: view.readiness ? view.readiness.percent : null,
        open: view.readiness ? view.readiness.total - view.readiness.ready : null,
        assignee: view.assignee?.name ?? '',
      })),
    };
  }

}
