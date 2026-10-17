import { Injectable } from '@nestjs/common';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import { formatDay, parseDay } from '../../common/dates.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import type { ExportTable } from '../../lib/exports/export.types.js';
import { minutesToHours } from '../hours/hours-time.js';
import { personName } from '../people/person-record.js';
import { COUNTED_INVOICE } from '../reconciliation/reconciliation.constants.js';
import { ReconciliationService } from '../reconciliation/reconciliation.service.js';
import type { MarkupQuery } from './dto/invoice.dto.js';
import { partyOf } from './invoice-record.js';
import type { InvoiceDirection } from './invoices.constants.js';

export interface MarkupRow {
  lineId: string;
  invoiceId: string;
  invoiceNumber: string;
  client: { number: string; name: string };
  employeeId: string | null;
  worker: string;
  kind: 'hours' | 'markup';
  from: string | null;
  to: string | null;
  minutes: number;
  /** What the line bills per hour. */
  rate: number | null;
  invoiced: number;
  /** What the registered hours behind the line are paid; `null` when a day has no rate. */
  pay: number | null;
  markup: number | null;
  markupPercent: number | null;
  /** Billed hours that no registered hour backs: the markup of such a line cannot be told. */
  unbacked: number;
}

export interface MarkupTotals {
  minutes: number;
  invoiced: number;
  pay: number;
  markup: number;
  markupPercent: number | null;
  incomplete: number;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * The markup report: per company, per worker, what the company bills for the hours, what the worker is paid for the same hours, and the difference — in
 * euros and as a percentage of the pay. The pay comes from the hourly rate of each registered day behind the line; a line that bills hours nobody registered,
 * or hours without a rate, has no markup we can state and is counted as incomplete. A company's separate markup lines are added as they stand. A line counts
 * in the period in which it starts, so a line is never counted twice when two months are put side by side.
 */
@Injectable()
export class MarkupReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reconciliation: ReconciliationService,
  ) {}

  async report(query: MarkupQuery) {
    const { from, to } = this.reconciliation.period(query);
    const direction: InvoiceDirection = query.direction ?? 'incoming';
    const range = { gte: parseDay(from), lte: parseDay(to) };
    const lines = await this.prisma.invoiceLine.findMany({
      where: {
        AND: [
          { invoice: { ...COUNTED_INVOICE, direction, ...(query.clientId && { clientId: query.clientId }), ...(query.partyId && { OR: [{ counterpartyId: query.partyId }, { otherClientId: query.partyId }] }) } },
          { OR: [{ kind: 'hours', fromDate: range }, { kind: 'markup', invoice: { periodFrom: range } }] },
        ],
      },
      include: {
        employee: { include: { person: true } },
        invoice: { select: { id: true, number: true, client: { select: { number: true, name: true } }, counterparty: { select: { id: true, name: true } }, otherClient: { select: { id: true, number: true, name: true } } } },
      },
      orderBy: [{ invoice: { invoiceDate: 'asc' } }, { sortOrder: 'asc' }],
    });
    const pay = await this.reconciliation.linePay(lines.map(line => line.employeeId).filter((id): id is string => Boolean(id)), from, to);

    const parties = new Map<string, { party: ReturnType<typeof partyOf>; rows: MarkupRow[] }>();
    for (const line of lines) {
      const party = partyOf(line.invoice);
      const key = `${party.type}:${party.id}`;
      const entry = parties.get(key) ?? { party, rows: [] };
      const invoiced = line.amount.toNumber();
      const base = { lineId: line.id, invoiceId: line.invoice.id, invoiceNumber: line.invoice.number ?? '', client: line.invoice.client, employeeId: line.employeeId };
      if (line.kind === 'markup') {
        entry.rows.push({ ...base, worker: line.description || line.rawName, kind: 'markup', from: null, to: null, minutes: 0, rate: null, invoiced, pay: null, markup: invoiced, markupPercent: null, unbacked: 0 });
      } else {
        const figures = line.employeeId ? pay.get(line.id) : undefined;
        const complete = Boolean(figures) && figures!.unbacked === 0 && figures!.payCents !== null;
        const paid = complete ? (figures!.payCents as number) / 100 : null;
        entry.rows.push({
          ...base,
          worker: line.employee ? personName(line.employee.person) : line.rawName,
          kind: 'hours',
          from: line.fromDate ? formatDay(line.fromDate) : null,
          to: line.toDate ? formatDay(line.toDate) : null,
          minutes: line.minutes,
          rate: line.rate ? line.rate.toNumber() : null,
          invoiced,
          pay: paid,
          markup: paid === null ? null : round2(invoiced - paid),
          markupPercent: paid ? round2(((invoiced - paid) / paid) * 100) : null,
          unbacked: figures?.unbacked ?? line.minutes,
        });
      }
      parties.set(key, entry);
    }

    const totalsOf = (rows: MarkupRow[]): MarkupTotals => {
      const complete = rows.filter(row => row.kind === 'hours' && row.markup !== null);
      const pay = round2(complete.reduce((sum, row) => sum + (row.pay as number), 0));
      const markup = round2(rows.filter(row => row.markup !== null).reduce((sum, row) => sum + (row.markup as number), 0));
      const computed = round2(complete.reduce((sum, row) => sum + (row.markup as number), 0));
      return {
        minutes: rows.reduce((sum, row) => sum + row.minutes, 0),
        invoiced: round2(rows.reduce((sum, row) => sum + row.invoiced, 0)),
        pay,
        markup,
        markupPercent: pay ? round2((computed / pay) * 100) : null,
        incomplete: rows.filter(row => row.kind === 'hours' && row.markup === null).length,
      };
    };
    const groups = [...parties.values()].sort((a, b) => a.party.name.localeCompare(b.party.name, 'nl')).map(entry => ({ party: entry.party, rows: entry.rows, totals: totalsOf(entry.rows) }));
    return { from, to, direction, parties: groups, totals: totalsOf(groups.flatMap(group => group.rows)) };
  }

  /** The report as a table for Excel, PDF or Word. */
  async table(query: MarkupQuery, locale: AppLocale): Promise<ExportTable> {
    const data = await this.report(query);
    const nl = locale === 'nl';
    return {
      title: nl ? 'Opslagrapport' : 'Markup report',
      subtitle: `${data.from} – ${data.to} · ${data.direction === 'incoming' ? (nl ? 'inkomende facturen' : 'incoming invoices') : nl ? 'uitgaande facturen' : 'outgoing invoices'}`,
      locale,
      columns: [
        { key: 'party', header: nl ? 'Bedrijf' : 'Company', width: 28 },
        { key: 'client', header: nl ? 'Klant' : 'Client', width: 26 },
        { key: 'invoice', header: nl ? 'Factuur' : 'Invoice', width: 14 },
        { key: 'worker', header: nl ? 'Werknemer of omschrijving' : 'Employee or description', width: 28 },
        { key: 'period', header: nl ? 'Periode' : 'Period', width: 24 },
        { key: 'hours', header: nl ? 'Uren' : 'Hours', type: 'number', width: 9 },
        { key: 'invoiced', header: nl ? 'Gefactureerd' : 'Invoiced', type: 'money', width: 13 },
        { key: 'pay', header: nl ? 'Loon (bruto)' : 'Pay (gross)', type: 'money', width: 13 },
        { key: 'markup', header: nl ? 'Opslag' : 'Markup', type: 'money', width: 12 },
        { key: 'percent', header: nl ? 'Opslag %' : 'Markup %', type: 'number', width: 10 },
      ],
      rows: [
        ...data.parties.flatMap(group =>
          group.rows.map(row => ({
            party: group.party.number ? `${group.party.number} – ${group.party.name}` : group.party.name,
            client: `${row.client.number} – ${row.client.name}`,
            invoice: row.invoiceNumber,
            worker: row.worker,
            period: row.from && row.to ? `${row.from} – ${row.to}` : '',
            hours: row.kind === 'hours' ? minutesToHours(row.minutes) : '',
            invoiced: row.invoiced,
            pay: row.pay ?? '',
            markup: row.markup ?? '',
            percent: row.markupPercent ?? '',
          })),
        ),
        { party: nl ? 'Totaal' : 'Total', hours: minutesToHours(data.totals.minutes), invoiced: data.totals.invoiced, pay: data.totals.pay, markup: data.totals.markup, percent: data.totals.markupPercent ?? '' },
      ],
    };
  }
}

