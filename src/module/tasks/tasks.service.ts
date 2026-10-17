import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ApiResult, paged } from '../../common/api-result.js';
import { addDays, formatDay, isValidDay, parseDay, todayInAmsterdam } from '../../common/dates.js';
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
import { ListsService } from '../lists/lists.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { matrixAllows } from '../roles/permission-catalog.js';
import type { CreateTaskDto, SubtaskDto, TaskExportQuery, TaskListQuery, UpdateTaskDto } from './dto/tasks.dto.js';
import { TaskLinksService } from './task-links.service.js';
import { DONE_STATUS, LINK_AREAS, MAX_SUBTASKS, MAX_TAGS, OPEN_TASK_STATUSES, PRIORITY_RANK, TASK_ENTITY, TASK_PRIORITY_LIST, TASK_STATUS_LIST } from './tasks.constants.js';

const TASK_INCLUDE = { client: { select: { id: true, number: true, name: true } } } satisfies Prisma.TaskInclude;
type TaskRow = Prisma.TaskGetPayload<{ include: typeof TASK_INCLUDE }>;

export interface Subtask {
  id: string;
  title: string;
  done: boolean;
}

const split = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);

const day = (value: Date | null): string | null => (value ? formatDay(value) : null);

/** The subtasks as they are stored, read defensively (the column is JSON). */
export const readSubtasks = (value: unknown): Subtask[] =>
  (Array.isArray(value) ? value : [])
    .map(item => (item && typeof item === 'object' ? (item as Record<string, unknown>) : {}))
    .map(item => ({ id: String(item.id ?? ''), title: String(item.title ?? '').trim(), done: item.done === true }))
    .filter(item => item.id && item.title);

const cleanSubtasks = (list: readonly SubtaskDto[] | undefined): Subtask[] =>
  (list ?? []).slice(0, MAX_SUBTASKS).map(item => ({ id: item.id?.trim() || randomUUID().slice(0, 8), title: item.title.trim(), done: item.done === true })).filter(item => item.title);

const cleanTags = (tags: readonly string[] | undefined): string[] => {
  const seen = new Map<string, string>();
  for (const tag of tags ?? []) {
    const text = tag.trim();
    if (text && !seen.has(text.toLowerCase())) seen.set(text.toLowerCase(), text);
  }
  return [...seen.values()].slice(0, MAX_TAGS);
};

const searchTextOf = (task: { title: string; description: string; linkedLabel: string; tags: readonly string[] }): string => fold([task.title, task.description, task.linkedLabel, task.tags.join(' ')].join(' '));

/**
 * The office's to-do list. A task has a status, a priority, a due date and one person it is assigned to; it can be about one record (a client, a worker, a contract, an invoice,
 * an inspection or a document), and then shows up with that record. Everybody who may open the page sees every task — a small office works from one list; "mine" is a filter.
 * Taking a task away switches it off and it can be brought back — nothing is deleted.
 */
