import { Injectable, Logger } from '@nestjs/common';
import { addDays, formatDay, parseDay, todayInAmsterdam } from '../../common/dates.js';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import type { ActivityListQuery } from '../activity/dto/activity-query.dto.js';
import { ActivityService } from '../activity/activity.service.js';
import { AgendaFeedService } from '../agenda/agenda-feed.service.js';
import { CalendarService } from '../calendar/calendar.service.js';
import { ContractsService } from '../contracts/contracts.service.js';
import type { RequirementQuery } from '../documents/dto/documents.dto.js';
import { DocumentRequirementsService } from '../documents/document-requirements.service.js';
import { InspectionsService } from '../inspections/inspections.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import type { NotificationListQuery } from '../notifications/dto/notification.dto.js';
import { personName } from '../people/person-record.js';
import type { ReconciliationQuery } from '../reconciliation/dto/reconciliation.dto.js';
import { ReconciliationService } from '../reconciliation/reconciliation.service.js';
import { matrixAllows } from '../roles/permission-catalog.js';
import type { TaskListQuery } from '../tasks/dto/tasks.dto.js';
import { TasksService } from '../tasks/tasks.service.js';
import { TaxesAttentionService } from '../taxes/taxes-attention.service.js';

export type AttentionTone = 'danger' | 'warning' | 'info';

/** One line of "needs attention": what it is, how many, how urgent. The page decides the words and the link (it knows its own screens). */
export interface AttentionItem {
  key: string;
  count: number;
  tone: AttentionTone;
}

/** The previous calendar month, `YYYY-MM`. */
const previousMonth = (today: string): string => {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
};

const TONE_ORDER: Record<AttentionTone, number> = { danger: 0, warning: 1, info: 2 };

/**
 * The dashboard: one request that says what is going on in the office, for the person who asks. Every section is only there when the person may open the area it comes from
 * (a staff member without Invoices simply gets a shorter dashboard), and a section that cannot be worked out is left out instead of breaking the whole page.
 */
