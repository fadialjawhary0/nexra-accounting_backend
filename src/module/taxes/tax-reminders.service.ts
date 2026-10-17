import { Injectable, type OnModuleInit } from '@nestjs/common';
import { addMonths, formatDay, parseDay } from '../../common/dates.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import type { ReminderItem } from '../reminders/reminder-types.js';
import { RemindersService } from '../reminders/reminders.service.js';
import { TaxDeadlinesService } from './tax-deadlines.service.js';
import { periodKey, periodLabel, rangeOf } from './tax-periods.js';
import { TaxReturnsService } from './tax-returns.service.js';
import { OPEN_RETURN_STATUSES, RETURN_DEADLINE_TRIGGER, TAX_REMINDER_DEFAULTS, VAT_DEADLINE_TRIGGER, type ReturnKind } from './taxes.constants.js';
import { VatStepsService } from './vat-steps.service.js';
import { filedOf, readTicks } from './vat-ticks.js';

const KIND_NAMES: Record<ReturnKind, { nl: string; en: string }> = {
  income_tax: { nl: 'Inkomstenbelasting', en: 'Income tax' },
  corporate_tax: { nl: 'Vennootschapsbelasting', en: 'Corporate income tax' },
};

/** "37 van de 250 aangiften zijn nog niet verstuurd." — a sentence with the right singular or plural, once for each language. */
const notFiledNl = (open: number, total: number): string => {
  if (total === 1) return 'De aangifte is nog niet verstuurd.';
  if (open === total) return `Geen van de ${total} aangiften is verstuurd.`;
  return open === 1 ? `1 van de ${total} aangiften is nog niet verstuurd.` : `${open} van de ${total} aangiften zijn nog niet verstuurd.`;
};
const notFiledEn = (open: number, total: number): string => {
  if (total === 1) return 'The return has not been filed yet.';
  if (open === total) return `None of the ${total} returns have been filed yet.`;
  return open === 1 ? `1 of the ${total} returns has not been filed yet.` : `${open} of the ${total} returns have not been filed yet.`;
};
const openNl = (open: number): string => (open === 1 ? '1 aangifte staat nog open.' : `${open} aangiften staan nog open.`);
const openEn = (open: number): string => (open === 1 ? '1 return is still open.' : `${open} returns are still open.`);

/**
 * What the reminder engine may watch about taxes: the deadline of a VAT period and the deadline of the yearly returns. One reminder tells about a whole period (or a whole
 * year) — "37 of the 250 returns of Q3 are not filed, the deadline is in a week" — not about every client, which would bury the real ones. Who is told, and how many days
 * before, are rules the office edits (Settings → Notifications and reminders).
 */
@Injectable()
export class TaxRemindersService implements OnModuleInit {
  constructor(
    private readonly reminders: RemindersService,
    private readonly prisma: PrismaService,
    private readonly steps: VatStepsService,
    private readonly deadlines: TaxDeadlinesService,
    private readonly returns: TaxReturnsService,
  ) {}

  onModuleInit(): void {
    const defaults = (trigger: keyof typeof TAX_REMINDER_DEFAULTS) => ({ offsets: [...TAX_REMINDER_DEFAULTS[trigger].offsets], dayType: TAX_REMINDER_DEFAULTS[trigger].dayType, channels: [...TAX_REMINDER_DEFAULTS[trigger].channels] });
    this.reminders.register({
      trigger: VAT_DEADLINE_TRIGGER,
      type: 'deadline',
      textKey: 'tax.vat_deadline',
      requires: 'taxes.view',
      names: { nl: 'Btw-aangifte: deadline', en: 'VAT return: deadline' },
      description: {
        nl: 'De deadline van een btw-periode (het kwartaal, de maand of het jaar), zolang er klanten zijn waarvan de aangifte nog niet is verstuurd. Eén melding voor de hele periode, met hoeveel aangiftes er nog open staan.',
        en: 'The deadline of a VAT period (the quarter, month or year), as long as there are clients whose return has not been filed. One message for the whole period, saying how many returns are still open.',
      },
      defaults: defaults(VAT_DEADLINE_TRIGGER),
      items: today => this.vatItems(today),
    });
    this.reminders.register({
      trigger: RETURN_DEADLINE_TRIGGER,
      type: 'deadline',
      textKey: 'tax.return_deadline',
      requires: 'taxes.view',
      names: { nl: 'Aangifte inkomstenbelasting / vennootschapsbelasting: deadline', en: 'Income tax / corporate tax return: deadline' },
      description: {
        nl: 'De deadline van de jaaraangiften (inkomstenbelasting en vennootschapsbelasting), zolang er aangiftes niet zijn ingediend. Ook de dag waarop uitstel aangevraagd moet zijn. Eén melding per jaar en deadline, met hoeveel aangiftes er nog open staan.',
        en: 'The deadline of the yearly returns (income tax and corporate tax), as long as returns have not been filed. It is also the day an extension has to be asked for. One message per year and deadline, saying how many returns are still open.',
      },
      defaults: defaults(RETURN_DEADLINE_TRIGGER),
      items: today => this.returnItems(today),
    });
  }

