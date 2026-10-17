import { Injectable } from '@nestjs/common';
import { ApiResult } from '../../common/api-result.js';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import { formatDay, isValidDay, parseDay } from '../../common/dates.js';
import { pageMeta } from '../../common/pagination.js';
import { fold } from '../../common/text.js';
import { validationFailed } from '../../common/validation/failure.js';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import type { ExportTable } from '../../lib/exports/export.types.js';
import { workKindOf, type WorkKind } from '../employees/employee-record.js';
import { firstOfMonth, fromCents, isMonth, lastOfMonth, minutesToHours, roundDiv, toCents } from '../hours/hours-time.js';
import { personName } from '../people/person-record.js';
import { allocate, type AllocEntry, type AllocLine, type Direction } from './allocation.js';
import { COUNTED_INVOICE } from './reconciliation.constants.js';
import { reconcile, type Cause, type Reconciliation, type RecLine, type RecStatementLine } from './reconcile.js';
import type { ReconciliationQuery } from './dto/reconciliation.dto.js';

type LineRow = Prisma.InvoiceLineGetPayload<{ include: { invoice: { select: { id: true; direction: true; clientId: true; invoiceDate: true; createdAt: true } } } }>;

interface Loaded {
  entries: Map<string, AllocEntry[]>;
  lines: Map<string, RecLine[]>;
  statementLines: Map<string, RecStatementLine[]>;
}

/** The order lines are allocated in: earlier invoices first (by invoice date, then by when they were made), and the lines of an invoice in their own order. */
const orderKey = (row: LineRow, invoiceDate = row.invoice.invoiceDate ? formatDay(row.invoice.invoiceDate) : formatDay(row.invoice.createdAt)): string =>
  `${invoiceDate}|${row.invoice.createdAt.toISOString()}|${row.invoice.id}|${String(row.sortOrder).padStart(6, '0')}|${row.id}`;

const toRecLine = (row: LineRow): RecLine => ({
  id: row.id,
  invoiceId: row.invoiceId,
  direction: row.invoice.direction as Direction,
  clientId: row.invoice.clientId,
  from: formatDay(row.fromDate as Date),
  to: formatDay(row.toDate as Date),
  minutes: row.minutes,
  amountCents: toCents(row.amount.toNumber()),
  rateCents: row.rate === null ? null : toCents(row.rate.toNumber()),
});

const EMPLOYEE_NAMES = { person: true, client: { select: { id: true, number: true, name: true } } } as const;

export interface LineCoverageView {
  /** What the line bills. */
  billed: number;
  /** Billed minutes that are backed by registered hours. */
  covered: number;
  /** Billed minutes with no registered hour behind them. */
  unbacked: number;
  /** All hours registered for the worker in the line's period (that this kind of invoice could bill). */
  registered: number;
  /** Registered hours in the period that no invoice of this direction covers. */
  uninvoiced: number;
}

/**
 * The loader of the reconciliation: it fetches the entries, the statements and the invoice lines of some workers and hands them to the pure functions
 * (`allocate`, `reconcile`). The same code answers the report, the worker inquiry, the checks when a month is closed and the "does this invoice match
 * the hours" column of an invoice.
 */
@Injectable()
export class ReconciliationService {
  constructor(private readonly prisma: PrismaService) {}

