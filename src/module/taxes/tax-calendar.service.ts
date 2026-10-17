import { Injectable } from '@nestjs/common';
import { addMonths, formatDay, parseDay } from '../../common/dates.js';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { TaxDeadlinesService } from './tax-deadlines.service.js';
import { periodKey, periodLabel, rangeOf } from './tax-periods.js';
import { TaxReturnsService } from './tax-returns.service.js';
import { FILED_RETURN_STATUSES, OPEN_RETURN_STATUSES, type ReturnKind } from './taxes.constants.js';
import { VatStepsService } from './vat-steps.service.js';
import { filedOf, readTicks } from './vat-ticks.js';

/** One deadline for a whole group: the VAT returns of a period, or the yearly returns of one kind and year that share a deadline. */
export interface TaxDeadline {
  id: string;
  kind: 'vat' | ReturnKind;
  /** "Q3 2026", "2025". */
  label: string;
  dueOn: string;
  /** How many returns of the group are not filed, out of how many. */
  open: number;
  total: number;
  /** The screen that shows them. */
  link: string;
}

const RETURN_PATH: Record<ReturnKind, string> = { income_tax: 'income-tax', corporate_tax: 'corporate-tax' };

/**
 * The tax deadlines between two days, one entry per VAT period and one per year and kind of yearly return — not one per client, which would bury the calendar. The calendar
 * page shows them next to the appointments.
 */
@Injectable()
export class TaxCalendarService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly steps: VatStepsService,
    private readonly deadlines: TaxDeadlinesService,
    private readonly returns: TaxReturnsService,
  ) {}

  async between(from: string, to: string, locale: AppLocale): Promise<TaxDeadline[]> {
    const [vat, yearly] = await Promise.all([this.vat(from, to, locale), this.yearly(from, to)]);
    return [...vat, ...yearly].sort((a, b) => a.dueOn.localeCompare(b.dueOn));
  }

  private async vat(from: string, to: string, locale: AppLocale): Promise<TaxDeadline[]> {
    const [steps, rows] = await Promise.all([
      this.steps.active(),
      // A deadline comes after the end of the period (at most a few months): look at periods that ended before the last day asked for and not long before the first.
      this.prisma.vatPeriod.findMany({ where: { isActive: true, client: { isActive: true }, periodEnd: { gte: parseDay(addMonths(from, -15)), lte: parseDay(to) } }, select: { kind: true, periodStart: true, periodEnd: true, ticks: true, completedAt: true } }),
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
    const found: TaxDeadline[] = [];
    for (const group of groups.values()) {
      const range = rangeOf(group.kind, group.start);
      const dueOn = this.deadlines.vatDue(range.kind, group.end);
      if (dueOn < from || dueOn > to) continue;
      found.push({ id: `vat:${periodKey(range)}`, kind: 'vat', label: periodLabel(range, locale), dueOn, open: group.open, total: group.total, link: `/taxes/vat?period=${periodKey(range)}${group.open ? '&open=1' : ''}` });
    }
    return found;
  }

  private async yearly(from: string, to: string): Promise<TaxDeadline[]> {
    const rows = await this.prisma.taxReturn.findMany({
      where: { isActive: true, client: { isActive: true }, status: { in: [...OPEN_RETURN_STATUSES, ...FILED_RETURN_STATUSES] }, taxYear: { gte: Number(from.slice(0, 4)) - 3, lte: Number(to.slice(0, 4)) } },
      select: { kind: true, taxYear: true, periodEnd: true, clientId: true, status: true, extensionStatus: true, extensionUntil: true },
    });
    const groups = new Map<string, { kind: ReturnKind; taxYear: number; dueOn: string; total: number; open: number }>();
    for (const row of rows) {
      const kind = row.kind as ReturnKind;
      const { effective } = this.returns.deadlineOf({ kind, taxYear: row.taxYear, periodEnd: row.periodEnd, clientId: row.clientId, extensionStatus: row.extensionStatus, extensionUntil: row.extensionUntil });
      if (effective < from || effective > to) continue;
      const key = `${kind}:${row.taxYear}:${effective}`;
      const group = groups.get(key) ?? { kind, taxYear: row.taxYear, dueOn: effective, total: 0, open: 0 };
      group.total += 1;
      if (OPEN_RETURN_STATUSES.includes(row.status)) group.open += 1;
      groups.set(key, group);
    }
    return [...groups.entries()].map(([id, group]) => ({
      id: `${group.kind}:${id}`,
      kind: group.kind,
      label: String(group.taxYear),
      dueOn: group.dueOn,
      open: group.open,
      total: group.total,
      link: `/taxes/${RETURN_PATH[group.kind]}?year=${group.taxYear}${group.open ? '&open=1' : ''}`,
    }));
  }
}
