import { Injectable, NotFoundException } from '@nestjs/common';
import PizZip from 'pizzip';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import { addDays, formatDay, parseDay } from '../../common/dates.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { validationFailed } from '../../common/validation/failure.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import type { ExportFile, ExportTable } from '../../lib/exports/export.types.js';
import { ExportsService } from '../../lib/exports/exports.service.js';
import { workKindOf } from '../employees/employee-record.js';
import { FilesService } from '../files/files.service.js';
import { hirerNames, whereText } from '../hours/hours-pay.service.js';
import { firstOfMonth, fromCents, isMonth, lastOfMonth, minutesToHours } from '../hours/hours-time.js';
import { partyOf } from '../invoices/invoice-record.js';
import { personName } from '../people/person-record.js';
import { COUNTED_INVOICE } from '../reconciliation/reconciliation.constants.js';
import { ReconciliationService } from '../reconciliation/reconciliation.service.js';
import { matrixAllows } from '../roles/permission-catalog.js';

/** ASCII only, no characters a file name cannot hold. */
const ascii = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

interface InquiryStatement {
  id: string;
  from: string;
  to: string;
  totalMinutes: number;
  /** The minutes of the statement that fall in the month. */
  minutes: number;
  amount: number;
  fileId: string | null;
  pdfFileId: string | null;
}

/**
 * The worker inquiry ("Yousef, September: 20 hours — where, which invoice, what was paid"): one worker and one month, with the hours day by day and where they
 * were worked, the salary statements that pay them, the invoices that bill them, and what does not match. Hours = salary = invoices is worked out by the
 * reconciliation; this puts it in front of the person who asks (an inspector, a client) and bundles the documents.
 */