  /* ── Loading ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  /** The invoice lines that count for these workers in the period — and, because an earlier line uses up hours a later one could cover, the lines they touch in turn. */
  private async countedLines(ids: string[], from: string, to: string, excludeInvoiceId?: string): Promise<{ rows: LineRow[]; from: string; to: string }> {
    let window = { from, to };
    let rows: LineRow[] = [];
    for (let round = 0; round < 4; round += 1) {
      rows = await this.prisma.invoiceLine.findMany({
        where: {
          employeeId: { in: ids },
          kind: 'hours',
          fromDate: { lte: parseDay(window.to) },
          toDate: { gte: parseDay(window.from) },
          invoice: { ...COUNTED_INVOICE, credits: { none: { status: { not: 'cancelled' } } }, ...(excludeInvoiceId && { id: { not: excludeInvoiceId } }) },
        },
        include: { invoice: { select: { id: true, direction: true, clientId: true, invoiceDate: true, createdAt: true } } },
      });
      const next = {
        from: rows.reduce((min, row) => (row.fromDate && formatDay(row.fromDate) < min ? formatDay(row.fromDate) : min), window.from),
        to: rows.reduce((max, row) => (row.toDate && formatDay(row.toDate) > max ? formatDay(row.toDate) : max), window.to),
      };
      if (next.from === window.from && next.to === window.to) break;
      window = next;
    }
    return { rows, ...window };
  }

  private async load(ids: string[], from: string, to: string): Promise<Loaded> {
    const counted = await this.countedLines(ids, from, to);
    const [entryRows, statements] = await Promise.all([
      this.prisma.hourEntry.findMany({ where: { employeeId: { in: ids }, date: { gte: parseDay(counted.from), lte: parseDay(counted.to) } }, select: { id: true, employeeId: true, date: true, minutes: true, clientId: true, createdAt: true } }),
      this.prisma.salaryStatement.findMany({ where: { employeeId: { in: ids }, status: 'final', periodFrom: { lte: parseDay(to) }, periodTo: { gte: parseDay(from) } }, select: { employeeId: true, lines: true } }),
    ]);
    const entries = new Map<string, AllocEntry[]>();
    for (const row of entryRows) {
      const list = entries.get(row.employeeId) ?? [];
      list.push({ id: row.id, date: formatDay(row.date), minutes: row.minutes, clientId: row.clientId, order: row.createdAt.getTime() });
      entries.set(row.employeeId, list);
    }
    const lines = new Map<string, RecLine[]>();
    for (const row of [...counted.rows].sort((a, b) => (orderKey(a) < orderKey(b) ? -1 : 1))) {
      if (!row.employeeId || !row.fromDate || !row.toDate) continue;
      const list = lines.get(row.employeeId) ?? [];
      list.push(toRecLine(row));
      lines.set(row.employeeId, list);
    }
    const statementLines = new Map<string, RecStatementLine[]>();
    for (const statement of statements) {
      const list = statementLines.get(statement.employeeId) ?? [];
      for (const line of statement.lines as unknown as Array<{ type: 'work' | 'surcharge'; date: string; minutes: number; amountCents: number }>) {
        list.push({ type: line.type, date: line.date, minutes: line.minutes, amountCents: line.amountCents });
      }
      statementLines.set(statement.employeeId, list);
    }
    return { entries, lines, statementLines };
  }

  /* ── Hours, pay and invoices of workers ───────────────────────────────────────────────────────────────────────── */

