import { Injectable, NotFoundException } from '@nestjs/common';
import { ApiResult } from '../../common/api-result.js';
import { addDays, daysBetween, formatDay, isValidDay, parseDay, todayInAmsterdam } from '../../common/dates.js';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { validationFailed } from '../../common/validation/failure.js';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { personName } from '../people/person-record.js';
import { matrixAllows } from '../roles/permission-catalog.js';
import { TaxCalendarService } from '../taxes/tax-calendar.service.js';
import { OPEN_TASK_STATUSES } from '../tasks/tasks.constants.js';
import { EVENT_TYPES, MAX_RANGE_DAYS } from './agenda.constants.js';
import { AgendaEventsService, type CalendarEntry } from './agenda-events.service.js';
import type { FeedQuery } from './dto/agenda.dto.js';

type ClientRef = { id: string; number: string; name: string };

const CONTRACT_SELECT = {
  id: true,
  endDate: true,
  type: true,
  status: true,
  client: { select: { id: true, number: true, name: true } },
  employee: { select: { person: { select: { firstName: true, lastName: true, data: true } } } },
} satisfies Prisma.ContractSelect;
type ContractRow = Prisma.ContractGetPayload<{ select: typeof CONTRACT_SELECT }>;

const INSPECTION_INCLUDE = { client: { select: { id: true, number: true, name: true } } } satisfies Prisma.InspectionInclude;
type InspectionRow = Prisma.InspectionGetPayload<{ include: typeof INSPECTION_INCLUDE }>;
const OPEN_INSPECTION_STATUSES = ['planned', 'in_progress', 'awaiting_result'];

const TASK_INCLUDE = { client: { select: { id: true, number: true, name: true } } } satisfies Prisma.TaskInclude;
type TaskRow = Prisma.TaskGetPayload<{ include: typeof TASK_INCLUDE }>;

/** "J. Jansen": an initial and the last name keep an entry short enough for a calendar chip. */
const shortPerson = (person: { firstName: string; lastName: string; data: unknown }): string => (person.lastName ? `${person.firstName ? `${person.firstName[0]}. ` : ''}${person.lastName}` : personName(person as never));

const compare = (a: CalendarEntry, b: CalendarEntry): number =>
  a.start.slice(0, 10).localeCompare(b.start.slice(0, 10)) || Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start) || a.title.localeCompare(b.title);

/**
 * The calendar page: the appointments people made, together with the dates that come from other records — a contract that ends, a task that is due, a VAT or tax deadline, an
 * inspection. Those are worked out every time the calendar is read (so they are never out of date), are read-only here, and only show to people who may open the area they
 * come from. Public holidays are asked from the calendar of the office by the page itself.
 */