@Injectable()
export class InquiryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reconciliation: ReconciliationService,
    private readonly files: FilesService,
    private readonly exports: ExportsService,
  ) {}

  async inquiry(employeeId: string, month: string, user: AuthenticatedUser) {
    if (!isMonth(month)) throw validationFailed({ month: 'validation.invalid' });
    const worker = await this.prisma.employee.findUnique({ where: { id: employeeId }, include: { person: true, client: { select: { id: true, number: true, name: true } } } });
    if (!worker) throw new NotFoundException({ code: 'not_found', message: 'Employee not found' });
    const from = firstOfMonth(month);
    const to = lastOfMonth(month);
    const range = { gte: parseDay(from), lte: parseDay(to) };
    const canInvoices = matrixAllows(user.matrix, 'invoices.view');
    const canMoney = matrixAllows(user.matrix, 'salary_statements.view');

    const [entries, statementRows, lineRows, figures] = await Promise.all([
      this.prisma.hourEntry.findMany({ where: { employeeId, date: range }, orderBy: [{ date: 'asc' }, { createdAt: 'asc' }] }),
      canMoney ? this.prisma.salaryStatement.findMany({ where: { employeeId, status: 'final', periodFrom: { lte: range.lte }, periodTo: { gte: range.gte } }, orderBy: { periodFrom: 'asc' } }) : Promise.resolve([]),
      canInvoices
        ? this.prisma.invoiceLine.findMany({
            where: { employeeId, kind: 'hours', fromDate: { lte: range.lte }, toDate: { gte: range.gte }, invoice: COUNTED_INVOICE },
            include: { invoice: { select: { id: true, number: true, direction: true, status: true, kind: true, invoiceDate: true, periodFrom: true, periodTo: true, total: true, fileId: true, pdfFileId: true, client: { select: { number: true, name: true } }, counterparty: { select: { id: true, name: true } }, otherClient: { select: { id: true, number: true, name: true } } } } },
            orderBy: [{ invoice: { invoiceDate: 'asc' } }, { sortOrder: 'asc' }],
          })
        : Promise.resolve([]),
      this.reconciliation.forWorkers([employeeId], from, to),
    ]);
    const result = figures.get(employeeId)!;
    const hirers = await hirerNames(this.prisma, entries);

    // Which invoices cover which days (from the allocation the reconciliation worked out).
    const invoiceOf = new Map(lineRows.map(line => [line.id, line.invoice]));
    const dateOfEntry = new Map(entries.map(entry => [entry.id, formatDay(entry.date)]));
    const coveredByDay = new Map<string, Array<{ invoiceId: string; number: string; direction: string; minutes: number }>>();
    const coveredInMonth = new Map<string, number>();
    for (const [lineId, coverage] of result.coverage) {
      const invoice = invoiceOf.get(lineId);
      if (!invoice) continue;
      for (const part of coverage.parts) {
        const date = dateOfEntry.get(part.entryId) ?? part.date;
        if (date < from || date > to) continue;
        coveredInMonth.set(lineId, (coveredInMonth.get(lineId) ?? 0) + part.minutes);
        const list = coveredByDay.get(date) ?? [];
        list.push({ invoiceId: invoice.id, number: invoice.number ?? '', direction: invoice.direction, minutes: part.minutes });
        coveredByDay.set(date, list);
      }
    }

    const byDate = new Map<string, typeof entries>();
    for (const entry of entries) {
      const key = formatDay(entry.date);
      byDate.set(key, [...(byDate.get(key) ?? []), entry]);
    }
    const figureOf = new Map(result.days.map(day => [day.date, day]));
    const days: Array<Record<string, unknown>> = [];
    for (let date = from; date <= to; date = addDays(date, 1)) {
      const mine = byDate.get(date) ?? [];
      const figure = figureOf.get(date);
      days.push({
        date,
        weekday: parseDay(date).getUTCDay(),
        minutes: mine.reduce((sum, entry) => sum + entry.minutes, 0),
        entries: mine.map(entry => ({ id: entry.id, minutes: entry.minutes, startTime: entry.startTime, endTime: entry.endTime, where: whereText(entry.data, hirers) })),
        ...(canMoney && { paidMinutes: figure?.paid ?? 0 }),
        ...(canInvoices && { invoicedOutgoing: figure?.outgoing ?? 0, invoicedIncoming: figure?.incoming ?? 0, invoices: coveredByDay.get(date) ?? [] }),
      });
    }

    const statements: InquiryStatement[] = statementRows.map(row => {
      const lines = row.lines as unknown as Array<{ type: string; date: string; minutes: number }>;
      return {
        id: row.id,
        from: formatDay(row.periodFrom),
        to: formatDay(row.periodTo),
        totalMinutes: row.totalMinutes,
        minutes: lines.filter(line => line.type === 'work' && line.date >= from && line.date <= to).reduce((sum, line) => sum + line.minutes, 0),
        amount: row.totalAmount.toNumber(),
        fileId: row.fileId,
        pdfFileId: row.pdfFileId,
      };
    });

    const invoices = new Map<string, { id: string; number: string; direction: string; kind: string; status: string; party: ReturnType<typeof partyOf>; client: { number: string; name: string }; invoiceDate: string | null; periodFrom: string; periodTo: string; total: number; coveredMinutes: number; lines: Array<Record<string, unknown>> }>();
    for (const line of lineRows) {
      const invoice = line.invoice;
      const entry = invoices.get(invoice.id) ?? {
        id: invoice.id,
        number: invoice.number ?? '',
        direction: invoice.direction,
        kind: invoice.kind,
        status: invoice.status,
        party: partyOf(invoice),
        client: invoice.client,
        invoiceDate: invoice.invoiceDate ? formatDay(invoice.invoiceDate) : null,
        periodFrom: formatDay(invoice.periodFrom),
        periodTo: formatDay(invoice.periodTo),
        total: invoice.total.toNumber(),
        coveredMinutes: 0,
        lines: [],
      };
      const covered = coveredInMonth.get(line.id) ?? 0;
      entry.coveredMinutes += covered;
      entry.lines.push({ id: line.id, from: line.fromDate ? formatDay(line.fromDate) : null, to: line.toDate ? formatDay(line.toDate) : null, billed: line.minutes, coveredInMonth: covered, rate: line.rate ? line.rate.toNumber() : null, amount: line.amount.toNumber() });
      invoices.set(invoice.id, entry);
    }

    return {
      employee: {
        id: worker.id,
        name: personName(worker.person),
        clientId: worker.client.id,
        clientNumber: worker.client.number,
        clientName: worker.client.name,
        kind: workKindOf(worker.data),
        isActive: worker.isActive,
      },
      month,
      from,
      to,
      days,
      totals: {
        registered: result.registered,
        ...(canMoney && { paid: result.paid, paidAmount: fromCents(result.paidCents) }),
        ...(canInvoices && { invoicedOutgoing: result.invoiced.outgoing, invoicedIncoming: result.invoiced.incoming }),
      },
      statements: statements.map(({ fileId: _word, pdfFileId, ...rest }) => ({ ...rest, hasDocument: Boolean(_word || pdfFileId) })),
      invoices: canInvoices ? [...invoices.values()] : null,
      reconciliation: canInvoices && canMoney ? { status: result.status, expected: result.expected, causes: result.causes } : null,
    };
  }

  /** The inquiry as a table for Excel, PDF or Word: every day of the month, then the totals. */
  async table(employeeId: string, month: string, user: AuthenticatedUser, locale: AppLocale): Promise<ExportTable> {
    const data = await this.inquiry(employeeId, month, user);
    const nl = locale === 'nl';
    const canMoney = data.totals.paid !== undefined;
    const canInvoices = data.invoices !== null;
    const hours = (minutes: number) => (minutes ? minutesToHours(minutes) : '');
    const rows = (data.days as Array<Record<string, any>>).map(day => ({
      date: day.date,
      hours: hours(day.minutes),
      where: (day.entries as Array<{ where: string }>).map(entry => entry.where).filter(Boolean).join(' · '),
      paid: hours(day.paidMinutes ?? 0),
      invoiced: hours((day.invoicedOutgoing ?? 0) + (day.invoicedIncoming ?? 0)),
      invoices: [...new Set((day.invoices as Array<{ number: string }> | undefined)?.map(invoice => invoice.number) ?? [])].join(', '),
    }));
    return {
      title: `${nl ? 'Onderzoek werknemer' : 'Worker inquiry'} – ${data.employee.name}`,
      subtitle: `${data.employee.clientNumber} – ${data.employee.clientName} · ${data.month}`,
      locale,
      columns: [
        { key: 'date', header: nl ? 'Datum' : 'Date', type: 'date', width: 12 },
        { key: 'hours', header: nl ? 'Uren' : 'Hours', type: 'number', width: 9 },
        { key: 'where', header: nl ? 'Waar gewerkt' : 'Where worked', width: 44 },
        ...(canMoney ? [{ key: 'paid', header: nl ? 'Uitbetaald (uren)' : 'Paid (h)', type: 'number' as const, width: 14 }] : []),
        ...(canInvoices ? [{ key: 'invoiced', header: nl ? 'Gefactureerd (uren)' : 'Invoiced (h)', type: 'number' as const, width: 16 }, { key: 'invoices', header: nl ? 'Facturen' : 'Invoices', width: 24 }] : []),
      ],
      rows: [
        ...rows,
        {
          date: nl ? 'Totaal' : 'Total',
          hours: minutesToHours(data.totals.registered),
          paid: canMoney ? minutesToHours(data.totals.paid ?? 0) : '',
          invoiced: canInvoices ? minutesToHours((data.totals.invoicedOutgoing ?? 0) + (data.totals.invoicedIncoming ?? 0)) : '',
        },
      ],
    };
  }

  /**
   * Everything that answers an inspector's question about one worker and month, in one ZIP: the inquiry (Excel), the salary statements that pay the month
   * and the invoices that bill it (the PDF where there is one) — only what the person may see.
   */
  async bundle(employeeId: string, month: string, user: AuthenticatedUser, locale: AppLocale): Promise<ExportFile> {
    const data = await this.inquiry(employeeId, month, user);
    const zip = new PizZip();
    let index = 0;
    const add = (name: string, buffer: Buffer) => {
      index += 1;
      zip.file(`${String(index).padStart(2, '0')}_${ascii(name)}`, buffer);
    };
    const overview = await this.exports.write(await this.table(employeeId, month, user, locale), 'xlsx', user.name);
    add(`${locale === 'nl' ? 'Onderzoek' : 'Inquiry'}_${data.employee.name}_${month}.xlsx`, overview.buffer);

    const rows = await this.prisma.salaryStatement.findMany({ where: { id: { in: data.statements.map(statement => statement.id) } }, select: { fileId: true, pdfFileId: true } });
    for (const row of rows) await this.addFile(row.pdfFileId ?? row.fileId, add);
    const invoiceRows = data.invoices ? await this.prisma.invoice.findMany({ where: { id: { in: data.invoices.map(invoice => invoice.id) } }, orderBy: [{ direction: 'asc' }, { invoiceDate: 'asc' }], select: { fileId: true, pdfFileId: true, direction: true, number: true } }) : [];
    for (const row of invoiceRows) await this.addFile(row.pdfFileId ?? row.fileId, add, `${row.direction === 'incoming' ? (locale === 'nl' ? 'Inkomend' : 'Incoming') : locale === 'nl' ? 'Uitgaand' : 'Outgoing'}_`);

    const buffer = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer;
    return { buffer, filename: `${ascii(`${locale === 'nl' ? 'Onderzoek' : 'Inquiry'}_${data.employee.name}_${month}`).replace(/ /g, '_')}.zip`, mimeType: 'application/zip' };
  }

  private async addFile(fileId: string | null, add: (name: string, buffer: Buffer) => void, prefix = ''): Promise<void> {
    if (!fileId) return;
    try {
      const { file, buffer } = await this.files.bytes(fileId);
      add(`${prefix}${file.name}`, buffer);
    } catch {
      // A file that is gone from the disk is left out of the bundle; the rest still goes.
    }
  }
}