  /** Hours, pay and invoices of these workers over `from → to`, side by side. */
  async forWorkers(employeeIds: string[], from: string, to: string): Promise<Map<string, Reconciliation>> {
    const result = new Map<string, Reconciliation>();
    const ids = [...new Set(employeeIds)];
    if (!ids.length) return result;
    const [workers, loaded] = await Promise.all([this.prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, data: true } }), this.load(ids, from, to)]);
    const kinds = new Map<string, WorkKind>(workers.map(worker => [worker.id, workKindOf(worker.data)]));
    for (const id of ids) {
      result.set(id, reconcile({ kind: kinds.get(id) ?? 'own', from, to, entries: loaded.entries.get(id) ?? [], lines: loaded.lines.get(id) ?? [], statementLines: loaded.statementLines.get(id) ?? [] }));
    }
    return result;
  }

  /**
   * For each hours line of an invoice (also a draft, which counts as the last one made): how much of it the registered hours back, and what is registered
   * for the worker in that period.
   */
  async lineCoverage(invoiceId: string): Promise<Map<string, LineCoverageView>> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { lines: true },
    });
    const result = new Map<string, LineCoverageView>();
    if (!invoice || invoice.kind === 'credit' || invoice.status === 'cancelled') return result;
    const mine = invoice.lines.filter(line => line.kind === 'hours' && line.employeeId && line.fromDate && line.toDate);
    const ids = [...new Set(mine.map(line => line.employeeId as string))];
    if (!ids.length) return result;

    const from = mine.reduce((min, line) => (formatDay(line.fromDate as Date) < min ? formatDay(line.fromDate as Date) : min), formatDay(mine[0]!.fromDate as Date));
    const to = mine.reduce((max, line) => (formatDay(line.toDate as Date) > max ? formatDay(line.toDate as Date) : max), formatDay(mine[0]!.toDate as Date));
    const others = await this.countedLines(ids, from, to, invoice.id);
    const entryRows = await this.prisma.hourEntry.findMany({
      where: { employeeId: { in: ids }, date: { gte: parseDay(others.from), lte: parseDay(others.to) } },
      select: { id: true, employeeId: true, date: true, minutes: true, clientId: true, createdAt: true },
    });
    const draftDate = invoice.invoiceDate ? formatDay(invoice.invoiceDate) : '9999-12-31';
    const own = { id: invoice.id, direction: invoice.direction, clientId: invoice.clientId, invoiceDate: invoice.invoiceDate, createdAt: invoice.createdAt };
    const ownRows: LineRow[] = mine.map(line => ({ ...line, invoice: own }));
    // Where does this invoice stand among the others? A counted invoice has its place; a draft is made last.
    const countedOwn = ['sent', 'paid', 'received', 'checked'].includes(invoice.status);

    for (const id of ids) {
      const rows = [...others.rows.filter(row => row.employeeId === id).map(row => ({ row, key: orderKey(row) })), ...ownRows.filter(row => row.employeeId === id).map(row => ({ row, key: orderKey(row, countedOwn ? undefined : draftDate) }))]
        .sort((a, b) => (a.key < b.key ? -1 : 1))
        .map(item => item.row);
      const entries: AllocEntry[] = entryRows.filter(row => row.employeeId === id).map(row => ({ id: row.id, date: formatDay(row.date), minutes: row.minutes, clientId: row.clientId, order: row.createdAt.getTime() }));
      const lines: AllocLine[] = rows.map(row => ({ id: row.id, direction: row.invoice.direction as Direction, clientId: row.invoice.clientId, from: formatDay(row.fromDate as Date), to: formatDay(row.toDate as Date), minutes: row.minutes }));
      const allocation = allocate(entries, lines);
      for (const line of ownRows.filter(row => row.employeeId === id)) {
        const coverage = allocation.lines.get(line.id);
        if (!coverage) continue;
        const from = formatDay(line.fromDate as Date);
        const to = formatDay(line.toDate as Date);
        const inPeriod = entries.filter(entry => entry.date >= from && entry.date <= to && (invoice.direction === 'incoming' || entry.clientId === invoice.clientId));
        result.set(line.id, {
          billed: coverage.billed,
          covered: coverage.covered,
          unbacked: coverage.unbacked,
          registered: inPeriod.reduce((sum, entry) => sum + entry.minutes, 0),
          uninvoiced: inPeriod.reduce((sum, entry) => sum + (allocation.free[invoice.direction as Direction].get(entry.id) ?? 0), 0),
        });
      }
    }
    return result;
  }

  /**
   * What the registered hours behind each counted line of these workers are paid (hours × the rate of each day), for the markup report. `payCents` is
   * `null` when a day behind the line has no rate. Lines are worked out together with every line they share hours with.
   */
  async linePay(employeeIds: string[], from: string, to: string): Promise<Map<string, { covered: number; unbacked: number; payCents: number | null }>> {
    const result = new Map<string, { covered: number; unbacked: number; payCents: number | null }>();
    const ids = [...new Set(employeeIds)];
    if (!ids.length) return result;
    const counted = await this.countedLines(ids, from, to);
    const entryRows = await this.prisma.hourEntry.findMany({
      where: { employeeId: { in: ids }, date: { gte: parseDay(counted.from), lte: parseDay(counted.to) } },
      select: { id: true, employeeId: true, date: true, minutes: true, clientId: true, createdAt: true, rate: true },
    });
    for (const id of ids) {
      const mine = entryRows.filter(row => row.employeeId === id);
      const rateOf = new Map(mine.map(row => [row.id, row.rate === null ? null : toCents(row.rate.toNumber())]));
      const lines = counted.rows.filter(row => row.employeeId === id && row.fromDate && row.toDate).sort((a, b) => (orderKey(a) < orderKey(b) ? -1 : 1));
      const allocation = allocate(
        mine.map(row => ({ id: row.id, date: formatDay(row.date), minutes: row.minutes, clientId: row.clientId, order: row.createdAt.getTime() })),
        lines.map(row => toRecLine(row)),
      );
      for (const line of lines) {
        const coverage = allocation.lines.get(line.id);
        if (!coverage) continue;
        let weighted = 0;
        let known = true;
        for (const part of coverage.parts) {
          const rate = rateOf.get(part.entryId) ?? null;
          if (rate === null) known = false;
          else weighted += part.minutes * rate;
        }
        result.set(line.id, { covered: coverage.covered, unbacked: coverage.unbacked, payCents: known ? roundDiv(weighted, 60) : null });
      }
    }
    return result;
  }

  /* ── The report ───────────────────────────────────────────────────────────────────────────────────────────────── */

  period(query: { month?: string; from?: string; to?: string }): { from: string; to: string } {
    if (query.month !== undefined) {
      if (!isMonth(query.month)) throw validationFailed({ month: 'validation.invalid' });
      return { from: firstOfMonth(query.month), to: lastOfMonth(query.month) };
    }
    if (!isValidDay(query.from) || !isValidDay(query.to)) throw validationFailed({ month: 'validation.required' });
    if (query.to < query.from) throw validationFailed({ to: 'validation.endBeforeStart' });
    return { from: query.from, to: query.to };
  }

  /** The reconciliation of every worker who has hours, a statement or an invoice line in the period. `money` — whether the person may see what is paid. */
  async report(query: ReconciliationQuery, money: boolean): Promise<ApiResult> {
    const { from, to } = this.period(query);
    const range = { gte: parseDay(from), lte: parseDay(to) };
    const clientScope = query.clientId ? { employee: { clientId: query.clientId } } : {};
    const [entries, lines, statements] = await Promise.all([
      this.prisma.hourEntry.groupBy({ by: ['employeeId'], where: { date: range, ...clientScope } }),
      this.prisma.invoiceLine.groupBy({ by: ['employeeId'], where: { employeeId: { not: null }, kind: 'hours', fromDate: { lte: range.lte }, toDate: { gte: range.gte }, invoice: COUNTED_INVOICE, ...clientScope } }),
      this.prisma.salaryStatement.findMany({ where: { status: 'final', periodFrom: { lte: range.lte }, periodTo: { gte: range.gte }, ...(query.clientId && { clientId: query.clientId }) }, select: { employeeId: true } }),
    ]);
    const candidates = [...new Set([...entries.map(row => row.employeeId), ...lines.map(row => row.employeeId as string), ...statements.map(row => row.employeeId)])];
    const terms = fold(query.search ?? '').split(' ').filter(Boolean);
    const workers = candidates.length
      ? await this.prisma.employee.findMany({
          where: {
            id: { in: candidates },
            ...terms.reduce<Prisma.EmployeeWhereInput>(
              (where, term) => ({ AND: [where, { OR: [{ person: { searchText: { contains: term } } }, { client: { number: { contains: term, mode: 'insensitive' } } }, { client: { name: { contains: term, mode: 'insensitive' } } }] }] }),
              {},
            ),
          },
          include: EMPLOYEE_NAMES,
        })
      : [];
    const figures = await this.forWorkers(workers.map(worker => worker.id), from, to);

    const all = workers
      .map(worker => {
        const result = figures.get(worker.id) as Reconciliation;
        return { worker, result };
      })
      .filter(({ result }) => result.status !== 'empty' && (!query.kind || result.kind === query.kind));
    const counts = { workers: all.length, ok: all.filter(({ result }) => result.status === 'ok').length, differences: all.filter(({ result }) => result.status === 'differences').length };
    const wanted = all.filter(({ result }) => (query.status ?? 'all') === 'all' || result.status === query.status);
    wanted.sort((a, b) => {
      const rank = (status: string) => (status === 'differences' ? 0 : 1);
      return rank(a.result.status) - rank(b.result.status) || a.worker.client.number.localeCompare(b.worker.client.number, 'nl', { numeric: true }) || personName(a.worker.person).localeCompare(personName(b.worker.person), 'nl');
    });
    const page = wanted.slice((query.page - 1) * query.pageSize, query.page * query.pageSize);

    const unmatched = await this.unmatchedLines(from, to, query.clientId);
    return new ApiResult(
      {
        from,
        to,
        rows: page.map(({ worker, result }) => ({
          employeeId: worker.id,
          name: personName(worker.person),
          clientId: worker.client.id,
          clientNumber: worker.client.number,
          clientName: worker.client.name,
          kind: result.kind,
          status: result.status,
          registered: result.registered,
          paid: result.expected.paid ? result.paid : null,
          ...(money && result.expected.paid && { paidAmount: fromCents(result.paidCents) }),
          invoicedOutgoing: result.invoiced.outgoing,
          invoicedIncoming: result.invoiced.incoming,
          expected: result.expected,
          causes: result.causes,
        })),
        unmatched,
      },
      pageMeta(wanted.length, query, { counts }),
    );
  }

  /** Invoice lines of the period that name a worker nobody could be matched to: their hours can not be checked until somebody links them. */
  async unmatchedLines(from: string, to: string, clientId?: string) {
    const rows = await this.prisma.invoiceLine.findMany({
      where: { employeeId: null, kind: 'hours', fromDate: { lte: parseDay(to) }, toDate: { gte: parseDay(from) }, invoice: { ...COUNTED_INVOICE, ...(clientId && { clientId }) } },
      include: { invoice: { select: { id: true, number: true, direction: true, client: { select: { number: true, name: true } }, counterparty: { select: { name: true } }, otherClient: { select: { number: true, name: true } } } } },
      orderBy: [{ fromDate: 'asc' }],
      take: 100,
    });
    return rows.map(row => ({
      lineId: row.id,
      invoiceId: row.invoice.id,
      invoiceNumber: row.invoice.number ?? '',
      direction: row.invoice.direction,
      clientNumber: row.invoice.client.number,
      clientName: row.invoice.client.name,
      party: row.invoice.counterparty?.name ?? (row.invoice.otherClient ? `${row.invoice.otherClient.number} – ${row.invoice.otherClient.name}` : ''),
      rawName: row.rawName,
      from: row.fromDate ? formatDay(row.fromDate) : null,
      to: row.toDate ? formatDay(row.toDate) : null,
      minutes: row.minutes,
    }));
  }

  /** The report as a table for Excel, PDF or Word (what the filters match, not just the page that is on screen). */
  async table(query: ReconciliationQuery, money: boolean, locale: AppLocale): Promise<ExportTable> {
    const result = await this.report({ ...query, page: 1, pageSize: 500 }, money);
    const data = result.data as { from: string; to: string; rows: ReportRow[] };
    const nl = locale === 'nl';
    const hours = (minutes: number | null) => (minutes === null ? '' : minutesToHours(minutes));
    return {
      title: nl ? 'Afstemming uren, loon en facturen' : 'Reconciliation of hours, pay and invoices',
      subtitle: `${data.from} – ${data.to}`,
      locale,
      columns: [
        { key: 'client', header: nl ? 'Klant' : 'Client', width: 24 },
        { key: 'name', header: nl ? 'Werknemer' : 'Employee', width: 26 },
        { key: 'kind', header: nl ? 'Soort inzet' : 'How used', width: 18 },
        { key: 'registered', header: nl ? 'Geregistreerd (uren)' : 'Registered (h)', type: 'number', width: 14 },
        { key: 'paid', header: nl ? 'Uitbetaald (uren)' : 'Paid (h)', type: 'number', width: 14 },
        ...(money ? [{ key: 'paidAmount', header: nl ? 'Uitbetaald (bruto)' : 'Paid (gross)', type: 'money' as const, width: 14 }] : []),
        { key: 'outgoing', header: nl ? 'Uitgaand gefactureerd (uren)' : 'Invoiced out (h)', type: 'number', width: 16 },
        { key: 'incoming', header: nl ? 'Inkomend gefactureerd (uren)' : 'Invoiced in (h)', type: 'number', width: 16 },
        { key: 'status', header: nl ? 'Uitkomst' : 'Outcome', width: 14 },
        { key: 'causes', header: nl ? 'Wat er niet klopt' : 'What does not match', width: 56 },
      ],
      rows: data.rows.map(row => ({
        client: `${row.clientNumber} – ${row.clientName}`,
        name: row.name,
        kind: KIND_TEXT[row.kind][nl ? 'nl' : 'en'],
        registered: hours(row.registered),
        paid: hours(row.paid),
        paidAmount: row.paidAmount ?? '',
        outgoing: hours(row.invoicedOutgoing),
        incoming: hours(row.invoicedIncoming),
        status: row.status === 'ok' ? (nl ? 'Klopt' : 'Matches') : nl ? 'Verschillen' : 'Differences',
        causes: row.causes.map(cause => causeText(cause, nl)).join('; '),
      })),
    };
  }
}

