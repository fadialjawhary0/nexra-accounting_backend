import { Injectable } from '@nestjs/common';
import { addMonths, daysBetween, formatDay, parseDay, todayInAmsterdam } from '../../common/dates.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { EmployerRegistrationsService } from './employer-registrations.service.js';
import { TaxDeadlinesService } from './tax-deadlines.service.js';
import { periodKey, rangeOf } from './tax-periods.js';
import { TaxReturnsService } from './tax-returns.service.js';
import { OPEN_RETURN_STATUSES, type ReturnKind } from './taxes.constants.js';
import { VatStepsService } from './vat-steps.service.js';
import { filedOf, readTicks } from './vat-ticks.js';

/**
 * What needs attention in the taxes, in a handful of numbers: VAT returns that are not filed (and how many are past their deadline), yearly returns that are not filed (and
 * how many are late) and clients that have workers but are not registered as an employer. The tabs of the taxes show them; the dashboard will read the same numbers.
 */
@Injectable()
export class TaxesAttentionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly steps: VatStepsService,
    private readonly deadlines: TaxDeadlinesService,
    private readonly returns: TaxReturnsService,
    private readonly employers: EmployerRegistrationsService,
  ) {}

  private async vat(today: string) {
    const [steps, rows] = await Promise.all([
      this.steps.active(),
      this.prisma.vatPeriod.findMany({ where: { isActive: true, client: { isActive: true }, periodEnd: { gte: parseDay(addMonths(today, -6)) } }, select: { kind: true, periodStart: true, periodEnd: true, ticks: true, completedAt: true } }),
    ]);
    const filing = steps.filter(step => step.isFiling).map(step => step.code);
    let open = 0;
    let overdue = 0;
    // The period whose deadline is the next one that is still ahead, and how many of its returns are not filed.
    const upcoming = new Map<string, { dueOn: string; period: string; daysLeft: number; open: number }>();
    for (const row of rows) {
      if (filedOf(readTicks(row.ticks), filing, row.completedAt !== null).filed) continue;
      const range = rangeOf(row.kind, formatDay(row.periodStart));
      const dueOn = this.deadlines.vatDue(range.kind, formatDay(row.periodEnd));
      open += 1;
      if (dueOn < today) {
        overdue += 1;
        continue;
      }
      const key = periodKey(range);
      const entry = upcoming.get(key) ?? { dueOn, period: key, daysLeft: daysBetween(today, dueOn), open: 0 };
      entry.open += 1;
      upcoming.set(key, entry);
    }
    const next = [...upcoming.values()].sort((a, b) => a.dueOn.localeCompare(b.dueOn))[0] ?? null;
    return { open, overdue, next };
  }

  private async yearly(kind: ReturnKind, today: string) {
    const rows = await this.prisma.taxReturn.findMany({
      where: { kind, isActive: true, status: { in: [...OPEN_RETURN_STATUSES] }, client: { isActive: true } },
      select: { kind: true, taxYear: true, periodEnd: true, clientId: true, extensionStatus: true, extensionUntil: true },
    });
    const overdue = rows.filter(row => this.returns.deadlineOf(row).effective < today).length;
    return { open: rows.length, overdue };
  }

  async summary() {
    const today = todayInAmsterdam();
    const [vat, incomeTax, corporateTax, employers] = await Promise.all([this.vat(today), this.yearly('income_tax', today), this.yearly('corporate_tax', today), this.employers.counts()]);
    return { vat, incomeTax, corporateTax, employers: { toRegister: employers.to_register } };
  }
}
