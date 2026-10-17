import { Injectable, type OnModuleInit } from '@nestjs/common';
import { addDays, formatDay, parseDay } from '../../common/dates.js';
import { asRecord } from '../../common/record-values.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { CalendarService } from '../calendar/calendar.service.js';
import { personName } from '../people/person-record.js';
import type { ReminderItem, ReminderProvider } from '../reminders/reminder-types.js';
import { RemindersService } from '../reminders/reminders.service.js';
import { CONTRACT_REMINDER_DEFAULTS } from './contract-reminder-defaults.js';
import { FIELD, addMonths, contractLink, probationEnd } from './contract-record.js';

const WITH_PARTIES = { client: { select: { id: true, number: true, name: true } }, employee: { include: { person: true } } } as const;

/**
 * What the reminder engine may watch about contracts: the end of a running contract, the last day to give notice, the end of a probation period and
 * one year of on-call work. Only contracts that are running are watched (a draft has no firm dates yet; an ended or terminated one needs nothing),
 * and a contract that already has a renewal is left alone — its end is no longer news.
 */
@Injectable()
export class ContractRemindersService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly calendar: CalendarService,
    private readonly reminders: RemindersService,
  ) {}

  onModuleInit(): void {
    const shared = { type: 'contract', requires: 'contracts.view' } as const;
    this.reminders.register({
      ...shared,
      trigger: 'contract_end',
      textKey: 'contract.ending',
      names: { nl: 'Contract loopt af', en: 'Contract ends' },
      description: { nl: 'Een lopend contract met een einddatum. Kies hoeveel dagen vooraf je een herinnering wilt, bijvoorbeeld 30 en 14.', en: 'A running contract with an end date. Choose how many days ahead you want a reminder, for example 30 and 14.' },
      defaults: this.defaults('contract_end'),
      items: today => this.ending(today),
    });
    this.reminders.register({
      ...shared,
      trigger: 'contract_notice',
      textKey: 'contract.notice',
      names: { nl: 'Contract aanzeggen', en: 'Give notice of a contract' },
      description: { nl: 'Een contract voor bepaalde tijd van zes maanden of langer moet uiterlijk een maand voor het einde schriftelijk worden aangezegd. De herinnering telt terug vanaf die laatste dag.', en: 'A fixed-term contract of six months or more must be (not) renewed in writing at the latest a month before it ends. The reminder counts back from that last day.' },
      defaults: this.defaults('contract_notice'),
      items: today => this.notice(today),
    });
    this.reminders.register({
      ...shared,
      trigger: 'probation_end',
      textKey: 'contract.probation',
      names: { nl: 'Proeftijd loopt af', en: 'Probation ends' },
      description: { nl: 'Het einde van de proeftijd van een lopend contract.', en: 'The end of the probation period of a running contract.' },
      defaults: this.defaults('probation_end'),
      items: today => this.probation(today),
    });
    this.reminders.register({
      ...shared,
      trigger: 'on_call_year',
      textKey: 'contract.on_call_year',
      names: { nl: 'Oproepkracht na 12 maanden', en: 'On-call worker after 12 months' },
      description: { nl: 'Na twaalf maanden moet een oproepkracht een vast aantal uren worden aangeboden.', en: 'After twelve months an on-call worker must be offered a fixed number of hours.' },
      defaults: this.defaults('on_call_year'),
      items: today => this.onCall(today),
    });
  }

  private defaults(trigger: keyof typeof CONTRACT_REMINDER_DEFAULTS): ReminderProvider['defaults'] {
    const { offsets, dayType, channels } = CONTRACT_REMINDER_DEFAULTS[trigger];
    return { offsets: [...offsets], dayType, channels: [...channels] };
  }

  /** Running contracts with an end date that have not been renewed. */
  private async ending(today: string): Promise<ReminderItem[]> {
    const rows = await this.prisma.contract.findMany({
      where: { status: 'active', endDate: { gte: parseDay(today) }, renewals: { none: { status: { not: 'cancelled' } } } },
      include: WITH_PARTIES,
    });
    return rows.map(row => this.item(row, formatDay(row.endDate!), { date: formatDay(row.endDate!), start: formatDay(row.startDate) }));
  }

  /** Fixed-term contracts of six months or more: the last working day to give notice, a month before the end. */
  private async notice(today: string): Promise<ReminderItem[]> {
    const rows = await this.prisma.contract.findMany({
      where: { status: 'active', type: 'fixed_term', endDate: { gt: parseDay(today) }, renewals: { none: { status: { not: 'cancelled' } } } },
      include: WITH_PARTIES,
    });
    const items: ReminderItem[] = [];
    for (const row of rows) {
      const start = formatDay(row.startDate);
      const end = formatDay(row.endDate!);
      if (end < addDays(addMonths(start, 6), -1)) continue;
      const deadline = this.calendar.previousWorkingDay(addMonths(end, -1), row.clientId);
      if (deadline < today) continue;
      items.push(this.item(row, deadline, { date: end, deadline }));
    }
    return items;
  }

  /** Running contracts with a probation period: its last day. */
  private async probation(today: string): Promise<ReminderItem[]> {
    const rows = await this.prisma.contract.findMany({ where: { status: 'active' }, include: WITH_PARTIES });
    const items: ReminderItem[] = [];
    for (const row of rows) {
      const months = Number(asRecord(row.data)[FIELD.probationMonths] ?? 0);
      if (!(months > 0)) continue;
      const last = probationEnd(formatDay(row.startDate), months);
      if (last >= today) items.push(this.item(row, last, { date: last }));
    }
    return items;
  }

  /** Running on-call contracts: the day the worker has been on call for twelve months (counted from the first contract of the chain). */
  private async onCall(today: string): Promise<ReminderItem[]> {
    const rows = await this.prisma.contract.findMany({ where: { status: 'active', type: 'on_call' }, include: WITH_PARTIES });
    const items: ReminderItem[] = [];
    for (const row of rows) {
      let begin = formatDay(row.startDate);
      let parent = row.renewalOfId;
      for (let depth = 0; parent && depth < 20; depth += 1) {
        const previous = await this.prisma.contract.findUnique({ where: { id: parent }, select: { startDate: true, type: true, renewalOfId: true } });
        if (!previous || previous.type !== 'on_call') break;
        begin = formatDay(previous.startDate);
        parent = previous.renewalOfId;
      }
      const year = addMonths(begin, 12);
      const end = row.endDate ? formatDay(row.endDate) : null;
      if (year >= today && (!end || end >= year)) items.push(this.item(row, year, { date: year, start: begin }));
    }
    return items;
  }

  private item(row: { id: string; clientId: string; client: { number: string; name: string }; employee: { person: Parameters<typeof personName>[0] } }, dueOn: string, params: Record<string, string>): ReminderItem {
    return {
      subjectType: 'contract',
      subjectId: row.id,
      dueOn,
      clientId: row.clientId,
      params: { worker: personName(row.employee.person), client: `${row.client.number} – ${row.client.name}`, ...params },
      link: contractLink(row.id),
    };
  }
}
