import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { paged, type ApiResult } from '../../common/api-result.js';
import { pageMeta } from '../../common/pagination.js';
import { validationFailed } from '../../common/validation/failure.js';
import { Prisma, type Notification } from '../../generated/prisma/client.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { AppConfigService } from '../../lib/config/app-config.service.js';
import { MailService } from '../../lib/mail/mail.service.js';
import { digestMail } from '../../lib/mail/mail-templates.js';
import { ListsService } from '../lists/lists.service.js';
import { NOTIFICATION_TEXTS, renderText, type TextLocale } from './notification-texts.js';
import type { NotificationListQuery } from './dto/notification.dto.js';

export const NOTIFICATION_TYPE_LIST = 'notification_type';
export type Channel = 'in_app' | 'email';

export interface NotificationDraft {
  /** Code of the `notification_type` list. */
  type: string;
  severity: 'info' | 'warning' | 'critical';
  /** A key of `NOTIFICATION_TEXTS`. */
  textKey: string;
  params: Record<string, unknown>;
  entityType?: string;
  entityId?: string;
  link?: string;
  /** The reminder rule that made it. */
  ruleId?: string;
}

export interface Delivery {
  userId: string;
  draft: NotificationDraft;
  /** What the rule asks for; the person's own preferences can switch a channel off. */
  channels: readonly Channel[];
}

const splitList = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);

const asLocale = (value: string): TextLocale => (value === 'en' ? 'en' : 'nl');

