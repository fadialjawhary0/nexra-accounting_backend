import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DAY_PATTERN } from '../../common/dates.js';
import { asRecord } from '../../common/record-values.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { DocumentTypesService } from '../document-settings/document-types.service.js';
import { DOCUMENT_PURPOSES } from '../files/files.constants.js';
import { personName } from '../people/person-record.js';
import type { ReminderItem, ReminderProvider } from '../reminders/reminder-types.js';
import { RemindersService } from '../reminders/reminders.service.js';
import { DOCUMENT_REMINDER_DEFAULTS } from './document-reminder-defaults.js';
import { DocumentViewService } from './document-view.service.js';

const documentLink = (clientId: string | null, fileId: string): string => `/documents?${clientId ? `client=${clientId}&` : ''}open=${fileId}`;

/**
 * What the reminder engine may watch about documents: a document with an end date (a G-account agreement), a document that goes stale (a KvK extract is
 * good for three months) and — for workers — the end of an ID or residence permit, which is read from the worker's record. Only current documents are
 * watched; a document that was replaced by a newer version needs nothing.
 */
@Injectable()
export class DocumentRemindersService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reminders: RemindersService,
    private readonly types: DocumentTypesService,
    private readonly view: DocumentViewService,
  ) {}

  onModuleInit(): void {
    this.reminders.register({
      trigger: 'document_expiry',
      type: 'document',
      textKey: 'document.expiring',
      requires: 'documents.view',
      names: { nl: 'Document verloopt', en: 'Document expires' },
      description: { nl: 'Een document met een einddatum (bijvoorbeeld een overeenkomst met een einddatum). Kies hoeveel dagen vooraf je een herinnering wilt.', en: 'A document with an end date (for example an agreement that ends). Choose how many days ahead you want a reminder.' },
      defaults: this.defaults('document_expiry'),
      items: today => this.documents(today, 'date'),
    });
    this.reminders.register({
      trigger: 'document_age',
      type: 'document',
      textKey: 'document.age',
      requires: 'documents.view',
      names: { nl: 'Document is te oud', en: 'Document gets too old' },
      description: { nl: 'Een document dat maar even geldig is, bijvoorbeeld een KvK-uittreksel (3 maanden). De herinnering telt vanaf de datum op het document.', en: 'A document that is only good for a while, for example a Chamber of Commerce extract (3 months). The reminder counts from the date on the document.' },
      defaults: this.defaults('document_age'),
      items: today => this.documents(today, 'age'),
    });
    this.reminders.register({
      trigger: 'worker_document_expiry',
      type: 'document',
      textKey: 'worker_document.expiring',
      requires: 'personal_data.view',
      names: { nl: 'ID of vergunning van een werknemer verloopt', en: 'A worker’s ID or permit expires' },
      description: { nl: 'De einddatum van een identiteitsbewijs of verblijfs- of werkvergunning, uit het dossier van de werknemer. Kies hoeveel dagen vooraf je een herinnering wilt.', en: 'The end date of an ID or a residence or work permit, from the worker’s record. Choose how many days ahead you want a reminder.' },
      defaults: this.defaults('worker_document_expiry'),
      items: today => this.workers(today),
    });
  }

  private defaults(trigger: keyof typeof DOCUMENT_REMINDER_DEFAULTS): ReminderProvider['defaults'] {
    const { offsets, dayType, channels } = DOCUMENT_REMINDER_DEFAULTS[trigger];
    return { offsets: [...offsets], dayType, channels: [...channels] };
  }

  /** Current documents of a type with this kind of end date that have not ended yet. */
  private async documents(today: string, kind: 'date' | 'age'): Promise<ReminderItem[]> {
    const types = (await this.types.active()).filter(type => type.validity === kind);
    if (!types.length) return [];
    const rows = await this.prisma.storedFile.findMany({
      where: { isActive: true, isCurrent: true, purpose: { in: [...DOCUMENT_PURPOSES] }, docType: { in: types.map(type => type.code) } },
      select: { id: true, name: true, docType: true, docDate: true, validUntil: true, entityType: true, entityId: true, clientId: true },
    });
    const validities = await this.view.validities(rows);
    const clientIds = [...new Set(rows.map(row => row.clientId).filter((id): id is string => Boolean(id)))];
    const clients = clientIds.length ? await this.prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, number: true, name: true, isActive: true } }) : [];
    const clientById = new Map(clients.map(client => [client.id, client]));
    const typeName = new Map(types.map(type => [type.code, type.nameNl]));
    const items: ReminderItem[] = [];
    for (const row of rows) {
      const until = validities.get(row.id)?.until;
      const client = row.clientId ? clientById.get(row.clientId) : undefined;
      if (!until || until < today || (client && !client.isActive)) continue;
      items.push({
        subjectType: 'document',
        subjectId: row.id,
        dueOn: until,
        clientId: row.clientId,
        params: { document: row.name, type: typeName.get(row.docType ?? '') ?? '', client: client ? `${client.number} – ${client.name}` : '', date: until },
        link: documentLink(row.clientId, row.id),
      });
    }
    return items;
  }

  /** The end dates of IDs and permits of the workers who work now: the date is in the person's record, whether or not a copy is filed. */
  private async workers(today: string): Promise<ReminderItem[]> {
    const types = (await this.types.active()).filter(type => type.validity === 'field' && type.validityField);
    if (!types.length) return [];
    const workers = await this.prisma.employee.findMany({
      where: { isActive: true, client: { isActive: true } },
      select: { id: true, clientId: true, client: { select: { number: true, name: true } }, person: { select: { firstName: true, lastName: true, data: true } } },
    });
    const items: ReminderItem[] = [];
    for (const worker of workers) {
      const data = asRecord(worker.person.data);
      for (const type of types) {
        const value = data[type.validityField as string];
        if (typeof value !== 'string' || !DAY_PATTERN.test(value) || value < today) continue;
        items.push({
          subjectType: 'worker_document',
          subjectId: `${worker.id}:${type.code}`,
          dueOn: value,
          clientId: worker.clientId,
          params: { worker: personName(worker.person), document: type.nameNl, client: `${worker.client.number} – ${worker.client.name}`, date: value },
          link: `/employees/${worker.id}`,
        });
      }
    }
    return items;
  }
}