@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly lists: ListsService,
    private readonly notifications: NotificationsService,
    private readonly links: TaskLinksService,
    private readonly exports: ExportsService,
  ) {}

  /* ── Reading ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  async rowOrThrow(id: string): Promise<TaskRow> {
    const row = await this.prisma.task.findUnique({ where: { id }, include: TASK_INCLUDE });
    if (!row) throw new NotFoundException({ code: 'not_found', message: 'Task not found' });
    return row;
  }

  async views(rows: readonly TaskRow[], today = todayInAmsterdam()) {
    if (!rows.length) return [];
    const userIds = [...new Set(rows.flatMap(row => [row.assigneeId, row.createdById]).filter((id): id is string => Boolean(id)))];
    const users = userIds.length ? await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, title: true } }) : [];
    const byId = new Map(users.map(user => [user.id, user]));
    const person = (id: string | null) => {
      const user = id ? byId.get(id) : undefined;
      return user ? { id: user.id, name: user.name, title: user.title } : null;
    };
    return rows.map(row => {
      const due = day(row.dueDate);
      const open = OPEN_TASK_STATUSES.includes(row.status);
      return {
        id: row.id,
        title: row.title,
        description: row.description,
        status: row.status,
        priority: row.priority,
        open,
        dueDate: due,
        overdue: row.isActive && open && due !== null && due < today,
        assigneeId: row.assigneeId,
        assignee: person(row.assigneeId),
        createdBy: person(row.createdById),
        linkedType: row.linkedType,
        linkedId: row.linkedId,
        linkedLabel: row.linkedLabel,
        client: row.client ? { id: row.client.id, number: row.client.number, name: row.client.name } : null,
        tags: row.tags,
        subtasks: readSubtasks(row.subtasks),
        completedAt: row.completedAt?.toISOString() ?? null,
        isActive: row.isActive,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  }

  private async where(query: Partial<TaskListQuery>, user: AuthenticatedUser, today: string): Promise<Prisma.TaskWhereInput> {
    const terms = fold(query.search ?? '').split(' ').filter(Boolean).slice(0, 6);
    const state = query.state ?? 'active';
    const statuses = split(query.status);
    const priorities = split(query.priority);
    const and: Prisma.TaskWhereInput[] = [];
    for (const term of terms) {
      // A word can be in the text of the task, the number or name of its client, or the name of the person it is assigned to.
      const people = await this.prisma.user.findMany({ where: { name: { contains: term, mode: 'insensitive' } }, select: { id: true }, take: 20 });
      and.push({
        OR: [{ searchText: { contains: term } }, { client: { searchText: { contains: term } } }, { client: { number: { contains: term, mode: 'insensitive' } } }, ...(people.length ? [{ assigneeId: { in: people.map(person => person.id) } }] : [])],
      });
    }
    if (query.tag) and.push({ tags: { has: query.tag } });
    if (query.due === 'overdue') and.push({ status: { in: [...OPEN_TASK_STATUSES] }, dueDate: { lt: parseDay(today) } });
    else if (query.due === 'today') and.push({ dueDate: parseDay(today) });
    else if (query.due === 'week') and.push({ dueDate: { gte: parseDay(today), lte: parseDay(addDays(today, 7)) } });
    return {
      ...(state !== 'all' && { isActive: state === 'active' }),
      ...(query.mine && { assigneeId: user.id }),
      ...(!query.mine && query.assigneeId && { assigneeId: query.assigneeId === 'none' ? null : query.assigneeId }),
      ...(statuses.length && { status: { in: statuses } }),
      ...(priorities.length && { priority: { in: priorities } }),
      ...(query.open !== undefined && { status: query.open ? { in: [...OPEN_TASK_STATUSES] } : { notIn: [...OPEN_TASK_STATUSES] } }),
      ...(query.linkedType && { linkedType: query.linkedType }),
      ...(query.linkedId && { linkedId: query.linkedId }),
      ...(query.clientId && { clientId: query.clientId }),
      AND: and,
    };
  }

  private orderBy(sort: string | undefined): Prisma.TaskOrderByWithRelationInput[] {
    const sorts: Record<string, (direction: 'asc' | 'desc') => Prisma.TaskOrderByWithRelationInput> = {
      dueDate: direction => ({ dueDate: { sort: direction, nulls: 'last' } }),
      title: direction => ({ title: direction }),
      status: direction => ({ status: direction }),
      createdAt: direction => ({ createdAt: direction }),
      completedAt: direction => ({ completedAt: { sort: direction, nulls: 'last' } }),
    };
    const order = split(sort)
      .map(part => part.split(':') as [string, string?])
      .filter(([key]) => key in sorts)
      .map(([key, direction]) => sorts[key]!(direction === 'desc' ? 'desc' : 'asc'));
    return [...(order.length ? order : [sorts.dueDate!('asc')]), { createdAt: 'asc' }];
  }

  async list(query: TaskListQuery, user: AuthenticatedUser): Promise<ApiResult> {
    const today = todayInAmsterdam();
    const where = await this.where(query, user, today);
    const priorityFirst = split(query.sort)[0]?.startsWith('priority');
    let rows: TaskRow[];
    const total = await this.prisma.task.count({ where });
    if (priorityFirst) {
      // Priorities are words, so the database would sort them alphabetically: sort by their rank here and take the page afterwards.
      const direction = split(query.sort)[0]!.endsWith(':desc') ? -1 : 1;
      const slim = await this.prisma.task.findMany({ where, select: { id: true, priority: true, dueDate: true, createdAt: true } });
      slim.sort((a, b) => direction * ((PRIORITY_RANK[a.priority] ?? 0) - (PRIORITY_RANK[b.priority] ?? 0)) || (a.dueDate?.getTime() ?? Infinity) - (b.dueDate?.getTime() ?? Infinity) || a.createdAt.getTime() - b.createdAt.getTime());
      const { skip, take } = toSkipTake(query);
      const ids = slim.slice(skip, skip + take).map(row => row.id);
      const found = await this.prisma.task.findMany({ where: { id: { in: ids } }, include: TASK_INCLUDE });
      rows = ids.map(id => found.find(row => row.id === id)).filter((row): row is TaskRow => Boolean(row));
    } else {
      rows = await this.prisma.task.findMany({ where, orderBy: this.orderBy(query.sort), include: TASK_INCLUDE, ...toSkipTake(query) });
    }
    const extra: Record<string, unknown> = {};
    if (query.stats) extra.stats = await this.stats(query, user, today);
    return paged(await this.views(rows, today), pageMeta(total, query, extra));
  }

  /** The counters above the list: who they are about follows `mine` / `assigneeId`, but not the other filters, so the tiles stay put while the list is narrowed down. */
  private async stats(query: TaskListQuery, user: AuthenticatedUser, today: string) {
    const scope: Prisma.TaskWhereInput = { isActive: true, ...(query.mine && { assigneeId: user.id }), ...(!query.mine && query.assigneeId && { assigneeId: query.assigneeId === 'none' ? null : query.assigneeId }) };
    const open: Prisma.TaskWhereInput = { ...scope, status: { in: [...OPEN_TASK_STATUSES] } };
    const weekAgo = new Date(Date.now() - 6 * 86_400_000);
    const [openCount, dueToday, overdue, dueThisWeek, doneThisWeek] = await Promise.all([
      this.prisma.task.count({ where: open }),
      this.prisma.task.count({ where: { ...open, dueDate: parseDay(today) } }),
      this.prisma.task.count({ where: { ...open, dueDate: { lt: parseDay(today) } } }),
      this.prisma.task.count({ where: { ...open, dueDate: { gte: parseDay(today), lte: parseDay(addDays(today, 7)) } } }),
      this.prisma.task.count({ where: { ...scope, status: DONE_STATUS, completedAt: { gte: weekAgo } } }),
    ]);
    return { open: openCount, dueToday, overdue, dueThisWeek, doneThisWeek };
  }

  async one(id: string) {
    return (await this.views([await this.rowOrThrow(id)]))[0]!;
  }

  /** How many tasks the person still has to do that are due today or earlier (the number in the sidebar). */
  async dueCount(userId: string, today = todayInAmsterdam()): Promise<number> {
    return this.prisma.task.count({ where: { isActive: true, assigneeId: userId, status: { in: [...OPEN_TASK_STATUSES] }, dueDate: { lte: parseDay(today) } } });
  }

  /* ── Checking ─────────────────────────────────────────────────────────────────────────────────────────────────── */

  /** The linked record: both parts or none; a person can only link a record they may open themselves. */
  private async checkLink(type: string | null | undefined, id: string | null | undefined, user: AuthenticatedUser, problems: Record<string, string>) {
    if (!type && !id) return { linkedType: null, linkedId: null, linkedLabel: '', clientId: null };
    if (!type || !id) {
      problems[type ? 'linkedId' : 'linkedType'] = 'validation.required';
      return null;
    }
    const area = LINK_AREAS[type];
    if (!area) {
      problems.linkedType = 'validation.selectOption';
      return null;
    }
    if (!matrixAllows(user.matrix, `${area}.view`)) {
      problems.linkedId = 'validation.invalid';
      return null;
    }
    const link = await this.links.resolve(type, id);
    if (!link) {
      problems.linkedId = 'validation.invalid';
      return null;
    }
    return { linkedType: link.type, linkedId: link.id, linkedLabel: link.label, clientId: link.clientId };
  }

  private async checkAssignee(id: string | null | undefined, problems: Record<string, string>): Promise<void> {
    if (!id) return;
    if (!(await this.prisma.user.findFirst({ where: { id, status: 'active' }, select: { id: true } }))) problems.assigneeId = 'validation.invalid';
  }

  /* ── Changing ─────────────────────────────────────────────────────────────────────────────────────────────────── */

  async create(dto: CreateTaskDto, user: AuthenticatedUser) {
    const problems: Record<string, string> = {};
    const title = dto.title.trim();
    if (!title) problems.title = 'validation.required';
    const [statuses, priorities] = await Promise.all([this.lists.activeCodes(TASK_STATUS_LIST), this.lists.activeCodes(TASK_PRIORITY_LIST)]);
    const status = dto.status ?? 'todo';
    const priority = dto.priority ?? 'medium';
    if (!statuses.has(status)) problems.status = 'validation.selectOption';
    if (!priorities.has(priority)) problems.priority = 'validation.selectOption';
    if (dto.dueDate && !isValidDay(dto.dueDate)) problems.dueDate = 'validation.invalid';
    const assigneeId = dto.assigneeId === undefined ? user.id : dto.assigneeId || null;
    await this.checkAssignee(assigneeId, problems);
    const link = await this.checkLink(dto.linkedType, dto.linkedId, user, problems);
    if (Object.keys(problems).length || !link) throw validationFailed(problems);

    const description = dto.description?.trim() ?? '';
    const tags = cleanTags(dto.tags);
    const subtasks = cleanSubtasks(dto.subtasks);
    const created = await this.prisma.task.create({
      data: {
        title,
        description,
        status,
        priority,
        dueDate: dto.dueDate ? parseDay(dto.dueDate) : null,
        assigneeId,
        linkedType: link.linkedType,
        linkedId: link.linkedId,
        linkedLabel: link.linkedLabel,
        clientId: link.clientId,
        tags,
        subtasks: subtasks as unknown as Prisma.InputJsonValue,
        completedAt: status === DONE_STATUS ? new Date() : null,
        searchText: searchTextOf({ title, description, linkedLabel: link.linkedLabel, tags }),
        createdById: user.id,
      },
      include: TASK_INCLUDE,
    });
    await this.audit.log({ action: 'created', entityType: TASK_ENTITY, entityId: created.id, entityLabel: title, after: { title, status, priority, dueDate: dto.dueDate ?? null, assigneeId, linkedType: link.linkedType, linkedId: link.linkedId } });
    if (assigneeId && assigneeId !== user.id) await this.notifyAssigned(created, user);
    return (await this.views([created]))[0]!;
  }

  async update(id: string, dto: UpdateTaskDto, user: AuthenticatedUser) {
    const row = await this.rowOrThrow(id);
    const problems: Record<string, string> = {};

    let title = row.title;
    if (dto.title !== undefined) {
      title = dto.title.trim();
      if (!title) problems.title = 'validation.required';
    }
    let status = row.status;
    if (dto.status !== undefined && dto.status !== row.status) {
      if (!(await this.lists.activeCodes(TASK_STATUS_LIST)).has(dto.status)) problems.status = 'validation.selectOption';
      status = dto.status;
    }
    let priority = row.priority;
    if (dto.priority !== undefined && dto.priority !== row.priority) {
      if (!(await this.lists.activeCodes(TASK_PRIORITY_LIST)).has(dto.priority)) problems.priority = 'validation.selectOption';
      priority = dto.priority;
    }
    let dueDate = day(row.dueDate);
    if (dto.dueDate !== undefined) {
      dueDate = dto.dueDate || null;
      if (dueDate && !isValidDay(dueDate)) problems.dueDate = 'validation.invalid';
    }
    let assigneeId = row.assigneeId;
    if (dto.assigneeId !== undefined && (dto.assigneeId || null) !== row.assigneeId) {
      assigneeId = dto.assigneeId || null;
      await this.checkAssignee(assigneeId, problems);
    }
    let link = { linkedType: row.linkedType, linkedId: row.linkedId, linkedLabel: row.linkedLabel, clientId: row.clientId } as Awaited<ReturnType<TasksService['checkLink']>>;
    if (dto.linkedType !== undefined || dto.linkedId !== undefined) {
      const type = dto.linkedType === undefined ? row.linkedType : dto.linkedType || null;
      const target = dto.linkedId === undefined ? row.linkedId : dto.linkedId || null;
      // The same record again: keep what was saved (it may have been renamed since, and the person may not be allowed to open it any more).
      link = type === row.linkedType && target === row.linkedId ? link : await this.checkLink(type, target, user, problems);
    }
    if (Object.keys(problems).length || !link) throw validationFailed(problems);

    const description = dto.description === undefined ? row.description : dto.description.trim();
    const tags = dto.tags === undefined ? row.tags : cleanTags(dto.tags);
    const subtasks = dto.subtasks === undefined ? readSubtasks(row.subtasks) : cleanSubtasks(dto.subtasks);
    // Done stamps the moment it was completed; reopening clears it.
    const completedAt = status === DONE_STATUS ? (row.status === DONE_STATUS && row.completedAt ? row.completedAt : new Date()) : null;

    const summary = (list: readonly Subtask[]) => `${list.filter(item => item.done).length}/${list.length}`;
    const before = { title: row.title, description: row.description, status: row.status, priority: row.priority, dueDate: day(row.dueDate), assigneeId: row.assigneeId, linkedType: row.linkedType, linkedId: row.linkedId, tags: row.tags, subtasks: summary(readSubtasks(row.subtasks)) };
    const after = { title, description, status, priority, dueDate, assigneeId, linkedType: link.linkedType, linkedId: link.linkedId, tags, subtasks: summary(subtasks) };
    const diff = AuditService.changes(before, after);
    const subtasksChanged = JSON.stringify(readSubtasks(row.subtasks)) !== JSON.stringify(subtasks);
    if (!Object.keys(diff.after).length && !subtasksChanged) return this.one(id);

    const updated = await this.prisma.task.update({
      where: { id },
      data: {
        title,
        description,
        status,
        priority,
        dueDate: dueDate ? parseDay(dueDate) : null,
        assigneeId,
        linkedType: link.linkedType,
        linkedId: link.linkedId,
        linkedLabel: link.linkedLabel,
        clientId: link.clientId,
        tags,
        subtasks: subtasks as unknown as Prisma.InputJsonValue,
        completedAt,
        searchText: searchTextOf({ title, description, linkedLabel: link.linkedLabel, tags }),
      },
      include: TASK_INCLUDE,
    });
    // One entry says what happened: finished, reopened, handed to somebody, or changed.
    const action = status !== row.status && status === DONE_STATUS ? 'completed' : status !== row.status && row.status === DONE_STATUS ? 'reopened' : assigneeId !== row.assigneeId && Object.keys(diff.after).length === 1 ? 'assigned' : 'updated';
    await this.audit.log({ action, entityType: TASK_ENTITY, entityId: id, entityLabel: title, before: diff.before, after: diff.after });

    if (assigneeId !== row.assigneeId && assigneeId && assigneeId !== user.id) await this.notifyAssigned(updated, user);
    if (status === DONE_STATUS && row.status !== DONE_STATUS && row.createdById && row.createdById !== user.id) await this.notifyCompleted(updated, row.createdById, user);
    return (await this.views([updated]))[0]!;
  }

  /** The round check button: done ↔ to do. */
  async toggle(id: string, user: AuthenticatedUser) {
    const row = await this.rowOrThrow(id);
    return this.update(id, { status: row.status === DONE_STATUS ? 'todo' : DONE_STATUS }, user);
  }

  /** Takes a task away (it stays for history) or brings it back. */
  async setActive(id: string, isActive: boolean, user: AuthenticatedUser) {
    const row = await this.rowOrThrow(id);
    if (row.isActive === isActive) return this.one(id);
    await this.prisma.task.update({ where: { id }, data: isActive ? { isActive: true, deactivatedAt: null, deactivatedById: null } : { isActive: false, deactivatedAt: new Date(), deactivatedById: user.id } });
    await this.audit.log({ action: isActive ? 'activated' : 'deactivated', entityType: TASK_ENTITY, entityId: id, entityLabel: row.title });
    return this.one(id);
  }

  /* ── Telling people ───────────────────────────────────────────────────────────────────────────────────────────── */

  private async notifyAssigned(task: TaskRow, actor: AuthenticatedUser): Promise<void> {
    if (!task.assigneeId) return;
    const urgent = task.priority === 'urgent' || (task.dueDate !== null && formatDay(task.dueDate) <= todayInAmsterdam());
    await this.notifications.deliver([
      { userId: task.assigneeId, channels: ['in_app'], draft: { type: 'task', severity: urgent ? 'warning' : 'info', textKey: 'task.assigned', params: { person: actor.name, detail: [task.title, task.linkedLabel].filter(Boolean).join(' · ') }, entityType: TASK_ENTITY, entityId: task.id, link: `/tasks?task=${task.id}` } },
    ]);
  }

  private async notifyCompleted(task: TaskRow, creatorId: string, actor: AuthenticatedUser): Promise<void> {
    await this.notifications.deliver([
      { userId: creatorId, channels: ['in_app'], draft: { type: 'task', severity: 'info', textKey: 'task.completed', params: { person: actor.name, detail: [task.title, task.linkedLabel].filter(Boolean).join(' · ') }, entityType: TASK_ENTITY, entityId: task.id, link: `/tasks?task=${task.id}` } },
    ]);
  }

  /* ── Export ───────────────────────────────────────────────────────────────────────────────────────────────────── */

  async exportTable(query: TaskExportQuery, user: AuthenticatedUser, locale: AppLocale): Promise<ExportTable> {
    const today = todayInAmsterdam();
    const where = await this.where(query, user, today);
    this.exports.assertSize(await this.prisma.task.count({ where }));
    const rows = await this.prisma.task.findMany({ where, orderBy: this.orderBy(query.sort), include: TASK_INCLUDE });
    const views = await this.views(rows, today);
    const names = await this.listNames(locale);
    const nl = locale === 'nl';
    const subtitle = [query.mine ? (nl ? 'Mijn taken' : 'My tasks') : '', query.open === true ? (nl ? 'alleen open' : 'open only') : '', query.search?.trim() ? `${nl ? 'Zoekterm' : 'Search'}: ${query.search.trim()}` : ''].filter(Boolean).join(' · ');
    return {
      title: nl ? 'Taken' : 'Tasks',
      subtitle: subtitle || undefined,
      locale,
      columns: [
        { key: 'title', header: nl ? 'Taak' : 'Task', width: 36 },
        { key: 'status', header: 'Status', width: 16 },
        { key: 'priority', header: nl ? 'Prioriteit' : 'Priority', width: 12 },
        { key: 'dueDate', header: nl ? 'Einddatum' : 'Due date', type: 'date', width: 12 },
        { key: 'assignee', header: nl ? 'Toegewezen aan' : 'Assigned to', width: 22 },
        { key: 'number', header: nl ? 'Klantnr.' : 'Client no.', width: 10 },
        { key: 'client', header: nl ? 'Klant' : 'Client', width: 26 },
        { key: 'about', header: nl ? 'Gaat over' : 'About', width: 26 },
        { key: 'tags', header: 'Tags', width: 20 },
        { key: 'completedAt', header: nl ? 'Afgerond op' : 'Completed on', type: 'datetime', width: 16 },
      ],
      rows: views.map(task => ({
        title: task.title,
        status: names.status.get(task.status) ?? task.status,
        priority: names.priority.get(task.priority) ?? task.priority,
        dueDate: task.dueDate,
        assignee: task.assignee?.name ?? '',
        number: task.client?.number ?? '',
        client: task.client?.name ?? '',
        about: task.linkedLabel,
        tags: task.tags.join(', '),
        completedAt: task.completedAt,
      })),
    };
  }

  private async listNames(locale: AppLocale) {
    const items = await this.prisma.listItem.findMany({ where: { list: { key: { in: [TASK_STATUS_LIST, TASK_PRIORITY_LIST] } } }, select: { code: true, nameNl: true, nameEn: true, list: { select: { key: true } } } });
    const pick = (key: string) => new Map(items.filter(item => item.list.key === key).map(item => [item.code, locale === 'nl' ? item.nameNl : item.nameEn]));
    return { status: pick(TASK_STATUS_LIST), priority: pick(TASK_PRIORITY_LIST) };
  }
}
