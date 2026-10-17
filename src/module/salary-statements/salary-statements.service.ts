import { ConflictException, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { ApiResult, paged } from '../../common/api-result.js';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import { formatDay, isValidDay, parseDay } from '../../common/dates.js';
import { pageMeta, toSkipTake } from '../../common/pagination.js';
import { fold } from '../../common/text.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { validationFailed } from '../../common/validation/failure.js';
import { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import type { ExportTable } from '../../lib/exports/export.types.js';
import { SettingsService } from '../../lib/settings/settings.service.js';
import { FilesService } from '../files/files.service.js';
import { HoursPayService, viewLines, viewTotals, type PayWarning } from '../hours/hours-pay.service.js';
import { firstOfMonth, isMonth, lastOfMonth, minutesToHours } from '../hours/hours-time.js';
import { PeriodLocksService } from '../hours/period-locks.service.js';
import type { PayLine } from '../hours/pay-calculator.js';
import { workKindOf } from '../employees/employee-record.js';
import { personName } from '../people/person-record.js';
import { euro, shortDay } from '../templates/merge-format.js';
import type { CandidatesQuery, CancelStatementDto, CreateStatementDto, StatementExportQuery, StatementListQuery, StatementPreviewQuery } from './dto/statement.dto.js';
import { StatementDocumentsService, periodLabel, statementInput, type StatementRow } from './statement-documents.service.js';

const WITH_PARTIES = { employee: { include: { person: true } }, client: true } as const;

/**
 * Salary statements: what a worker was paid for a period, frozen when it is made. A statement is the result of the hours of the period (hours × the
 * rate of each day + the surcharge rules that are on), kept as lines with their amounts; it closes the days it covers, files a Word and a PDF in
 * the worker's folder, and is never edited — it is cancelled (which opens the days again) and made again.
 */
@Injectable()
export class SalaryStatementsService {
  private readonly logger = new Logger(SalaryStatementsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly pay: HoursPayService,
    private readonly locks: PeriodLocksService,
    private readonly documents: StatementDocumentsService,
    private readonly files: FilesService,
  ) {}

  /* ── Before making one ────────────────────────────────────────────────────────────────────────────────────── */

  /** What the statement would say, with what the system noticed. Nothing is saved. */
  async preview(query: StatementPreviewQuery) {
    return this.pay.view(await this.pay.preview(query.employeeId, query.from, query.to));
  }

  /** The workers of a client who have hours in the period, and whether a statement can be made for each: ready, already made, or missing a rate. */
  async candidates(query: CandidatesQuery) {
    this.pay.assertPeriod(query.from, query.to);
    const range = { gte: parseDay(query.from), lte: parseDay(query.to) };
    const [entries, withoutRate, workers] = await Promise.all([
      this.prisma.hourEntry.groupBy({ by: ['employeeId'], where: { employee: { clientId: query.clientId }, date: range }, _sum: { minutes: true }, _count: { _all: true } }),
      this.prisma.hourEntry.groupBy({ by: ['employeeId'], where: { employee: { clientId: query.clientId }, date: range, rate: null }, _count: { _all: true } }),
      this.prisma.employee.findMany({ where: { clientId: query.clientId, hourEntries: { some: { date: range } } }, include: { person: true }, orderBy: [{ person: { lastName: 'asc' } }, { person: { firstName: 'asc' } }] }),
    ]);
    const ids = workers.map(worker => worker.id);
    const covered = ids.length
      ? await this.prisma.salaryStatement.findMany({ where: { employeeId: { in: ids }, status: 'final', periodFrom: { lte: range.lte }, periodTo: { gte: range.gte } }, select: { id: true, employeeId: true } })
      : [];
    const minutes = new Map(entries.map(row => [row.employeeId, { minutes: row._sum.minutes ?? 0, entries: row._count._all }]));
    const missing = new Set(withoutRate.map(row => row.employeeId));
    const done = new Map(covered.map(row => [row.employeeId, row.id]));
    return workers.map(worker => ({
      employeeId: worker.id,
      name: personName(worker.person),
      minutes: minutes.get(worker.id)?.minutes ?? 0,
      entries: minutes.get(worker.id)?.entries ?? 0,
      status: workKindOf(worker.data) === 'hired_in' ? 'hired_in' : done.has(worker.id) ? 'covered' : missing.has(worker.id) ? 'rate_missing' : 'ready',
      statementId: done.get(worker.id) ?? null,
    }));
  }

  /* ── Making and cancelling ────────────────────────────────────────────────────────────────────────────────── */

  async create(dto: CreateStatementDto, user: AuthenticatedUser) {
    const preview = await this.pay.preview(dto.employeeId, dto.from, dto.to);
    if (preview.blockers.length) {
      throw new UnprocessableEntityException({ code: 'statement_blocked', message: 'A salary statement cannot be made for this period yet.', details: { blockers: preview.blockers } });
    }
    const { result } = preview;
    const locale = this.settings.get<string>('locale.documentLocale') === 'en' ? 'en' : 'nl';
    const cents = (value: number) => new Prisma.Decimal(value).div(100);

    const created = await this.prisma.$transaction(async tx => {
      // The period must still be free: another statement may have been made while this one was being looked at.
      const taken = await tx.salaryStatement.findFirst({ where: { employeeId: dto.employeeId, status: 'final', periodFrom: { lte: parseDay(dto.to) }, periodTo: { gte: parseDay(dto.from) } }, select: { id: true } });
      if (taken) throw new ConflictException({ code: 'statement_overlap', message: 'There is already a salary statement for this period.' });
      const row = await tx.salaryStatement.create({
        data: {
          employeeId: dto.employeeId,
          clientId: preview.employee.clientId,
          periodFrom: parseDay(dto.from),
          periodTo: parseDay(dto.to),
          totalMinutes: result.totals.minutes,
          daysCount: result.totals.days,
          baseAmount: cents(result.totals.baseCents),
          surchargeAmount: cents(result.totals.surchargeCents),
          grossAmount: cents(result.totals.grossCents),
          allowancePercent: new Prisma.Decimal(result.totals.allowancePercent),
          allowanceAmount: cents(result.totals.allowanceCents),
          totalAmount: cents(result.totals.totalCents),
          vacationMinutes: result.totals.vacationMinutes,
          lines: result.lines as unknown as Prisma.InputJsonValue,
          warnings: preview.warnings as unknown as Prisma.InputJsonValue,
          locale,
          note: dto.note?.trim() ?? '',
          createdById: user.id,
        },
      });
      await this.locks.lockForStatement(tx, { id: row.id, employeeId: dto.employeeId, from: dto.from, to: dto.to }, user.id);
      return row;
    });

    const row = await this.load(created.id);
    // The documents come after the statement is saved: LibreOffice takes a few seconds, and the statement is the thing that counts.
    let made: { word: boolean; pdf: boolean } = { word: false, pdf: false };
    try {
      made = await this.documents.make(row, this.tableOf(row, locale), user);
    } catch (error) {
      // The statement stands; the documents can be made again from its page.
      this.logger.warn(`The documents of statement ${row.id} could not be made: ${(error as Error).message}`);
    }
    await this.audit.log({
      action: 'created',
      entityType: 'salary_statement',
      entityId: row.id,
      entityLabel: this.label(row),
      after: { period: `${dto.from} – ${dto.to}`, minutes: result.totals.minutes, days: result.totals.days, gross: result.totals.grossCents / 100, total: result.totals.totalCents / 100 },
      meta: { word: made.word, pdf: made.pdf, ...(preview.warnings.length && { warnings: preview.warnings.map(warning => warning.code) }) },
    });
    return this.get(row.id);
  }

  /** Makes the Word and PDF again (the template changed, or LibreOffice was not there the first time). */
  async makeDocuments(id: string, user: AuthenticatedUser) {
    const row = await this.load(id);
    if (row.status !== 'final') throw new ConflictException({ code: 'statement_cancelled', message: 'This salary statement was cancelled.' });
    const locale = row.locale === 'en' ? 'en' : 'nl';
    const made = await this.documents.make(row, this.tableOf(row, locale), user);
    await this.audit.log({ action: 'generated', entityType: 'salary_statement', entityId: id, entityLabel: this.label(row), meta: { pdf: made.pdf, template: made.template?.name ?? null } });
    return this.get(id);
  }

  /** Cancels a statement: its days are open again and a new one can be made. The documents stay on file (switched off), the lines stay in the record. */
  async cancel(id: string, dto: CancelStatementDto, user: AuthenticatedUser) {
    const row = await this.load(id);
    if (row.status !== 'final') throw new ConflictException({ code: 'statement_cancelled', message: 'This salary statement was already cancelled.' });
    if (!dto.reason?.trim()) throw validationFailed({ reason: 'validation.required' });
    await this.prisma.$transaction(async tx => {
      await tx.periodLock.deleteMany({ where: { statementId: id } });
      await tx.salaryStatement.update({ where: { id }, data: { status: 'cancelled', cancelledAt: new Date(), cancelledById: user.id, cancelReason: dto.reason.trim() } });
    });
    await this.files.retire(row.fileId);
    await this.files.retire(row.pdfFileId);
    await this.audit.log({ action: 'cancelled', entityType: 'salary_statement', entityId: id, entityLabel: this.label(row), before: { status: 'final' }, after: { status: 'cancelled' }, meta: { reason: dto.reason.trim() } });
    return this.get(id);
  }

  /* ── Reading ──────────────────────────────────────────────────────────────────────────────────────────────── */

  async list(query: StatementListQuery): Promise<ApiResult> {
    const where = this.where(query);
    const statsWhere = this.where({ ...query, status: 'final' });
    const [total, rows, stats] = await Promise.all([
      this.prisma.salaryStatement.count({ where }),
      this.prisma.salaryStatement.findMany({ where, include: WITH_PARTIES, orderBy: [{ periodFrom: 'desc' }, { createdAt: 'desc' }], ...toSkipTake(query) }),
      query.stats ? this.prisma.salaryStatement.aggregate({ where: statsWhere, _count: { _all: true }, _sum: { totalMinutes: true, grossAmount: true, totalAmount: true } }) : null,
    ]);
    return paged(
      rows.map(row => this.summary(row)),
      pageMeta(total, query, stats ? { stats: { count: stats._count._all, minutes: stats._sum.totalMinutes ?? 0, gross: stats._sum.grossAmount?.toNumber() ?? 0, total: stats._sum.totalAmount?.toNumber() ?? 0 } } : {}),
    );
  }

  async get(id: string) {
    const row = await this.load(id);
    const ids = [row.fileId, row.pdfFileId, row.createdById, row.cancelledById].filter((value): value is string => Boolean(value));
    const [files, users, template] = await Promise.all([
      this.prisma.storedFile.findMany({ where: { id: { in: ids } } }),
      this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
      row.templateId ? this.prisma.template.findUnique({ where: { id: row.templateId }, select: { id: true, name: true } }) : null,
    ]);
    const byId = new Map(files.map(file => [file.id, file]));
    const names = new Map(users.map(user => [user.id, user.name]));
    const lines = row.lines as unknown as PayLine[];
    return {
      ...this.summary(row),
      locale: row.locale,
      note: row.note,
      employee: { id: row.employeeId, name: personName(row.employee.person), isActive: row.employee.isActive },
      client: { id: row.clientId, number: row.client.number, name: row.client.name },
      lines: viewLines(lines),
      totals: viewTotals(statementInput(row).totals),
      warnings: row.warnings as unknown as PayWarning[],
      template: template && row.templateVersion ? { ...template, version: row.templateVersion } : null,
      files: { word: this.documents.brief(byId.get(row.fileId ?? '')), pdf: this.documents.brief(byId.get(row.pdfFileId ?? '')) },
      createdBy: row.createdById ? (names.get(row.createdById) ?? null) : null,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      cancelledBy: row.cancelledById ? (names.get(row.cancelledById) ?? null) : null,
      cancelReason: row.cancelReason,
    };
  }

  /* ── Export ───────────────────────────────────────────────────────────────────────────────────────────────── */

  /** The list as a table (Excel, PDF, Word). */
  async listTable(query: StatementExportQuery, locale: AppLocale): Promise<ExportTable> {
    const rows = await this.prisma.salaryStatement.findMany({ where: this.where(query), include: WITH_PARTIES, orderBy: [{ periodFrom: 'desc' }, { createdAt: 'desc' }] });
    const nl = locale === 'nl';
    return {
      title: nl ? 'Loonstaten' : 'Salary statements',
      subtitle: query.month ?? undefined,
      locale,
      columns: [
        { key: 'client', header: nl ? 'Klant' : 'Client', width: 28 },
        { key: 'worker', header: nl ? 'Werknemer' : 'Employee', width: 24 },
        { key: 'from', header: nl ? 'Van' : 'From', type: 'date', width: 12 },
        { key: 'to', header: nl ? 'Tot en met' : 'Up to and including', type: 'date', width: 12 },
        { key: 'hours', header: nl ? 'Uren' : 'Hours', type: 'number', width: 8 },
        { key: 'gross', header: nl ? 'Brutoloon' : 'Gross wages', type: 'money', width: 13 },
        { key: 'allowance', header: nl ? 'Vakantietoeslag' : 'Holiday allowance', type: 'money', width: 13 },
        { key: 'total', header: nl ? 'Totaal' : 'Total', type: 'money', width: 13 },
        { key: 'status', header: 'Status', width: 12 },
      ],
      rows: rows.map(row => ({
        client: `${row.client.number} – ${row.client.name}`,
        worker: personName(row.employee.person),
        from: formatDay(row.periodFrom),
        to: formatDay(row.periodTo),
        hours: minutesToHours(row.totalMinutes),
        gross: row.grossAmount.toNumber(),
        allowance: row.allowanceAmount.toNumber(),
        total: row.totalAmount.toNumber(),
        status: row.status === 'final' ? (nl ? 'Definitief' : 'Final') : nl ? 'Geannuleerd' : 'Cancelled',
      })),
    };
  }

  /** One statement as a table: the lines, then the totals. */
  async tableFor(id: string, locale: AppLocale): Promise<ExportTable> {
    return this.tableOf(await this.load(id), locale);
  }

  tableOf(row: StatementRow, locale: AppLocale): ExportTable {
    const nl = locale === 'nl';
    const lines = row.lines as unknown as PayLine[];
    const totals = statementInput(row).totals;
    const money = (value: number) => value / 100;
    const description = (line: PayLine) => {
      if (line.type === 'work') return line.where || (nl ? 'Gewerkt' : 'Worked');
      const extra = line.percentBp ? `+${line.percentBp / 100}%` : line.perHourCents ? `+${euro(line.perHourCents / 100, locale)}/${nl ? 'uur' : 'hour'}` : '';
      return [line.label, extra].filter(Boolean).join(' ');
    };
    const total = (label: string, cents: number) => ({ date: null, description: label, hours: null, rate: '', amount: money(cents) });
    const rows: Array<Record<string, unknown>> = lines.map(line => ({
      date: line.date,
      description: description(line),
      hours: minutesToHours(line.minutes),
      rate: line.type === 'work' && line.rateCents !== null ? euro(line.rateCents / 100, locale) : '',
      amount: money(line.amountCents),
    }));
    rows.push({ date: null, description: nl ? 'Totaal uren' : 'Total hours', hours: minutesToHours(totals.minutes), rate: '', amount: null });
    rows.push(total(nl ? 'Loon over de uren' : 'Wages for the hours', totals.baseCents));
    if (totals.surchargeCents) rows.push(total(nl ? 'Toeslagen' : 'Surcharges', totals.surchargeCents));
    rows.push(total(nl ? 'Brutoloon' : 'Gross wages', totals.grossCents));
    if (totals.allowancePercent > 0) {
      rows.push(total(`${nl ? 'Vakantietoeslag' : 'Holiday allowance'} ${totals.allowancePercent}%`, totals.allowanceCents));
      rows.push(total(nl ? 'Totaal bruto inclusief vakantietoeslag' : 'Total gross including holiday allowance', totals.totalCents));
    }
    return {
      title: nl ? 'Loonstaat' : 'Salary statement',
      subtitle: `${personName(row.employee.person)} · ${row.client.number} – ${row.client.name} · ${shortDay(formatDay(row.periodFrom))} – ${shortDay(formatDay(row.periodTo))}`,
      locale,
      columns: [
        { key: 'date', header: nl ? 'Datum' : 'Date', type: 'date', width: 12 },
        { key: 'description', header: nl ? 'Omschrijving' : 'Description', width: 40 },
        { key: 'hours', header: nl ? 'Uren' : 'Hours', type: 'number', width: 9 },
        { key: 'rate', header: nl ? 'Uurloon' : 'Hourly rate', width: 12 },
        { key: 'amount', header: nl ? 'Bedrag' : 'Amount', type: 'money', width: 14 },
      ],
      rows,
    };
  }

  /* ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────── */

  private where(query: StatementListQuery): Prisma.SalaryStatementWhereInput {
    const status = query.status ?? 'final';
    const terms = fold(query.search ?? '').split(' ').filter(Boolean);
    const from = query.month && isMonth(query.month) ? firstOfMonth(query.month) : query.from && isValidDay(query.from) ? query.from : null;
    const to = query.month && isMonth(query.month) ? lastOfMonth(query.month) : query.to && isValidDay(query.to) ? query.to : null;
    return {
      ...(status !== 'all' && { status }),
      ...(query.employeeId && { employeeId: query.employeeId }),
      ...(query.clientId && { clientId: query.clientId }),
      ...(from && { periodTo: { gte: parseDay(from) } }),
      ...(to && { periodFrom: { lte: parseDay(to) } }),
      ...(terms.length && {
        AND: terms.map(term => ({
          OR: [{ employee: { person: { searchText: { contains: term } } } }, { client: { number: { contains: term, mode: 'insensitive' as const } } }, { client: { name: { contains: term, mode: 'insensitive' as const } } }],
        })),
      }),
    };
  }

  private summary(row: StatementRow) {
    return {
      id: row.id,
      status: row.status,
      employeeId: row.employeeId,
      employee: personName(row.employee.person),
      clientId: row.clientId,
      clientNumber: row.client.number,
      clientName: row.client.name,
      from: formatDay(row.periodFrom),
      to: formatDay(row.periodTo),
      period: periodLabel(formatDay(row.periodFrom), formatDay(row.periodTo)),
      minutes: row.totalMinutes,
      days: row.daysCount,
      gross: row.grossAmount.toNumber(),
      allowance: row.allowanceAmount.toNumber(),
      total: row.totalAmount.toNumber(),
      hasWord: Boolean(row.fileId),
      hasPdf: Boolean(row.pdfFileId),
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async load(id: string): Promise<StatementRow> {
    const row = await this.prisma.salaryStatement.findUnique({ where: { id }, include: WITH_PARTIES });
    if (!row) throw new NotFoundException({ code: 'not_found', message: 'Salary statement not found' });
    return row;
  }

  private label(row: StatementRow): string {
    return `${personName(row.employee.person)} (${row.client.number}) ${periodLabel(formatDay(row.periodFrom), formatDay(row.periodTo))}`;
  }
}
