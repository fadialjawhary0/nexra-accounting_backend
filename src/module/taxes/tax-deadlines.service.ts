import { Injectable } from '@nestjs/common';
import { addMonths } from '../../common/dates.js';
import { SettingsService } from '../../lib/settings/settings.service.js';
import { CalendarService } from '../calendar/calendar.service.js';
import { addMonthsKeepEnd, lastDayOf } from './tax-periods.js';
import { TAXES_DEFINITIONS, TAXES_NAMESPACE, type ReturnKind, type VatKind } from './taxes.constants.js';

const pad = (value: number): string => String(value).padStart(2, '0');

/**
 * When a return is due. The rules (the end of the month after the quarter, 1 May for income tax, five months after the financial year for corporate tax) are settings of the
 * office; a date that falls on a weekend or a holiday moves to the next working day, as the Dutch calendar of the office says.
 */
@Injectable()
export class TaxDeadlinesService {
  constructor(
    private readonly settings: SettingsService,
    private readonly calendar: CalendarService,
  ) {
    settings.register(TAXES_NAMESPACE, TAXES_DEFINITIONS, { exposed: true });
  }

  setting<T extends string | number | boolean>(name: keyof typeof TAXES_DEFINITIONS): T {
    return this.settings.get<T>(`${TAXES_NAMESPACE}.${name}`);
  }

  /** The day a VAT return of a period that ends on `periodEnd` is due. */
  vatDue(kind: VatKind, periodEnd: string, clientId?: string | null): string {
    const months = this.setting<number>(kind === 'year' ? 'vatYearDueMonthsAfter' : 'vatDueMonthsAfter');
    const target = addMonths(`${periodEnd.slice(0, 8)}01`, months);
    return this.calendar.moveDeadline(lastDayOf(Number(target.slice(0, 4)), Number(target.slice(5, 7))), clientId);
  }

  /** The statutory day of an income-tax return (before any extension). */
  private incomeTaxBase(taxYear: number): string {
    const month = this.setting<number>('incomeTaxDueMonth');
    const last = Number(lastDayOf(taxYear + 1, month).slice(8, 10));
    return `${taxYear + 1}-${pad(month)}-${pad(Math.min(this.setting<number>('incomeTaxDueDay'), last))}`;
  }

  private corporateTaxBase(periodEnd: string): string {
    return addMonthsKeepEnd(periodEnd, this.setting<number>('corporateTaxDueMonths'));
  }

  /** The day a yearly return is due, without an extension. */
  returnDue(kind: ReturnKind, row: { taxYear: number; periodEnd: string }, clientId?: string | null): string {
    return this.calendar.moveDeadline(kind === 'income_tax' ? this.incomeTaxBase(row.taxYear) : this.corporateTaxBase(row.periodEnd), clientId);
  }

  /** The date a request for an extension starts with: the usual extension beyond the deadline (a person can type another). */
  suggestedExtension(kind: ReturnKind, row: { taxYear: number; periodEnd: string }, clientId?: string | null): string {
    const day =
      kind === 'income_tax'
        ? addMonths(this.incomeTaxBase(row.taxYear), this.setting<number>('incomeTaxExtensionMonths'))
        : addMonthsKeepEnd(this.corporateTaxBase(row.periodEnd), this.setting<number>('corporateTaxExtensionMonths'));
    return this.calendar.moveDeadline(day, clientId);
  }
}
