import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { daysBetween, formatDay, isValidDay, parseDay } from '../../common/dates.js';
import { fold } from '../../common/text.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { validationFailed } from '../../common/validation/failure.js';
import { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { NotificationsService, type NotificationDraft } from '../notifications/notifications.service.js';
import { matrixAllows, type PermissionMatrix } from '../roles/permission-catalog.js';
import { EVENT_ENTITY, MAX_EVENT_DAYS, MAX_GUESTS, type StoredEventType } from './agenda.constants.js';
import { amsterdamNow, lastDayOf, naiveStamp, splitTimestamp } from './agenda-time.js';
import type { CreateEventDto, GuestDto, UpdateEventDto } from './dto/agenda.dto.js';

const EVENT_INCLUDE = { client: { select: { id: true, number: true, name: true } } } satisfies Prisma.CalendarEventInclude;
export type EventRow = Prisma.CalendarEventGetPayload<{ include: typeof EVENT_INCLUDE }>;

export interface Guest {
  name: string;
  email: string;
  /** Set when the guest is a colleague (found by e-mail address): they are told in the app. */
  userId?: string;
}

/** One entry on the calendar — an appointment, or a date worked out from another record (`source: 'derived'`, read-only). */
export interface CalendarEntry {
  id: string;
  title: string;
  type: string;
  /** All day: `2026-10-06`. With a time: `2026-10-06T09:30:00`. `end` is the last day (inclusive) for all-day entries. */
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  description: string;
  attendees: Guest[];
  client: { id: string; number: string; name: string } | null;
  /** What it is about (a derived entry: the record it comes from). */
  entity: { type: string; id: string; label: string } | null;
  source: 'local' | 'derived';
  /** The part of the app that owns a derived entry (where it is changed). */
  managedBy: string | null;
  readOnly: boolean;
  href: string | null;
  overdue: boolean;
  /** A few facts about the record a derived entry comes from. */
  record: Record<string, unknown> | null;
  meetingLink: string | null;
  reminderMinutes: number | null;
  createdBy: { id: string; name: string } | null;
  createdAt: string | null;
  updatedAt: string | null;
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const dateText = (day: string): string => `${day.slice(8, 10)}-${day.slice(5, 7)}-${day.slice(0, 4)}`;

/** "6-10-2026 09:30", "06-10-2026" or "26-10-2026 – 28-10-2026": how an appointment is named in a message. */
const whenOf = (startsOn: string, endsOn: string, allDay: boolean, startTime: string | null, endTime: string | null): string => {
  if (allDay) {
    const last = lastDayOf(startsOn, endsOn, true, null);
    return last > startsOn ? `${dateText(startsOn)} – ${dateText(last)}` : dateText(startsOn);
  }
  return `${dateText(startsOn)} ${startTime ?? ''}${endTime && endsOn === startsOn ? `–${endTime}` : ''}`.trim();
};

const untilNl = (minutes: number): string => (minutes <= 0 ? 'nu' : minutes < 60 ? `over ${minutes} minuten` : minutes < 1440 ? `over ${Math.round(minutes / 60)} uur` : `over ${Math.round(minutes / 1440)} dagen`);
const untilEn = (minutes: number): string => (minutes <= 0 ? 'now' : minutes < 60 ? `in ${minutes} minutes` : minutes < 1440 ? `in ${Math.round(minutes / 60)} hours` : `in ${Math.round(minutes / 1440)} days`);

/** `https://` is assumed when no scheme is given; `''` when empty; `null` when the text is not a web address. */
function cleanLink(value: string | undefined): string | null {
  const text = (value ?? '').trim();
  if (!text) return '';
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    return ['http:', 'https:'].includes(url.protocol) && url.hostname.includes('.') ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * The appointments of the office calendar: a meeting, a team event or a reminder to oneself, with guests (colleagues are told in the app, other guests are only listed) and
 * an optional reminder before the start. They live here; the other dates on the calendar — contract ends, deadlines, tasks, inspections — are worked out from their own records
 * (AgendaFeedService). Cancelling an appointment switches it off; it is not deleted.
 */
@Injectable()
export class AgendaEventsService {
  private readonly logger = new Logger(AgendaEventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  /* ── Reading ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  async rowOrThrow(id: string): Promise<EventRow> {
    const row = await this.prisma.calendarEvent.findUnique({ where: { id }, include: EVENT_INCLUDE });
    if (!row) throw new NotFoundException({ code: 'not_found', message: 'Appointment not found' });
    return row;
  }

  /** The appointments that touch the days from `from` to `to`. */
  async inRange(from: string, to: string, clientId?: string): Promise<CalendarEntry[]> {
    const rows = await this.prisma.calendarEvent.findMany({
      where: { isActive: true, startsOn: { lte: parseDay(to) }, endsOn: { gte: parseDay(from) }, ...(clientId && { clientId }) },
      include: EVENT_INCLUDE,
      orderBy: [{ startsOn: 'asc' }, { startTime: 'asc' }],
    });
    return this.views(rows);
  }

  async views(rows: readonly EventRow[]): Promise<CalendarEntry[]> {
    if (!rows.length) return [];
    const creatorIds = [...new Set(rows.map(row => row.createdById).filter((id): id is string => Boolean(id)))];
    const creators = creatorIds.length ? await this.prisma.user.findMany({ where: { id: { in: creatorIds } }, select: { id: true, name: true } }) : [];
    const byId = new Map(creators.map(user => [user.id, user]));
    return rows.map(row => {
      const startsOn = formatDay(row.startsOn);
      const endsOn = formatDay(row.endsOn);
      const creator = row.createdById ? byId.get(row.createdById) : undefined;
      return {
        id: row.id,
        title: row.title,
        type: row.type,
        start: row.allDay ? startsOn : `${startsOn}T${row.startTime ?? '00:00'}:00`,
        end: row.allDay ? endsOn : `${endsOn}T${row.endTime ?? row.startTime ?? '00:00'}:00`,
        allDay: row.allDay,
        location: row.location,
        description: row.description,
        attendees: this.guestsOf(row.attendees),
        client: row.client ? { id: row.client.id, number: row.client.number, name: row.client.name } : null,
        entity: null,
        source: 'local' as const,
        managedBy: null,
        readOnly: false,
        href: `/calendar?event=${row.id}&date=${startsOn}`,
        overdue: false,
        record: null,
        meetingLink: row.meetingLink || null,
        reminderMinutes: row.reminderMinutes,
        createdBy: creator ? { id: creator.id, name: creator.name } : null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  }

  async one(id: string): Promise<CalendarEntry> {
    return (await this.views([await this.rowOrThrow(id)]))[0]!;
  }

  private guestsOf(value: unknown): Guest[] {
    return (Array.isArray(value) ? value : [])
      .map(item => (item && typeof item === 'object' ? (item as Record<string, unknown>) : {}))
      .map(item => ({ name: String(item.name ?? ''), email: String(item.email ?? ''), ...(typeof item.userId === 'string' && item.userId && { userId: item.userId }) }))
      .filter(guest => guest.name || guest.email);
  }

  /* ── Checking ─────────────────────────────────────────────────────────────────────────────────────────────────── */

  /** The guest list, cleaned: valid addresses, nobody twice, colleagues recognised by their e-mail address. */
  private async checkGuests(guests: readonly GuestDto[] | undefined, problems: Record<string, string>): Promise<Guest[]> {
    const wanted: Array<{ name: string; email: string }> = [];
    const seen = new Set<string>();
    for (const guest of guests ?? []) {
      const name = (guest.name ?? '').trim();
      const email = (guest.email ?? '').trim().toLowerCase();
      if (!name && !email) continue;
      if (email && !EMAIL.test(email)) {
        problems.attendees = 'validation.invalidEmail';
        continue;
      }
      const key = email || name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      wanted.push({ name: name || email, email });
    }
    if (wanted.length > MAX_GUESTS) problems.attendees = 'validation.invalid';
    const emails = wanted.map(guest => guest.email).filter(Boolean);
    const colleagues = emails.length ? await this.prisma.user.findMany({ where: { email: { in: emails }, status: 'active' }, select: { id: true, email: true, name: true } }) : [];
    const byEmail = new Map(colleagues.map(user => [user.email.toLowerCase(), user]));
    return wanted.slice(0, MAX_GUESTS).map(guest => {
      const colleague = byEmail.get(guest.email);
      return colleague ? { name: guest.name === guest.email ? colleague.name : guest.name, email: guest.email, userId: colleague.id } : guest;
    });
  }

  /** What the appointment is saved as, after every check; a 422 names the fields that are wrong. */
  private async checked(dto: CreateEventDto | UpdateEventDto, existing: EventRow | null) {
    const problems: Record<string, string> = {};
    const current = existing ? (await this.views([existing]))[0]! : null;
    const pick = (key: keyof CreateEventDto, fallback: unknown): unknown => (dto[key] === undefined ? fallback : dto[key]);

    const title = String(pick('title', current?.title) ?? '').trim();
    if (!title) problems.title = 'validation.required';
    const type = String(pick('type', current?.type) ?? 'meeting') as StoredEventType;
    const allDay = Boolean(pick('allDay', current?.allDay));

    const startText = String(pick('start', current?.start) ?? '');
    const endText = String(pick('end', dto.start !== undefined ? undefined : current?.end) ?? startText);
    const moment = (text: string) => {
      if (allDay) return isValidDay(text.slice(0, 10)) ? { day: text.slice(0, 10), time: null as string | null } : null;
      const parts = splitTimestamp(text);
      return parts && isValidDay(parts.day) ? { day: parts.day, time: parts.time as string | null } : null;
    };
    const start = moment(startText);
    const end = moment(endText);
    if (!start) problems.start = 'validation.invalid';
    if (!end) problems.end = 'validation.invalid';
    if (start && end) {
      if (allDay ? end.day < start.day : naiveStamp(end.day, end.time) <= naiveStamp(start.day, start.time)) problems.end = allDay ? 'validation.endBeforeStart' : 'validation.afterStart';
      else if (daysBetween(start.day, end.day) > MAX_EVENT_DAYS) problems.end = 'calendar.tooLong';
    }

    const meetingLink = cleanLink(pick('meetingLink', current?.meetingLink ?? '') as string);
    if (meetingLink === null) problems.meetingLink = 'validation.invalidUrl';

    const clientId = (pick('clientId', current?.client?.id ?? null) as string | null) || null;
    if (clientId && !(await this.prisma.client.findUnique({ where: { id: clientId }, select: { id: true } }))) problems.clientId = 'validation.invalid';

    const reminder = pick('reminderMinutes', current?.reminderMinutes ?? null);
    const reminderMinutes = reminder === undefined || reminder === null ? null : Number(reminder);

    const attendees = await this.checkGuests(dto.attendees ?? (current ? current.attendees : undefined), problems);
    if (Object.keys(problems).length) throw validationFailed(problems);

    return {
      title,
      type,
      allDay,
      startsOn: start!.day,
      endsOn: end!.day,
      startTime: allDay ? null : start!.time,
      endTime: allDay ? null : end!.time,
      location: String(pick('location', current?.location ?? '') ?? '').trim().slice(0, 200),
      description: String(pick('description', current?.description ?? '') ?? '').trim().slice(0, 4000),
      meetingLink: meetingLink ?? '',
      attendees,
      clientId,
      reminderMinutes,
    };
  }

  /* ── Changing ─────────────────────────────────────────────────────────────────────────────────────────────────── */

  async create(dto: CreateEventDto, user: AuthenticatedUser): Promise<CalendarEntry> {
    const values = await this.checked(dto, null);
    const created = await this.prisma.calendarEvent.create({
      data: {
        title: values.title,
        type: values.type,
        allDay: values.allDay,
        startsOn: parseDay(values.startsOn),
        endsOn: parseDay(values.endsOn),
        startTime: values.startTime,
        endTime: values.endTime,
        location: values.location,
        description: values.description,
        meetingLink: values.meetingLink,
        attendees: values.attendees as unknown as Prisma.InputJsonValue,
        clientId: values.clientId,
        reminderMinutes: values.reminderMinutes,
        createdById: user.id,
      },
      include: EVENT_INCLUDE,
    });
    await this.audit.log({ action: 'created', entityType: EVENT_ENTITY, entityId: created.id, entityLabel: created.title, after: this.auditShape(values) });
    await this.tellGuests(created, values.attendees, 'invited', user);
    return (await this.views([created]))[0]!;
  }

  async update(id: string, dto: UpdateEventDto, user: AuthenticatedUser): Promise<CalendarEntry> {
    const row = await this.rowOrThrow(id);
    const values = await this.checked(dto, row);
    const before = this.auditShape({
      title: row.title,
      type: row.type,
      allDay: row.allDay,
      startsOn: formatDay(row.startsOn),
      endsOn: formatDay(row.endsOn),
      startTime: row.startTime,
      endTime: row.endTime,
      location: row.location,
      description: row.description,
      meetingLink: row.meetingLink,
      attendees: this.guestsOf(row.attendees),
      clientId: row.clientId,
      reminderMinutes: row.reminderMinutes,
    });
    const diff = AuditService.changes(before, this.auditShape(values));
    if (!Object.keys(diff.after).length) return this.one(id);
    // A new time starts a new reminder.
    const moved = 'startsOn' in diff.after || 'startTime' in diff.after || 'reminderMinutes' in diff.after;
    const updated = await this.prisma.calendarEvent.update({
      where: { id },
      data: {
        title: values.title,
        type: values.type,
        allDay: values.allDay,
        startsOn: parseDay(values.startsOn),
        endsOn: parseDay(values.endsOn),
        startTime: values.startTime,
        endTime: values.endTime,
        location: values.location,
        description: values.description,
        meetingLink: values.meetingLink,
        attendees: values.attendees as unknown as Prisma.InputJsonValue,
        clientId: values.clientId,
        reminderMinutes: values.reminderMinutes,
        ...(moved && { reminderSentAt: null }),
      },
      include: EVENT_INCLUDE,
    });
    await this.audit.log({ action: 'updated', entityType: EVENT_ENTITY, entityId: id, entityLabel: updated.title, before: diff.before, after: diff.after });
    const known = new Set(this.guestsOf(row.attendees).map(guest => guest.email || guest.name.toLowerCase()));
    await this.tellGuests(updated, values.attendees.filter(guest => !known.has(guest.email || guest.name.toLowerCase())), 'invited', user);
    return (await this.views([updated]))[0]!;
  }

  /** Cancels an appointment (guests that are colleagues are told) or brings it back. */
  async setActive(id: string, isActive: boolean, user: AuthenticatedUser): Promise<CalendarEntry> {
    const row = await this.rowOrThrow(id);
    if (row.isActive === isActive) return this.one(id);
    await this.prisma.calendarEvent.update({ where: { id }, data: isActive ? { isActive: true, deactivatedAt: null, deactivatedById: null } : { isActive: false, deactivatedAt: new Date(), deactivatedById: user.id } });
    await this.audit.log({ action: isActive ? 'activated' : 'deactivated', entityType: EVENT_ENTITY, entityId: id, entityLabel: row.title });
    if (!isActive) await this.tellGuests(row, this.guestsOf(row.attendees), 'cancelled', user);
    return this.one(id);
  }

  private auditShape(values: { title: string; type: string; allDay: boolean; startsOn: string; endsOn: string; startTime: string | null; endTime: string | null; location: string; description: string; meetingLink: string; attendees: Guest[]; clientId: string | null; reminderMinutes: number | null }) {
    return { ...values, attendees: values.attendees.map(guest => guest.email || guest.name) };
  }

  /* ── Telling people ───────────────────────────────────────────────────────────────────────────────────────────── */

  /** The colleagues among the guests hear about it in the app (the others are only on the list: nothing is e-mailed to people outside the office). */
  private async tellGuests(row: EventRow, guests: readonly Guest[], kind: 'invited' | 'cancelled', actor: AuthenticatedUser): Promise<void> {
    const colleagues = [...new Set(guests.map(guest => guest.userId).filter((id): id is string => Boolean(id) && id !== actor.id))];
    if (!colleagues.length) return;
    const startsOn = formatDay(row.startsOn);
    const detail = [whenOf(startsOn, formatDay(row.endsOn), row.allDay, row.startTime, row.endTime), row.client?.name, row.location].filter(Boolean).join(' · ');
    const draft: NotificationDraft = {
      type: 'event',
      severity: kind === 'cancelled' ? 'warning' : 'info',
      textKey: kind === 'cancelled' ? 'event.cancelled' : 'event.invited',
      params: { person: actor.name, title: row.title, detail },
      entityType: EVENT_ENTITY,
      entityId: row.id,
      link: `/calendar?event=${row.id}&date=${startsOn}`,
    };
    await this.notifications.deliver(colleagues.map(userId => ({ userId, channels: ['in_app'], draft })));
  }

  /** Every five minutes: the reminders whose time has come (the organiser and the colleagues on the guest list are told once). */
  @Cron('*/5 * * * *', { timeZone: 'Europe/Amsterdam' })
  async sendReminders(): Promise<number> {
    try {
      const now = amsterdamNow();
      const rows = await this.prisma.calendarEvent.findMany({
        where: { isActive: true, reminderMinutes: { not: null }, reminderSentAt: null, startsOn: { gte: parseDay(formatDay(new Date(parseDay(now.day).getTime() - 86_400_000))), lte: parseDay(formatDay(new Date(parseDay(now.day).getTime() + 30 * 86_400_000))) } },
        include: EVENT_INCLUDE,
      });
      let sent = 0;
      for (const row of rows) {
        const startsOn = formatDay(row.startsOn);
        const start = naiveStamp(startsOn, row.allDay ? null : row.startTime);
        const over = naiveStamp(formatDay(row.endsOn), row.allDay ? '23:59' : (row.endTime ?? row.startTime));
        if (now.stamp < start - row.reminderMinutes! * 60_000 || now.stamp > over) continue;
        const minutes = Math.max(0, Math.round((start - now.stamp) / 60_000));
        const people = [...new Set([row.createdById, ...this.guestsOf(row.attendees).map(guest => guest.userId)].filter((id): id is string => Boolean(id)))];
        const detail = [whenOf(startsOn, formatDay(row.endsOn), row.allDay, row.startTime, row.endTime), row.client?.name, row.location].filter(Boolean).join(' · ');
        const draft: NotificationDraft = {
          type: 'event',
          severity: 'info',
          textKey: 'event.reminder',
          params: { title: row.title, inNl: untilNl(minutes), inEn: untilEn(minutes), detail },
          entityType: EVENT_ENTITY,
          entityId: row.id,
          link: `/calendar?event=${row.id}&date=${startsOn}`,
        };
        await this.notifications.deliver(people.map(userId => ({ userId, channels: ['in_app'], draft })));
        await this.prisma.calendarEvent.update({ where: { id: row.id }, data: { reminderSentAt: new Date() } });
        sent += 1;
      }
      return sent;
    } catch (error) {
      this.logger.warn(`Could not send the appointment reminders: ${(error as Error).message.split('\n')[0]}`);
      return 0;
    }
  }

  /* ── Guests to pick ───────────────────────────────────────────────────────────────────────────────────────────── */

  /** Colleagues, and — for people who may open clients — the clients' e-mail addresses and their contact persons. */
  async people(search: string | undefined, matrix: PermissionMatrix) {
    const term = fold(search ?? '');
    const colleagues = await this.prisma.user.findMany({
      where: { status: 'active', ...(term && { OR: [{ name: { contains: term, mode: 'insensitive' } }, { email: { contains: term, mode: 'insensitive' } }] }) },
      select: { id: true, name: true, email: true, title: true },
      orderBy: { name: 'asc' },
      take: 20,
    });
    const found = colleagues.map(user => ({ id: `user:${user.id}`, kind: 'staff', name: user.name, email: user.email.toLowerCase(), detail: user.title, clientId: null as string | null }));
    if (term.length >= 2 && matrixAllows(matrix, 'clients.view')) {
      const [clients, persons] = await Promise.all([
        this.prisma.client.findMany({ where: { isActive: true, OR: [{ searchText: { contains: term } }, { number: { contains: term, mode: 'insensitive' } }] }, select: { id: true, number: true, name: true, data: true }, take: 30 }),
        this.prisma.person.findMany({ where: { isActive: true, searchText: { contains: term }, clients: { some: { client: { isActive: true } } } }, select: { id: true, firstName: true, lastName: true, data: true, clients: { take: 1, select: { client: { select: { id: true, number: true, name: true } } } } }, take: 30 }),
      ]);
      for (const client of clients) {
        const email = (client.data as Record<string, unknown>).email_1;
        if (typeof email === 'string' && EMAIL.test(email.trim())) found.push({ id: `client:${client.id}`, kind: 'client', name: client.name, email: email.trim().toLowerCase(), detail: client.number, clientId: client.id });
      }
      for (const person of persons) {
        const data = person.data as Record<string, unknown>;
        const email = data.email;
        if (typeof email !== 'string' || !EMAIL.test(email.trim())) continue;
        const client = person.clients[0]?.client;
        const infix = typeof data.infix === 'string' ? data.infix.trim() : '';
        found.push({ id: `person:${person.id}`, kind: 'client', name: [person.firstName, infix, person.lastName].filter(Boolean).join(' '), email: email.trim().toLowerCase(), detail: client ? `${client.number} – ${client.name}` : '', clientId: client?.id ?? null });
      }
    }
    return found;
  }
}