  private async vatItems(today: string): Promise<ReminderItem[]> {
    const [steps, rows] = await Promise.all([
      this.steps.active(),
      // Only periods whose deadline can still be ahead (the deadline is at most a few months after the end of a period).
      this.prisma.vatPeriod.findMany({ where: { isActive: true, client: { isActive: true }, periodEnd: { gte: parseDay(addMonths(today, -6)) } }, select: { kind: true, periodStart: true, periodEnd: true, ticks: true, completedAt: true } }),
    ]);
    const filing = steps.filter(step => step.isFiling).map(step => step.code);
    const groups = new Map<string, { kind: string; start: string; end: string; total: number; open: number }>();
    for (const row of rows) {
      const start = formatDay(row.periodStart);
      const key = `${row.kind}:${start}`;
      const group = groups.get(key) ?? { kind: row.kind, start, end: formatDay(row.periodEnd), total: 0, open: 0 };
      group.total += 1;
      if (!filedOf(readTicks(row.ticks), filing, row.completedAt !== null).filed) group.open += 1;
      groups.set(key, group);
    }
    return [...groups.entries()].flatMap(([id, group]) => {
      const range = rangeOf(group.kind, group.start);
      const dueOn = this.deadlines.vatDue(range.kind, group.end);
      if (!group.open || dueOn < today) return [];
      return [
        {
          subjectType: 'vat_period_group',
          subjectId: id,
          dueOn,
          clientId: null,
          params: { periodNl: periodLabel(range, 'nl'), periodEn: periodLabel(range, 'en'), openNl: notFiledNl(group.open, group.total), openEn: notFiledEn(group.open, group.total), date: dueOn },
          link: `/taxes/vat?period=${periodKey(range)}&open=1`,
        } satisfies ReminderItem,
      ];
    });
  }

  private async returnItems(today: string): Promise<ReminderItem[]> {
    const rows = await this.prisma.taxReturn.findMany({
      where: { isActive: true, status: { in: [...OPEN_RETURN_STATUSES] }, client: { isActive: true } },
      select: { kind: true, taxYear: true, periodEnd: true, clientId: true, extensionStatus: true, extensionUntil: true },
    });
    const groups = new Map<string, { kind: ReturnKind; taxYear: number; dueOn: string; open: number }>();
    for (const row of rows) {
      const kind = row.kind as ReturnKind;
      const { effective } = this.returns.deadlineOf({ kind, taxYear: row.taxYear, periodEnd: row.periodEnd, clientId: row.clientId, extensionStatus: row.extensionStatus, extensionUntil: row.extensionUntil });
      if (effective < today) continue;
      const key = `${kind}:${row.taxYear}:${effective}`;
      const group = groups.get(key) ?? { kind, taxYear: row.taxYear, dueOn: effective, open: 0 };
      group.open += 1;
      groups.set(key, group);
    }
    return [...groups.entries()].map(
      ([id, group]) =>
        ({
          subjectType: 'tax_return_group',
          subjectId: id,
          dueOn: group.dueOn,
          clientId: null,
          params: { kindNl: KIND_NAMES[group.kind].nl, kindEn: KIND_NAMES[group.kind].en, year: group.taxYear, openNl: openNl(group.open), openEn: openEn(group.open), date: group.dueOn },
          link: `/taxes/${group.kind === 'income_tax' ? 'income-tax' : 'corporate-tax'}?year=${group.taxYear}&open=1`,
        }) satisfies ReminderItem,
    );
  }
}