const KIND_TEXT: Record<WorkKind, { nl: string; en: string }> = {
  own: { nl: 'In dienst van de klant', en: 'Employed by the client' },
  hired_out: { nl: 'Uitgeleend', en: 'Hired out' },
  hired_in: { nl: 'Ingeleend', en: 'Hired in' },
};

/** A cause in words, for exports (the screens word it from the same codes). */
export function causeText(cause: Cause, nl: boolean): string {
  const hours = cause.minutes === undefined ? '' : String(minutesToHours(cause.minutes)).replace('.', nl ? ',' : '.');
  switch (cause.code) {
    case 'not_paid':
      return nl ? `${hours} uur niet uitbetaald` : `${hours} h not paid`;
    case 'paid_more':
      return nl ? `${hours} uur meer uitbetaald dan geregistreerd` : `${hours} h paid beyond what is registered`;
    case 'not_invoiced':
      return cause.direction === 'incoming' ? (nl ? `${hours} uur nog niet op een inkomende factuur` : `${hours} h not yet on an incoming invoice`) : nl ? `${hours} uur nog niet uitgefactureerd` : `${hours} h not yet invoiced out`;
    case 'over_invoiced':
      return nl ? `${hours} uur gefactureerd zonder geregistreerde uren` : `${hours} h invoiced without registered hours`;
    case 'line_math':
      return nl ? `${cause.count} factuurregel(s) kloppen niet (uren × tarief)` : `${cause.count} invoice line(s) do not add up (hours × rate)`;
    default:
      return cause.code;
  }
}

export interface ReportRow {
  employeeId: string;
  name: string;
  clientNumber: string;
  clientName: string;
  kind: WorkKind;
  status: string;
  registered: number;
  paid: number | null;
  paidAmount?: number;
  invoicedOutgoing: number;
  invoicedIncoming: number;
  causes: Cause[];
}