/**
 * The inbox (the bell): what the system tells a person, in the language that person reads. A notification is saved as a message key with values;
 * it is written out when it is read and when the e-mail is made. Each person decides per type whether they want it in the app and / or by e-mail
 * (their own preferences narrow down what a reminder rule asks for; the default is everything the rule asks for).
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly config: AppConfigService,
    private readonly lists: ListsService,
  ) {}

  /* ── Delivering ───────────────────────────────────────────────────────────────────────────────────────────────── */

  /** Puts notifications in inboxes and sends one e-mail per person with everything that is new for them. Returns how many inbox items and mails were made. */
  async deliver(deliveries: Delivery[]): Promise<{ inApp: number; email: number }> {
    if (!deliveries.length) return { inApp: 0, email: 0 };
    const userIds = [...new Set(deliveries.map(delivery => delivery.userId))];
    const [users, preferences] = await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: userIds }, status: 'active' }, select: { id: true, name: true, email: true, locale: true } }),
      this.prisma.notificationPreference.findMany({ where: { userId: { in: userIds } } }),
    ]);
    const byUser = new Map(users.map(user => [user.id, user]));
    const preferred = new Map(preferences.map(row => [`${row.userId}:${row.type}`, row]));

    const rows: Prisma.NotificationCreateManyInput[] = [];
    const mails = new Map<string, NotificationDraft[]>();
    for (const delivery of deliveries) {
      const user = byUser.get(delivery.userId);
      if (!user) continue;
      const preference = preferred.get(`${user.id}:${delivery.draft.type}`);
      if (delivery.channels.includes('in_app') && (preference?.inApp ?? true)) {
        rows.push({
          userId: user.id,
          type: delivery.draft.type,
          severity: delivery.draft.severity,
          textKey: delivery.draft.textKey,
          params: delivery.draft.params as Prisma.InputJsonObject,
          entityType: delivery.draft.entityType ?? null,
          entityId: delivery.draft.entityId ?? null,
          link: delivery.draft.link ?? null,
          ruleId: delivery.draft.ruleId ?? null,
        });
      }
      if (delivery.channels.includes('email') && (preference?.email ?? true)) mails.set(user.id, [...(mails.get(user.id) ?? []), delivery.draft]);
    }
    if (rows.length) await this.prisma.notification.createMany({ data: rows });

    let sent = 0;
    for (const [userId, drafts] of mails) {
      const user = byUser.get(userId)!;
      const locale = asLocale(user.locale);
      const items = drafts.map(draft => ({ ...renderText(draft.textKey, draft.params, locale), link: draft.link ? `${this.config.frontendUrl}${draft.link}` : undefined }));
      try {
        const message = digestMail(locale, { name: user.name, items, link: `${this.config.frontendUrl}/notifications` });
        await this.mail.send({ to: user.email, subject: message.subject, text: message.text, html: message.html });
        sent += 1;
      } catch (error) {
        this.logger.warn(`Could not e-mail the reminders to ${user.email}: ${(error as Error).message}`);
      }
    }
    return { inApp: rows.length, email: sent };
  }

  /* ── The inbox ────────────────────────────────────────────────────────────────────────────────────────────────── */

  async list(userId: string, query: NotificationListQuery, locale: TextLocale): Promise<ApiResult> {
    const types = splitList(query.type);
    const severities = splitList(query.severity);
    const base: Prisma.NotificationWhereInput = { userId };
    const where: Prisma.NotificationWhereInput = {
      ...base,
      ...(query.read === 'true' && { readAt: { not: null } }),
      ...(query.read === 'false' && { readAt: null }),
      ...(types.length && { type: { in: types } }),
      ...(severities.length && { severity: { in: severities } }),
    };
    const [total, rows, all, unread, byType] = await Promise.all([
      this.prisma.notification.count({ where }),
      this.prisma.notification.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.prisma.notification.count({ where: base }),
      this.prisma.notification.count({ where: { ...base, readAt: null } }),
      this.prisma.notification.groupBy({ by: ['type'], where: { ...base, ...(query.read === 'true' && { readAt: { not: null } }), ...(query.read === 'false' && { readAt: null }) }, _count: { _all: true } }),
    ]);
    const data = rows.map(row => this.serialize(row, locale));
    return paged(data, pageMeta(total, query, { counts: { all, unread, byType: Object.fromEntries(byType.map(group => [group.type, group._count._all])) } }));
  }

  async unreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({ where: { userId, readAt: null } });
  }

  async markRead(userId: string, id: string, read: boolean) {
    const row = await this.own(userId, id);
    const updated = await this.prisma.notification.update({ where: { id: row.id }, data: { readAt: read ? (row.readAt ?? new Date()) : null } });
    return { id: updated.id, read: Boolean(updated.readAt) };
  }

  async markAllRead(userId: string, type?: string) {
    const types = splitList(type);
    const result = await this.prisma.notification.updateMany({ where: { userId, readAt: null, ...(types.length && { type: { in: types } }) }, data: { readAt: new Date() } });
    return { updated: result.count };
  }

  async remove(userId: string, id: string) {
    const row = await this.own(userId, id);
    await this.prisma.notification.delete({ where: { id: row.id } });
    return { id };
  }

  serialize(row: Notification, locale: TextLocale) {
    const text = renderText(row.textKey, (row.params ?? {}) as Record<string, unknown>, locale);
    const whatsapp = NOTIFICATION_TEXTS[row.textKey]?.whatsapp;
    return {
      id: row.id,
      type: row.type,
      severity: row.severity,
      title: text.title,
      body: text.body,
      link: row.link,
      read: row.readAt !== null,
      createdAt: row.createdAt.toISOString(),
      entityType: row.entityType,
      entityId: row.entityId,
      // "Open WhatsApp" next to a reminder about a contract: the message template that goes with it.
      actions: whatsapp && row.entityType === 'contract' && row.entityId ? [{ kind: 'whatsapp', template: whatsapp, entityType: row.entityType, entityId: row.entityId }] : [],
    };
  }

  /* ── Preferences ──────────────────────────────────────────────────────────────────────────────────────────────── */

  /** `{ [type]: { inApp, email } }` for every type of notification. */
  async preferences(userId: string) {
    const [types, rows] = await Promise.all([this.lists.activeCodes(NOTIFICATION_TYPE_LIST), this.prisma.notificationPreference.findMany({ where: { userId } })]);
    const byType = new Map(rows.map(row => [row.type, row]));
    return Object.fromEntries([...types].map(type => [type, { inApp: byType.get(type)?.inApp ?? true, email: byType.get(type)?.email ?? true }]));
  }

  /** Saves the types that were sent; a type that is back to the default (everything on) is removed again. */
  async savePreferences(userId: string, changes: Record<string, { inApp?: unknown; email?: unknown }>) {
    const types = await this.lists.activeCodes(NOTIFICATION_TYPE_LIST);
    const problems: Record<string, string> = {};
    for (const [type, choice] of Object.entries(changes ?? {})) {
      if (!types.has(type)) problems[type] = 'validation.invalid';
      else if ((choice?.inApp !== undefined && typeof choice.inApp !== 'boolean') || (choice?.email !== undefined && typeof choice.email !== 'boolean')) problems[type] = 'validation.selectOption';
    }
    if (Object.keys(problems).length) throw validationFailed(problems);
    const current = await this.preferences(userId);
    for (const [type, choice] of Object.entries(changes)) {
      const next = { inApp: (choice.inApp as boolean | undefined) ?? current[type]!.inApp, email: (choice.email as boolean | undefined) ?? current[type]!.email };
      if (next.inApp && next.email) await this.prisma.notificationPreference.deleteMany({ where: { userId, type } });
      else await this.prisma.notificationPreference.upsert({ where: { userId_type: { userId, type } }, create: { userId, type, ...next }, update: next });
    }
    return this.preferences(userId);
  }

  private async own(userId: string, id: string): Promise<Notification> {
    const row = await this.prisma.notification.findFirst({ where: { id, userId } });
    if (!row) throw new NotFoundException({ code: 'not_found', message: 'Notification not found' });
    return row;
  }
}
