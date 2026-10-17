import { Injectable, type OnModuleInit } from '@nestjs/common';
import { formatDay } from '../../common/dates.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import type { ReminderItem } from '../reminders/reminder-types.js';
import { RemindersService } from '../reminders/reminders.service.js';
import { InspectionChecklistService } from './inspection-checklist.service.js';
import { dutchDay } from './inspection-folders.service.js';
import { InspectionListsService } from './inspection-lists.service.js';
import { INSPECTION_INCLUDE, toDay } from './inspection-rows.js';
import { INSPECTION_FOLLOW_UP_TRIGGER, INSPECTION_REMINDER_DEFAULTS, INSPECTION_RESPONSE_TRIGGER, INSPECTION_UPCOMING_TRIGGER, OPEN_STATUSES } from './inspections.constants.js';

/**
 * What the reminder engine may watch about inspections: the day of an inspection that is coming (told with how many lines of the checklist are still not ready), the day the
 * inspector wants the documents, and the things to put right after an inspection. The days before each date and the people to tell are rules the office edits (Settings →
 * Notifications and reminders); nothing is a constant.
 */
@Injectable()
export class InspectionRemindersService implements OnModuleInit {
  constructor(
    private readonly reminders: RemindersService,
    private readonly prisma: PrismaService,
    private readonly checklist: InspectionChecklistService,
    private readonly lists: InspectionListsService,
  ) {}

  onModuleInit(): void {
    const defaults = (trigger: keyof typeof INSPECTION_REMINDER_DEFAULTS) => ({ offsets: [...INSPECTION_REMINDER_DEFAULTS[trigger].offsets], dayType: INSPECTION_REMINDER_DEFAULTS[trigger].dayType, channels: [...INSPECTION_REMINDER_DEFAULTS[trigger].channels] });
    this.reminders.register({
      trigger: INSPECTION_UPCOMING_TRIGGER,
      type: 'inspection',
      textKey: 'inspection.upcoming',
      requires: 'inspections.view',
      names: { nl: 'Controle komt eraan', en: 'Inspection coming up' },
      description: {
        nl: 'De dag van een geplande controle. Het bericht zegt hoeveel regels van de controlelijst nog niet gereed zijn, zodat er tijd is om een verlopen KvK-uittreksel of een ontbrekend document te regelen.',
        en: 'The day of a planned inspection. The message says how many lines of the checklist are not ready yet, so there is time to get a new Chamber of Commerce extract or a missing document.',
      },
      defaults: defaults(INSPECTION_UPCOMING_TRIGGER),
      items: today => this.upcoming(today),
    });
    this.reminders.register({
      trigger: INSPECTION_RESPONSE_TRIGGER,
      type: 'inspection',
      textKey: 'inspection.response_due',
      requires: 'inspections.view',
      names: { nl: 'Controle: antwoord is verschuldigd', en: 'Inspection: answer due' },
      description: { nl: 'De dag waarop de inspecteur de gevraagde stukken wil hebben.', en: 'The day the inspector wants the documents they asked for.' },
      defaults: defaults(INSPECTION_RESPONSE_TRIGGER),
      items: today => this.responses(today),
    });
    this.reminders.register({
      trigger: INSPECTION_FOLLOW_UP_TRIGGER,
      type: 'inspection',
      textKey: 'inspection.follow_up',
      requires: 'inspections.view',
      names: { nl: 'Controle: opvolging is verschuldigd', en: 'Inspection: follow-up due' },
      description: { nl: 'De dag waarop iets na een controle in orde moet zijn (een bevinding herstellen, een document alsnog aanleveren).', en: 'The day something after an inspection has to be put right (a finding to fix, a document to deliver later).' },
      defaults: defaults(INSPECTION_FOLLOW_UP_TRIGGER),
      items: today => this.followUps(today),
    });
  }

