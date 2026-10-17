import { Injectable, type OnModuleInit } from '@nestjs/common';
import { formatDay, parseDay } from '../../common/dates.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import type { ReminderItem } from '../reminders/reminder-types.js';
import { RemindersService } from '../reminders/reminders.service.js';
import { euro } from '../templates/merge-format.js';
import { INVOICE_DUE_TRIGGER, INVOICE_REMINDER_DEFAULTS } from './invoices.constants.js';

/** "3 invoices (€ 4.200,00) are not paid yet." — a sentence with the right singular or plural, once for each language. */
const unpaidNl = (count: number, amount: string): string => (count === 1 ? `1 factuur (${amount}) is nog niet betaald.` : `${count} facturen (${amount}) zijn nog niet betaald.`);
const unpaidEn = (count: number, amount: string): string => (count === 1 ? `1 invoice (${amount}) has not been paid yet.` : `${count} invoices (${amount}) have not been paid yet.`);

/**
 * What the reminder engine may watch about invoices: the day an outgoing invoice that was sent and is not paid yet falls due. One reminder tells about a whole day — "3 invoices
 * (€ 4.200,00) fall due and are not paid yet" — not about every invoice, which would bury the real ones. Who is told, and how many days before, are rules the office edits
 * (Settings → Notifications and reminders). Marking an invoice paid takes it out of the next reminder.
 */
@Injectable()
export class InvoiceRemindersService implements OnModuleInit {
  constructor(
    private readonly reminders: RemindersService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.reminders.register({
      trigger: INVOICE_DUE_TRIGGER,
      type: 'deadline',
      textKey: 'invoice.due',
      requires: 'invoices.view',
      names: { nl: 'Factuur: betaaltermijn', en: 'Invoice: payment due' },
      description: {
        nl: 'De dag waarop verstuurde facturen aan klanten betaald moeten zijn, zolang ze nog niet als betaald zijn gemarkeerd. Eén melding per dag, met hoeveel facturen het zijn en het bedrag.',
        en: 'The day sent invoices to clients have to be paid, as long as they are not marked as paid. One message per day, saying how many invoices there are and the amount.',
      },
      defaults: { offsets: [...INVOICE_REMINDER_DEFAULTS.offsets], dayType: INVOICE_REMINDER_DEFAULTS.dayType, channels: [...INVOICE_REMINDER_DEFAULTS.channels] },
      items: today => this.items(today),
    });
  }

  private async items(today: string): Promise<ReminderItem[]> {
    const groups = await this.prisma.invoice.groupBy({
      by: ['dueDate'],
      where: { direction: 'outgoing', kind: 'invoice', status: 'sent', dueDate: { gte: parseDay(today) } },
      _count: { _all: true },
      _sum: { total: true },
    });
    return groups.flatMap(group => {
      if (!group.dueDate) return [];
      const day = formatDay(group.dueDate);
      const count = group._count._all;
      const total = group._sum.total?.toNumber() ?? 0;
      return [
        {
          subjectType: 'invoice_due_day',
          subjectId: day,
          dueOn: day,
          clientId: null,
          params: { countNl: unpaidNl(count, euro(total, 'nl')), countEn: unpaidEn(count, euro(total, 'en')), date: day },
          link: '/invoices?tab=outgoing&open=1',
        } satisfies ReminderItem,
      ];
    });
  }
}