@Injectable()
export class AgendaFeedService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: AgendaEventsService,
    private readonly taxCalendar: TaxCalendarService,
  ) {}

  /** `?from=&to=` as days; without them the next 30 days. */
  range(query: Pick<FeedQuery, 'from' | 'to'>): { from: string; to: string } {
    const today = todayInAmsterdam();
    const from = query.from ?? today;
    const to = query.to ?? addDays(from, 30);
    const problems: Record<string, string> = {};
    if (!isValidDay(from)) problems.from = 'validation.invalidDate';
    if (!isValidDay(to)) problems.to = 'validation.invalidDate';
    if (!problems.from && !problems.to) {
      if (to < from) problems.to = 'validation.endBeforeStart';
      else if (daysBetween(from, to) > MAX_RANGE_DAYS) problems.to = 'calendar.rangeTooLong';
    }
    if (Object.keys(problems).length) throw validationFailed(problems);
    return { from, to };
  }

  /** Everything on the calendar between two days, for this person and in this language. `meta.counts` is the number of entries per kind before the `types` filter (the legend). */
  async feed(query: FeedQuery, user: AuthenticatedUser, locale: AppLocale): Promise<ApiResult> {
    const { from, to } = this.range(query);
    const today = todayInAmsterdam();
    const can = (area: string) => matrixAllows(user.matrix, `${area}.view`);
    const [stored, contracts, tasks, inspections, deadlines] = await Promise.all([
      this.events.inRange(from, to, query.clientId),
      can('contracts') ? this.contracts(from, to, query.clientId, locale, today) : [],
      can('tasks') ? this.tasks(from, to, query.clientId, locale, today) : [],
      can('inspections') ? this.inspections(from, to, query.clientId, locale, today) : [],
      // A VAT period belongs to everybody at once: the deadlines are only on the calendar when it is not narrowed down to one client.
      can('taxes') && !query.clientId ? this.deadlines(from, to, locale, today) : [],
    ]);
    let entries = [...stored, ...contracts, ...tasks, ...inspections, ...deadlines];

    const counts = Object.fromEntries(EVENT_TYPES.map(type => [type, 0])) as Record<string, number>;
    for (const entry of entries) counts[entry.type] = (counts[entry.type] ?? 0) + 1;

    const types = (query.types ?? '')
      .split(',')
      .map(type => type.trim())
      .filter(type => (EVENT_TYPES as readonly string[]).includes(type));
    if (types.length) entries = entries.filter(entry => types.includes(entry.type));
    entries.sort(compare);
    return new ApiResult(entries, { total: entries.length, from, to, counts });
  }

  /** One entry: an appointment, or a derived one (`derived:contract:<id>`, `derived:task:<id>`, `derived:inspection:<id>`). */
  async one(id: string, user: AuthenticatedUser, locale: AppLocale): Promise<CalendarEntry> {
    if (!id.startsWith('derived:')) return this.events.one(id);
    const [, kind, recordId] = id.split(':');
    const today = todayInAmsterdam();
    const can = (area: string) => matrixAllows(user.matrix, `${area}.view`);
    if (kind === 'contract' && recordId && can('contracts')) {
      const row = await this.prisma.contract.findFirst({ where: { id: recordId, status: 'active', endDate: { not: null } }, select: CONTRACT_SELECT });
      if (row) return this.contractEntry(row, locale, today, await this.contractTypes(locale));
    }
    if (kind === 'task' && recordId && can('tasks')) {
      const row = await this.prisma.task.findFirst({ where: { id: recordId, isActive: true, status: { in: [...OPEN_TASK_STATUSES] }, dueDate: { not: null } }, include: TASK_INCLUDE });
      if (row) return (await this.taskEntries([row], locale, today))[0]!;
    }
    if ((kind === 'inspection' || kind === 'inspection_response') && recordId && can('inspections')) {
      const row = await this.prisma.inspection.findFirst({ where: { id: recordId, isActive: true }, include: INSPECTION_INCLUDE });
      if (row) {
        const names = await this.inspectionNames(locale);
        const entry = this.inspectionEntries([row], names, locale, today).find(candidate => candidate.id === id);
        if (entry) return entry;
      }
    }
    throw new NotFoundException({ code: 'not_found', message: 'Appointment not found' });
  }

  /* ── Derived entries ──────────────────────────────────────────────────────────────────────────────────────────── */

  private derived(entry: { id: string; type: string; title: string; description: string; day: string; client: ClientRef | null; entity: { type: string; id: string; label: string } | null; managedBy: string; href: string; overdue: boolean; record: Record<string, unknown> | null }): CalendarEntry {
    return {
      id: entry.id,
      title: entry.title,
      type: entry.type,
      start: entry.day,
      end: entry.day,
      allDay: true,
      location: '',
      description: entry.description,
      attendees: [],
      client: entry.client,
      entity: entry.entity,
      source: 'derived',
      managedBy: entry.managedBy,
      readOnly: true,
      href: entry.href,
      overdue: entry.overdue,
      record: entry.record,
      meetingLink: null,
      reminderMinutes: null,
      createdBy: null,
      createdAt: null,
      updatedAt: null,
    };
  }

  private async contractTypes(locale: AppLocale): Promise<Map<string, string>> {
    const items = await this.prisma.listItem.findMany({ where: { list: { key: 'contract_type' } }, select: { code: true, nameNl: true, nameEn: true } });
    return new Map(items.map(item => [item.code, locale === 'nl' ? item.nameNl : item.nameEn]));
  }

  private contractEntry(row: ContractRow, locale: AppLocale, today: string, types: ReadonlyMap<string, string>): CalendarEntry {
    const nl = locale === 'nl';
    const day = formatDay(row.endDate!);
    const worker = shortPerson(row.employee.person);
    const full = personName(row.employee.person);
    return this.derived({
      id: `derived:contract:${row.id}`,
      type: 'contract',
      title: `${nl ? 'Contract eindigt' : 'Contract ends'} · ${worker}`,
      description: nl ? `Het contract van ${full} (${row.client.name}) eindigt: verlengen, beëindigen of laten aflopen.` : `The contract of ${full} (${row.client.name}) ends — renew it, end it or let it expire.`,
      day,
      client: row.client,
      entity: { type: 'contract', id: row.id, label: `${full} · ${row.client.number}` },
      managedBy: 'contracts',
      href: `/contracts/${row.id}`,
      overdue: day < today,
      record: { status: row.status, contractType: types.get(row.type) ?? row.type, worker: full },
    });
  }

  private async contracts(from: string, to: string, clientId: string | undefined, locale: AppLocale, today: string): Promise<CalendarEntry[]> {
    const [rows, types] = await Promise.all([
      this.prisma.contract.findMany({ where: { status: 'active', endDate: { gte: parseDay(from), lte: parseDay(to) }, ...(clientId && { clientId }) }, select: CONTRACT_SELECT, orderBy: { endDate: 'asc' } }),
      this.contractTypes(locale),
    ]);
    return rows.map(row => this.contractEntry(row, locale, today, types));
  }

  private async taskEntries(rows: readonly TaskRow[], locale: AppLocale, today: string): Promise<CalendarEntry[]> {
    const nl = locale === 'nl';
    const ids = [...new Set(rows.map(row => row.assigneeId).filter((id): id is string => Boolean(id)))];
    const users = ids.length ? await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
    const names = new Map(users.map(user => [user.id, user.name]));
    return rows.map(row => {
      const day = formatDay(row.dueDate!);
      const assignee = row.assigneeId ? (names.get(row.assigneeId) ?? null) : null;
      return this.derived({
        id: `derived:task:${row.id}`,
        type: 'task',
        title: row.title,
        description: row.description || (assignee ? (nl ? `Toegewezen aan ${assignee}.` : `Assigned to ${assignee}.`) : nl ? 'Niet toegewezen.' : 'Not assigned.'),
        day,
        client: row.client,
        entity: { type: 'task', id: row.id, label: row.title },
        managedBy: 'tasks',
        href: `/tasks?task=${row.id}`,
        overdue: day < today,
        record: { status: row.status, priority: row.priority, assignee, linked: row.linkedType && row.linkedId ? { type: row.linkedType, id: row.linkedId, label: row.linkedLabel } : null },
      });
    });
  }

  private async tasks(from: string, to: string, clientId: string | undefined, locale: AppLocale, today: string): Promise<CalendarEntry[]> {
    const rows = await this.prisma.task.findMany({
      where: { isActive: true, status: { in: [...OPEN_TASK_STATUSES] }, dueDate: { gte: parseDay(from), lte: parseDay(to) }, ...(clientId && { clientId }) },
      include: TASK_INCLUDE,
      orderBy: { dueDate: 'asc' },
    });
    return this.taskEntries(rows, locale, today);
  }

  private async inspectionNames(locale: AppLocale) {
    const items = await this.prisma.listItem.findMany({ where: { list: { key: { in: ['inspection_type', 'inspection_body'] } } }, select: { code: true, nameNl: true, nameEn: true, list: { select: { key: true } } } });
    const pick = (key: string) => new Map(items.filter(item => item.list.key === key).map(item => [item.code, locale === 'nl' ? item.nameNl : item.nameEn]));
    return { type: pick('inspection_type'), body: pick('inspection_body') };
  }

  private inspectionEntries(rows: readonly InspectionRow[], names: { type: Map<string, string>; body: Map<string, string> }, locale: AppLocale, today: string): CalendarEntry[] {
    const nl = locale === 'nl';
    return rows.flatMap(row => {
      const open = OPEN_INSPECTION_STATUSES.includes(row.status);
      const type = names.type.get(row.type) ?? row.type;
      const body = names.body.get(row.body) ?? row.body;
      const day = formatDay(row.date);
      const base = { type: 'inspection', client: row.client, entity: { type: 'inspection', id: row.id, label: `${row.number} · ${row.client.name}` }, managedBy: 'inspections', href: `/inspections/${row.id}` };
      const entries = [this.derived({ ...base, id: `derived:inspection:${row.id}`, title: `${nl ? 'Controle' : 'Inspection'} · ${row.client.name}`, description: `${type} — ${body}${row.inspectorName ? ` (${row.inspectorName})` : ''}`, day, overdue: open && day < today, record: { number: row.number, status: row.status, inspectionType: type, body } })];
      if (row.responseDue && open) {
        const due = formatDay(row.responseDue);
        entries.push(this.derived({ ...base, type: 'deadline', id: `derived:inspection_response:${row.id}`, title: `${nl ? 'Stukken voor controle' : 'Documents for inspection'} · ${row.client.name}`, description: nl ? `De stukken voor controle ${row.number} moeten er ${due.slice(8, 10)}-${due.slice(5, 7)}-${due.slice(0, 4)} zijn.` : `The documents for inspection ${row.number} are due on ${due}.`, day: due, overdue: due < today, record: { number: row.number, status: row.status } }));
      }
      return entries;
    });
  }

  private async inspections(from: string, to: string, clientId: string | undefined, locale: AppLocale, today: string): Promise<CalendarEntry[]> {
    const range = { gte: parseDay(from), lte: parseDay(to) };
    const rows = await this.prisma.inspection.findMany({
      where: { isActive: true, status: { not: 'cancelled' }, OR: [{ date: range }, { responseDue: range, status: { in: OPEN_INSPECTION_STATUSES } }], ...(clientId && { clientId }) },
      include: INSPECTION_INCLUDE,
      orderBy: { date: 'asc' },
    });
    const names = await this.inspectionNames(locale);
    return this.inspectionEntries(rows, names, locale, today).filter(entry => entry.start >= from && entry.start <= to);
  }

  private async deadlines(from: string, to: string, locale: AppLocale, today: string): Promise<CalendarEntry[]> {
    const nl = locale === 'nl';
    const found = await this.taxCalendar.between(from, to, locale);
    return found.map(deadline => {
      const name = deadline.kind === 'vat' ? (nl ? 'Btw' : 'VAT') : deadline.kind === 'income_tax' ? (nl ? 'Inkomstenbelasting' : 'Income tax') : nl ? 'Vennootschapsbelasting' : 'Corporate income tax';
      const description = !deadline.open
        ? nl
          ? `Alle ${deadline.total} aangiften zijn verstuurd.`
          : `All ${deadline.total} returns have been filed.`
        : nl
          ? `${deadline.open} van de ${deadline.total} aangiften ${deadline.open === 1 ? 'is' : 'zijn'} nog niet verstuurd.`
          : `${deadline.open} of the ${deadline.total} returns ${deadline.open === 1 ? 'has' : 'have'} not been filed yet.`;
      return this.derived({
        id: `derived:${deadline.id}`,
        type: 'deadline',
        title: `${name} ${deadline.label} · ${nl ? 'deadline' : 'deadline'}`,
        description,
        day: deadline.dueOn,
        client: null,
        entity: null,
        managedBy: 'taxes',
        href: deadline.link,
        overdue: deadline.open > 0 && deadline.dueOn < today,
        record: { open: deadline.open, total: deadline.total, kind: deadline.kind },
      });
    });
  }
}
