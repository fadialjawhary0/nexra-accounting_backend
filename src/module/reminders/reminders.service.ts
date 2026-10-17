import { Injectable, Logger, NotFoundException, type OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { addDays, daysBetween, parseDay, todayInAmsterdam } from '../../common/dates.js';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import { validationFailed } from '../../common/validation/failure.js';
import { Prisma, type ReminderRule } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { SettingsService } from '../../lib/settings/settings.service.js';
import { CalendarService } from '../calendar/calendar.service.js';
import { NotificationsService, type Channel, type Delivery } from '../notifications/notifications.service.js';
import { effectiveMatrix, matrixAllows, type PermissionMatrix } from '../roles/permission-catalog.js';
import type { CreateReminderRuleDto, RecipientsDto, UpdateReminderRuleDto } from './dto/reminder.dto.js';
import { REMINDERS_DEFINITIONS, REMINDERS_NAMESPACE, type Recipients, type ReminderItem, type ReminderProvider } from './reminder-types.js';

export interface RunReport {
  rules: number;
  reminders: number;
  inApp: number;
  email: number;
}

const toOffsets = (value: unknown): number[] => [...new Set((Array.isArray(value) ? value : []).map(Number).filter(offset => Number.isInteger(offset) && offset >= 0))].sort((a, b) => b - a);
const toChannels = (value: unknown): Channel[] => (Array.isArray(value) ? value : []).filter((channel): channel is Channel => channel === 'in_app' || channel === 'email');
const toRecipients = (value: unknown): Recipients => {
  const source = (value && typeof value === 'object' ? value : {}) as Partial<Recipients>;
  return { roles: Array.isArray(source.roles) ? source.roles.map(String) : [], users: Array.isArray(source.users) ? source.users.map(String) : [], responsible: source.responsible === true };
};

/** How urgent a reminder is: the nearer the date, the louder. */
const severityFor = (days: number): 'info' | 'warning' | 'critical' => (days <= 3 ? 'critical' : days <= 14 ? 'warning' : 'info');

/**
 * Reminders: "tell these people N days before something happens". Features register what can be watched (a contract's end, the end of a probation,
 * one year of on-call work); a rule says how many days before — in calendar days or in working days of the Dutch calendar —, who is told, and
 * whether in the app, by e-mail or both. The engine runs every hour after the chosen time of day; what was sent is remembered, so nothing is told
 * twice, and a reminder that was missed (the server was off) is made up for with the most urgent message only. A changed date reminds again.
 */
@Injectable()
export class RemindersService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RemindersService.name);
  private readonly providers = new Map<string, ReminderProvider>();
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly calendar: CalendarService,
    private readonly notifications: NotificationsService,
  ) {
    settings.register(REMINDERS_NAMESPACE, REMINDERS_DEFINITIONS, { exposed: true });
  }

  /** A feature registers a trigger once, when it starts. */
  register(provider: ReminderProvider): void {
    this.providers.set(provider.trigger, provider);
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.tick().catch(error => this.logger.warn(`Reminders could not run at start-up: ${(error as Error).message}`));
  }

  /* ── The engine ───────────────────────────────────────────────────────────────────────────────────────────────── */

  /** Every hour (office time): from the chosen hour on, make the reminders that are due. Running again the same day only finds what is new. */
  @Cron('5 * * * *', { timeZone: 'Europe/Amsterdam' })
  async tick(): Promise<void> {
    if (!this.settings.get<boolean>(`${REMINDERS_NAMESPACE}.enabled`)) return;
    const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Europe/Amsterdam' }).format(new Date()));
    if (hour < this.settings.get<number>(`${REMINDERS_NAMESPACE}.runHour`)) return;
    await this.run();
  }

  /** Makes every reminder that is due today and has not been made yet. */
  async run(): Promise<RunReport> {
    const report: RunReport = { rules: 0, reminders: 0, inApp: 0, email: 0 };
    if (this.running) return report;
    this.running = true;
    try {
      const today = todayInAmsterdam();
      const rules = await this.prisma.reminderRule.findMany({ where: { isActive: true }, orderBy: { createdAt: 'asc' } });
      const items = new Map<string, ReminderItem[]>();
      const deliveries: Delivery[] = [];

      for (const rule of rules) {
        const provider = this.providers.get(rule.trigger);
        if (!provider) continue;
        report.rules += 1;
        if (!items.has(rule.trigger)) items.set(rule.trigger, await provider.items(today));
        const offsets = toOffsets(rule.offsets);
        const channels = toChannels(rule.channels);
        if (!offsets.length || !channels.length) continue;

        for (const item of items.get(rule.trigger)!) {
          const reached = offsets.filter(offset => this.notifyOn(item, offset, rule.dayType) <= today);
          if (!reached.length) continue;
          const recorded = await this.prisma.reminderSent.findMany({ where: { ruleId: rule.id, subjectType: item.subjectType, subjectId: item.subjectId, dueOn: parseDay(item.dueOn) }, select: { offset: true } });
          const done = new Set(recorded.map(row => row.offset));
          const fresh = reached.filter(offset => !done.has(offset));
          if (!fresh.length) continue;

          const recipients = await this.recipients(rule, item, provider);
          if (!recipients.length) continue;
          // A reminder that is late (the item was added after the first offset, or the server was off) says it once, with the most urgent offset.
          const fire = Math.min(...fresh);
          await this.prisma.reminderSent.createMany({
            data: fresh.map(offset => ({ ruleId: rule.id, subjectType: item.subjectType, subjectId: item.subjectId, dueOn: parseDay(item.dueOn), offset, outcome: offset === fire ? 'sent' : 'skipped' })),
            skipDuplicates: true,
          });
          const days = daysBetween(today, item.dueOn);
          for (const userId of recipients) {
            deliveries.push({
              userId,
              channels,
              draft: {
                type: provider.type,
                severity: severityFor(days),
                textKey: provider.textKey,
                params: { ...item.params, days },
                entityType: item.subjectType,
                entityId: item.subjectId,
                link: item.link,
                ruleId: rule.id,
              },
            });
          }
          report.reminders += 1;
        }
      }
      const delivered = await this.notifications.deliver(deliveries);
      report.inApp = delivered.inApp;
      report.email = delivered.email;
      if (report.reminders) this.logger.log(`${report.reminders} reminder(s) made: ${delivered.inApp} in the app, ${delivered.email} by e-mail.`);
      return report;
    } finally {
      this.running = false;
    }
  }

  /** The day an offset's reminder is made: `offset` days (calendar, or working days of the Dutch calendar) before the date. */
  private notifyOn(item: ReminderItem, offset: number, dayType: string): string {
    return dayType === 'working' ? this.calendar.addWorkingDays(item.dueOn, -offset, item.clientId) : addDays(item.dueOn, -offset);
  }

  /** The active staff members a rule tells — who may also open what it is about. */
  private async recipients(rule: ReminderRule, item: ReminderItem, provider: ReminderProvider): Promise<string[]> {
    const wanted = toRecipients(rule.recipients);
    const ids = new Set(wanted.users);
    if (wanted.responsible && item.userIds?.length) for (const id of item.userIds) ids.add(id);
    else if (wanted.responsible && item.clientId) {
      const client = await this.prisma.client.findUnique({ where: { id: item.clientId }, select: { responsibleUserId: true } });
      if (client?.responsibleUserId) ids.add(client.responsibleUserId);
    }
    const users = await this.prisma.user.findMany({
      where: { status: 'active', OR: [{ id: { in: [...ids] } }, ...(wanted.roles.length ? [{ role: { key: { in: wanted.roles } } }] : [])] },
      include: { role: true },
    });
    return users
      .filter(user => {
        const matrix = effectiveMatrix(user.role, user.permissionOverrides);
        return matrixAllows(matrix, provider.requires) && matrixAllows(matrix, 'notifications.view');
      })
      .map(user => user.id);
  }

  /* ── What a subject will be reminded of ───────────────────────────────────────────────────────────────────────── */

  /** The reminders still to come for one record ("14-11-2026 · 30 days before the end"), for the record's page. */
  async upcoming(subjectType: string, subjectId: string, locale: AppLocale, matrix: PermissionMatrix) {
    const today = todayInAmsterdam();
    const rules = await this.prisma.reminderRule.findMany({ where: { isActive: true }, orderBy: { createdAt: 'asc' } });
    const found: Array<{ ruleId: string; trigger: string; name: string; dueOn: string; reminders: Array<{ offset: number; on: string; done: boolean }> }> = [];
    for (const rule of rules) {
      const provider = this.providers.get(rule.trigger);
      if (!provider || !matrixAllows(matrix, provider.requires)) continue;
      const item = (await provider.items(today)).find(entry => entry.subjectType === subjectType && entry.subjectId === subjectId);
      if (!item) continue;
      const done = new Set((await this.prisma.reminderSent.findMany({ where: { ruleId: rule.id, subjectType, subjectId, dueOn: parseDay(item.dueOn) }, select: { offset: true } })).map(row => row.offset));
      found.push({
        ruleId: rule.id,
        trigger: rule.trigger,
        name: provider.names[locale],
        dueOn: item.dueOn,
        reminders: toOffsets(rule.offsets).map(offset => ({ offset, on: this.notifyOn(item, offset, rule.dayType), done: done.has(offset) })),
      });
    }
    return found;
  }

  /* ── Rules (Settings → Notifications & reminders) ─────────────────────────────────────────────────────────────── */

  async overview(locale: AppLocale) {
    const [rules, users, roles] = await Promise.all([
      this.prisma.reminderRule.findMany({ orderBy: [{ trigger: 'asc' }, { createdAt: 'asc' }] }),
      this.prisma.user.findMany({ where: { status: 'active' }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      this.prisma.role.findMany({ select: { key: true, name: true }, orderBy: { name: 'asc' } }),
    ]);
    return {
      rules: rules.map(rule => this.serialize(rule)),
      triggers: [...this.providers.values()].map(provider => ({
        trigger: provider.trigger,
        name: provider.names[locale],
        description: provider.description[locale],
        type: provider.type,
        defaults: provider.defaults,
      })),
      users,
      roles,
    };
  }

  async create(dto: CreateReminderRuleDto, locale: AppLocale) {
    const provider = this.providers.get(dto.trigger);
    const problems = await this.check({ offsets: dto.offsets, recipients: dto.recipients, channels: dto.channels });
    if (!provider) problems.trigger = 'validation.selectOption';
    if (Object.keys(problems).length) throw validationFailed(problems);
    const rule = await this.prisma.reminderRule.create({
      data: {
        trigger: dto.trigger,
        name: dto.name?.trim() || provider!.names[locale],
        isActive: dto.isActive ?? true,
        offsets: toOffsets(dto.offsets),
        dayType: dto.dayType,
        recipients: toRecipients(dto.recipients) as unknown as Prisma.InputJsonObject,
        channels: toChannels(dto.channels),
      },
    });
    await this.audit.log({ action: 'created', entityType: 'reminder_rule', entityId: rule.id, entityLabel: rule.name, after: this.serialize(rule) });
    return this.serialize(rule);
  }

  async update(id: string, dto: UpdateReminderRuleDto) {
    const rule = await this.findOrThrow(id);
    const problems = await this.check({ offsets: dto.offsets, recipients: dto.recipients, channels: dto.channels });
    if (Object.keys(problems).length) throw validationFailed(problems);
    const updated = await this.prisma.reminderRule.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name.trim() || rule.name }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        ...(dto.offsets && { offsets: toOffsets(dto.offsets) }),
        ...(dto.dayType && { dayType: dto.dayType }),
        ...(dto.recipients && { recipients: toRecipients(dto.recipients) as unknown as Prisma.InputJsonObject }),
        ...(dto.channels && { channels: toChannels(dto.channels) }),
      },
    });
    const diff = AuditService.changes(this.serialize(rule) as unknown as Record<string, unknown>, this.serialize(updated) as unknown as Record<string, unknown>);
    if (Object.keys(diff.after).length) await this.audit.log({ action: 'updated', entityType: 'reminder_rule', entityId: id, entityLabel: updated.name, before: diff.before, after: diff.after });
    return this.serialize(updated);
  }

  async remove(id: string) {
    const rule = await this.findOrThrow(id);
    await this.prisma.reminderRule.delete({ where: { id } });
    await this.audit.log({ action: 'deleted', entityType: 'reminder_rule', entityId: id, entityLabel: rule.name, before: this.serialize(rule) });
    return { id };
  }

  private serialize(rule: ReminderRule) {
    const provider = this.providers.get(rule.trigger);
    return {
      id: rule.id,
      trigger: rule.trigger,
      name: rule.name,
      known: Boolean(provider),
      isActive: rule.isActive,
      offsets: toOffsets(rule.offsets),
      dayType: rule.dayType,
      recipients: toRecipients(rule.recipients),
      channels: toChannels(rule.channels),
      createdAt: rule.createdAt.toISOString(),
    };
  }

  private async findOrThrow(id: string): Promise<ReminderRule> {
    const rule = await this.prisma.reminderRule.findUnique({ where: { id } });
    if (!rule) throw new NotFoundException({ code: 'not_found', message: 'Rule not found' });
    return rule;
  }

  /** Whom a rule may tell must exist, and a rule needs somebody to tell. */
  private async check(input: { offsets?: number[]; recipients?: RecipientsDto; channels?: string[] }): Promise<Record<string, string>> {
    const problems: Record<string, string> = {};
    if (input.offsets && !toOffsets(input.offsets).length) problems.offsets = 'validation.required';
    if (input.channels && !toChannels(input.channels).length) problems.channels = 'validation.required';
    if (input.recipients) {
      const wanted = toRecipients(input.recipients);
      if (!wanted.roles.length && !wanted.users.length && !wanted.responsible) problems.recipients = 'reminders.noRecipients';
      else {
        const [roles, users] = await Promise.all([
          wanted.roles.length ? this.prisma.role.count({ where: { key: { in: wanted.roles } } }) : Promise.resolve(0),
          wanted.users.length ? this.prisma.user.count({ where: { id: { in: wanted.users }, status: 'active' } }) : Promise.resolve(0),
        ]);
        if (roles !== new Set(wanted.roles).size || users !== new Set(wanted.users).size) problems.recipients = 'validation.invalid';
      }
    }
    return problems;
  }
}