  private async upcoming(today: string): Promise<ReminderItem[]> {
    const rows = await this.prisma.inspection.findMany({ where: { isActive: true, status: { in: [...OPEN_STATUSES] }, date: { gte: toDay(today) }, client: { isActive: true } }, include: INSPECTION_INCLUDE });
    if (!rows.length) return [];
    const [summaries, typesNl, typesEn, bodiesNl, bodiesEn] = await Promise.all([
      this.checklist.summaries(rows),
      this.lists.names('inspection_type', 'nl'),
      this.lists.names('inspection_type', 'en'),
      this.lists.names('inspection_body', 'nl'),
      this.lists.names('inspection_body', 'en'),
    ]);
    return rows.map(row => {
      const summary = summaries.get(row.id);
      const open = summary ? summary.total - summary.ready : 0;
      const old = summary?.tooOld ?? 0;
      const statusNl = !summary ? '' : open === 0 ? 'Alles is gereed.' : `Nog niet gereed: ${open} van ${summary.total} regels${old ? ` (waarvan ${old} te oud)` : ''}.`;
      const statusEn = !summary ? '' : open === 0 ? 'Everything is ready.' : `Not ready yet: ${open} of ${summary.total} lines${old ? ` (${old} too old)` : ''}.`;
      return {
        subjectType: 'inspection',
        subjectId: row.id,
        dueOn: formatDay(row.date),
        clientId: row.clientId,
        params: {
          client: `${row.client.number} – ${row.client.name}`,
          date: dutchDay(formatDay(row.date)),
          typeNl: typesNl.get(row.type) ?? row.type,
          typeEn: typesEn.get(row.type) ?? row.type,
          bodyNl: bodiesNl.get(row.body) ?? row.body,
          bodyEn: bodiesEn.get(row.body) ?? row.body,
          statusNl,
          statusEn,
        },
        link: `/inspections/${row.id}?tab=checklist`,
      } satisfies ReminderItem;
    });
  }

  private async responses(today: string): Promise<ReminderItem[]> {
    const rows = await this.prisma.inspection.findMany({
      where: { isActive: true, status: { in: [...OPEN_STATUSES] }, responseDue: { gte: toDay(today) }, client: { isActive: true } },
      select: { id: true, number: true, body: true, responseDue: true, clientId: true, client: { select: { number: true, name: true } } },
    });
    const [bodiesNl, bodiesEn] = await Promise.all([this.lists.names('inspection_body', 'nl'), this.lists.names('inspection_body', 'en')]);
    return rows.flatMap(row =>
      row.responseDue
        ? [
            {
              subjectType: 'inspection',
              subjectId: row.id,
              dueOn: formatDay(row.responseDue),
              clientId: row.clientId,
              params: { client: `${row.client.number} – ${row.client.name}`, number: row.number, bodyNl: bodiesNl.get(row.body) ?? row.body, bodyEn: bodiesEn.get(row.body) ?? row.body, date: dutchDay(formatDay(row.responseDue)) },
              link: `/inspections/${row.id}?tab=checklist`,
            } satisfies ReminderItem,
          ]
        : [],
    );
  }

  private async followUps(today: string): Promise<ReminderItem[]> {
    const rows = await this.prisma.inspectionFollowUp.findMany({
      where: { doneOn: null, dueDate: { gte: toDay(today) }, inspection: { isActive: true, client: { isActive: true } } },
      select: { id: true, text: true, dueDate: true, inspection: { select: { id: true, number: true, clientId: true, client: { select: { number: true, name: true } } } } },
    });
    return rows.flatMap(row =>
      row.dueDate
        ? [
            {
              subjectType: 'inspection_follow_up',
              subjectId: row.id,
              dueOn: formatDay(row.dueDate),
              clientId: row.inspection.clientId,
              params: { client: `${row.inspection.client.number} – ${row.inspection.client.name}`, number: row.inspection.number, text: row.text, date: dutchDay(formatDay(row.dueDate)) },
              link: `/inspections/${row.inspection.id}?tab=overview`,
            } satisfies ReminderItem,
          ]
        : [],
    );
  }
}