@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);
  /** The reconciliation of last month is heavy and changes slowly: it is worked out at most every ten minutes. */
  private differences: { month: string; at: number; value: { workers: number; differences: number } } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly contracts: ContractsService,
    private readonly requirements: DocumentRequirementsService,
    private readonly inspections: InspectionsService,
    private readonly taxes: TaxesAttentionService,
    private readonly reconciliation: ReconciliationService,
    private readonly tasks: TasksService,
    private readonly notifications: NotificationsService,
    private readonly feed: AgendaFeedService,
    private readonly calendar: CalendarService,
    private readonly activity: ActivityService,
  ) {}

  /** Runs a section; one that fails is logged and left out. */
  private async safe<T>(name: string, run: () => Promise<T>): Promise<T | undefined> {
    try {
      return await run();
    } catch (error) {
      this.logger.warn(`The dashboard section "${name}" could not be worked out: ${(error as Error).message.split('\n')[0]}`);
      return undefined;
    }
  }

  async overview(user: AuthenticatedUser, locale: AppLocale) {
    const can = (area: string) => matrixAllows(user.matrix, `${area}.view`);
    const today = todayInAmsterdam();
    const [contracts, documents, invoices, hours, taxes, inspections, tasks, agenda, activity, reminders] = await Promise.all([
      can('contracts') ? this.safe('contracts', () => this.contractsSection(today)) : undefined,
      can('documents') ? this.safe('documents', () => this.documentsSection(user, locale)) : undefined,
      can('invoices') ? this.safe('invoices', () => this.invoicesSection(today)) : undefined,
      can('invoices') && can('hours') ? this.safe('hours', () => this.hoursSection(today)) : undefined,
      can('taxes') ? this.safe('taxes', () => this.taxes.summary()) : undefined,
      can('inspections') ? this.safe('inspections', () => this.inspections.attention()) : undefined,
      can('tasks') ? this.safe('tasks', () => this.tasksSection(user)) : undefined,
      can('calendar') ? this.safe('agenda', () => this.agendaSection(user, locale, today)) : undefined,
      can('activity') ? this.safe('activity', () => this.activitySection()) : undefined,
      can('notifications') ? this.safe('reminders', () => this.remindersSection(user, locale)) : undefined,
    ]);

    const attention: AttentionItem[] = [];
    const add = (key: string, count: number | undefined, tone: AttentionTone) => {
      if (count && count > 0) attention.push({ key, count, tone });
    };
    if (taxes) add('taxesOverdue', taxes.vat.overdue + taxes.incomeTax.overdue + taxes.corporateTax.overdue, 'danger');
    if (inspections) add('inspectionsNotReady', inspections.notReady, 'danger');
    if (documents) {
      add('documentsExpired', documents.expired, 'danger');
      add('documentsMissing', documents.missing, 'warning');
    }
    if (contracts) add('contractsEnding', contracts.expiring, 'warning');
    if (invoices) {
      add('invoicesOverdue', invoices.outgoingOverdue.count, 'warning');
      add('invoicesToCheck', invoices.toCheck, 'info');
    }
    if (hours) add('hoursDifferences', hours.differences, 'warning');
    if (tasks) add('tasksOverdue', tasks.overdue, 'warning');
    if (documents) add('documentsExpiring', documents.expiring, 'info');
    attention.sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone]);

    return { greetingName: user.name.split(' ')[0] ?? user.name, today, contracts, documents, invoices, hours, taxes, inspections, tasks, agenda, activity, reminders, attention };
  }

  /* ── Sections ─────────────────────────────────────────────────────────────────────────────────────────────────── */

  private async contractsSection(today: string) {
    const [stats, next] = await Promise.all([
      this.contracts.stats(),
      this.prisma.contract.findFirst({
        where: { status: 'active', endDate: { gte: parseDay(today) } },
        orderBy: { endDate: 'asc' },
        select: { id: true, endDate: true, client: { select: { number: true, name: true } }, employee: { select: { person: { select: { firstName: true, lastName: true, data: true } } } } },
      }),
    ]);
    const counts = stats as unknown as Record<string, number>;
    return {
      active: counts.active ?? 0,
      expiring: stats.expiring,
      expiringDays: stats.expiringDays,
      pending: (counts.draft ?? 0) + (counts.sent ?? 0),
      withoutScan: stats.withoutScan,
      next: next ? { id: next.id, employee: personName(next.employee.person), client: `${next.client.number} ${next.client.name}`, endDate: formatDay(next.endDate!) } : null,
    };
  }

  private async documentsSection(user: AuthenticatedUser, locale: AppLocale) {
    const result = await this.requirements.list({ page: 1, pageSize: 1, state: 'all' } as RequirementQuery, user, locale);
    const counts = (result.meta as { counts: { missing: number; expired: number; expiring: number; ok: number }; clients: number }) ?? { counts: { missing: 0, expired: 0, expiring: 0, ok: 0 }, clients: 0 };
    return { missing: counts.counts.missing, expired: counts.counts.expired, expiring: counts.counts.expiring, clients: counts.clients };
  }

  private async invoicesSection(today: string) {
    const day = parseDay(today);
    const outgoing = { direction: 'outgoing', kind: 'invoice', status: 'sent' };
    const [toCheck, open, overdue] = await Promise.all([
      this.prisma.invoice.count({ where: { direction: 'incoming', kind: 'invoice', status: 'received' } }),
      this.prisma.invoice.aggregate({ where: outgoing, _count: { _all: true }, _sum: { total: true } }),
      this.prisma.invoice.aggregate({ where: { ...outgoing, dueDate: { lt: day } }, _count: { _all: true }, _sum: { total: true } }),
    ]);
    return {
      toCheck,
      outgoingOpen: { count: open._count._all, total: open._sum.total?.toNumber() ?? 0 },
      outgoingOverdue: { count: overdue._count._all, total: overdue._sum.total?.toNumber() ?? 0 },
    };
  }

  /** Workers whose registered hours, pay and invoices of last month do not match. */
  private async hoursSection(today: string) {
    const month = previousMonth(today);
    if (!this.differences || this.differences.month !== month || Date.now() - this.differences.at > 600_000) {
      const result = await this.reconciliation.report({ month, page: 1, pageSize: 1, status: 'all' } as ReconciliationQuery, false);
      const counts = (result.meta as { counts: { workers: number; differences: number } }).counts;
      this.differences = { month, at: Date.now(), value: counts };
    }
    return { month, workers: this.differences.value.workers, differences: this.differences.value.differences };
  }

  private async tasksSection(user: AuthenticatedUser) {
    const result = await this.tasks.list({ page: 1, pageSize: 5, mine: true, open: true, sort: 'dueDate:asc', stats: true } as TaskListQuery, user);
    const stats = (result.meta as { stats: { open: number; overdue: number; dueToday: number } }).stats;
    return { open: stats.open, overdue: stats.overdue, dueToday: stats.dueToday, items: result.data as unknown[] };
  }

  /** The next seven days: appointments, deadlines, inspections, contract ends, tasks that are due and public holidays — the first few, in order. */
  private async agendaSection(user: AuthenticatedUser, locale: AppLocale, today: string) {
    const to = addDays(today, 7);
    const [feed, holidays] = await Promise.all([this.feed.feed({ from: today, to }, user, locale), this.calendar.list({ from: today, to, includeInactive: false, locale })]);
    const entries = (feed.data as Array<{ id: string; title: string; type: string; start: string; allDay: boolean; location: string; client: { name: string } | null; href: string | null; overdue: boolean; source: string }>).map(entry => ({
      id: entry.id,
      date: entry.start.slice(0, 10),
      time: entry.allDay ? null : entry.start.slice(11, 16),
      type: entry.type,
      title: entry.title,
      subtitle: entry.location || entry.client?.name || '',
      href: entry.href,
      overdue: entry.overdue,
    }));
    const off = holidays.map(holiday => ({ id: `holiday:${holiday.id}`, date: holiday.date, time: null, type: 'holiday', title: holiday.name, subtitle: '', href: `/calendar?date=${holiday.date}`, overdue: false }));
    return [...entries, ...off].sort((a, b) => `${a.date} ${a.time ?? '00:00'}`.localeCompare(`${b.date} ${b.time ?? '00:00'}`)).slice(0, 8);
  }

  private async activitySection() {
    const result = await this.activity.list({ page: 1, pageSize: 7 } as ActivityListQuery);
    return result.data;
  }

  /** What is waiting in the person's inbox: the reminders of the system (contracts that end, documents that expire, deadlines …). */
  private async remindersSection(user: AuthenticatedUser, locale: AppLocale) {
    const result = await this.notifications.list(user.id, { page: 1, pageSize: 5, read: 'false' } as NotificationListQuery, locale);
    const unread = (result.meta as { counts: { unread: number } }).counts.unread;
    return { unread, items: result.data as unknown[] };
  }

  /* ── The numbers in the sidebar ───────────────────────────────────────────────────────────────────────────────── */

  /** `{ tasks, notifications }` — tasks of mine that are due today or earlier, and unread notifications. Zero for what the person may not open. */
  async badges(user: AuthenticatedUser) {
    const can = (area: string) => matrixAllows(user.matrix, `${area}.view`);
    const [tasks, notifications] = await Promise.all([can('tasks') ? this.tasks.dueCount(user.id) : 0, can('notifications') ? this.notifications.unreadCount(user.id) : 0]);
    return { tasks, notifications };
  }
}
