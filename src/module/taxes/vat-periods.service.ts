import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ApiResult, paged } from '../../common/api-result.js';
import { daysBetween, formatDay, parseDay, todayInAmsterdam } from '../../common/dates.js';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import { pageMeta, toSkipTake } from '../../common/pagination.js';
import { fold } from '../../common/text.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { validationFailed } from '../../common/validation/failure.js';
import { Prisma, type VatStep } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import type { ExportTable } from '../../lib/exports/export.types.js';
import { ExportsService } from '../../lib/exports/exports.service.js';
import type { ActiveDto, VatBulkDto, VatExportQuery, VatListQuery, VatOverviewQuery, VatPeriodUpdateDto } from './dto/taxes.dto.js';
import { TaxDeadlinesService } from './tax-deadlines.service.js';
import { nextPeriod, parsePeriodKey, periodContaining, periodKey, periodLabel, previousPeriod, rangeOf, type PeriodRange } from './tax-periods.js';
import { VAT_KINDS, VAT_PERIOD_ENTITY, type VatKind } from './taxes.constants.js';
import { VatStepsService } from './vat-steps.service.js';
import { filedOf, readTicks } from './vat-ticks.js';

const VAT_INCLUDE = { client: { select: { id: true, number: true, name: true, isActive: true, responsibleUserId: true } } } satisfies Prisma.VatPeriodInclude;
type VatRow = Prisma.VatPeriodGetPayload<{ include: typeof VAT_INCLUDE }>;

const SORTS: Record<string, (direction: 'asc' | 'desc') => Prisma.VatPeriodOrderByWithRelationInput> = {
  number: direction => ({ client: { number: direction } }),
  client: direction => ({ client: { name: direction } }),
  periodStart: direction => ({ periodStart: direction }),
  completedAt: direction => ({ completedAt: { sort: direction, nulls: 'last' } }),
};

const day = (value: Date | null): string | null => (value ? formatDay(value) : null);

const split = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);

/**
 * The VAT tracker: for every client with a VAT duty one row per period (a quarter by default) with the steps of the office's own sheet — invoices received and booked, bank
 * received and booked, return prepared and filed. The rows of the quarter that is being filed and of the one that is running are made by the system; ticking is one click.
 * The deadline of a row is worked out from the period and the Dutch calendar, never typed in.
 */
@Injectable()
export class VatPeriodsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly steps: VatStepsService,
    private readonly deadlines: TaxDeadlinesService,
    private readonly exports: ExportsService,
  ) {}

  /* ── Reading ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  async rowOrThrow(id: string): Promise<VatRow> {
    const row = await this.prisma.vatPeriod.findUnique({ where: { id }, include: VAT_INCLUDE });
    if (!row) throw new NotFoundException({ code: 'not_found', message: 'VAT row not found' });
    return row;
  }

  /** "042 Bakkerij – Q3 2026": the label the audit log uses. */
  label(row: Pick<VatRow, 'client' | 'kind' | 'periodStart'>): string {
    return `${row.client.number} ${row.client.name} – ${periodLabel(rangeOf(row.kind, formatDay(row.periodStart)), 'nl')}`;
  }

  private async userNames(ids: Iterable<string | null | undefined>): Promise<Map<string, string>> {
    const wanted = [...new Set([...ids].filter((id): id is string => Boolean(id)))];
    if (!wanted.length) return new Map();
    return new Map((await this.prisma.user.findMany({ where: { id: { in: wanted } }, select: { id: true, name: true } })).map(user => [user.id, user.name]));
  }

  /** The rows as the grid shows them: what is ticked (with who and when), how far each is, the deadline and whether it is past. */
  async views(rows: readonly VatRow[], steps: readonly VatStep[], today: string) {
    if (!rows.length) return [];
    const parsed = rows.map(row => readTicks(row.ticks));
    const users = await this.userNames([...rows.map(row => row.client.responsibleUserId), ...parsed.flatMap(ticks => Object.values(ticks).map(tick => tick.by))]);
    const codes = steps.map(step => step.code);
    const filing = steps.filter(step => step.isFiling).map(step => step.code);
    return rows.map((row, index) => {
      const ticks = parsed[index]!;
      const start = formatDay(row.periodStart);
      const end = formatDay(row.periodEnd);
      const range = rangeOf(row.kind, start);
      const done = row.completedAt !== null;
      const { filed, at } = filedOf(ticks, filing, done);
      const dueOn = this.deadlines.vatDue(range.kind, end, row.clientId);
      const ticked = codes.filter(code => ticks[code]).length;
      return {
        id: row.id,
        client: { id: row.client.id, number: row.client.number, name: row.client.name, isActive: row.client.isActive },
        responsible: row.client.responsibleUserId ? { id: row.client.responsibleUserId, name: users.get(row.client.responsibleUserId) ?? '' } : null,
        kind: range.kind,
        period: periodKey(range),
        periodStart: start,
        periodEnd: end,
        dueOn,
        overdue: row.isActive && !filed && dueOn < today,
        daysLeft: daysBetween(today, dueOn),
        ticks: Object.fromEntries(codes.filter(code => ticks[code]).map(code => [code, { at: ticks[code]!.at, by: ticks[code]!.by ? (users.get(ticks[code]!.by!) ?? null) : null }])),
        ticked,
        totalSteps: codes.length,
        done,
        completedOn: day(row.completedAt),
        filed,
        filedOn: at ? at.slice(0, 10) : null,
        note: row.note,
        isActive: row.isActive,
        deactivationReason: row.deactivationReason,
      };
    });
  }

  private where(query: Partial<VatListQuery>, range: PeriodRange | null): Prisma.VatPeriodWhereInput {
    const terms = fold(query.search ?? '').split(' ').filter(Boolean).slice(0, 6);
    const state = query.state ?? 'active';
    const and: Prisma.VatPeriodWhereInput[] = terms.map(term => ({ OR: [{ client: { searchText: { contains: term } } }, { client: { number: { contains: term, mode: 'insensitive' } } }] }));
    if (query.responsibleUserId) and.push({ client: query.responsibleUserId === 'none' ? { responsibleUserId: null } : { responsibleUserId: query.responsibleUserId } });
    return {
      ...(range ? { kind: range.kind, periodStart: parseDay(range.start) } : query.kind ? { kind: query.kind } : {}),
      ...(query.clientId && { clientId: query.clientId }),
      ...(state !== 'all' && { isActive: state === 'active' }),
      ...(query.open && { completedAt: null }),
      AND: and,
    };
  }

  private orderBy(sort: string | undefined, range: PeriodRange | null): Prisma.VatPeriodOrderByWithRelationInput[] {
    const order = split(sort)
      .map(part => part.split(':') as [string, string?])
      .filter(([key]) => key in SORTS)
      .map(([key, direction]) => SORTS[key]!(direction === 'desc' ? 'desc' : 'asc'));
    // A period lists the clients by number; the history of one client lists the newest period first.
    const fallback: Prisma.VatPeriodOrderByWithRelationInput[] = range ? [{ client: { number: 'asc' } }] : [{ periodStart: 'desc' }, { client: { number: 'asc' } }];
    return order.length ? order : fallback;
  }

  private parseRange(period: string | undefined): PeriodRange | null {
    if (!period) return null;
    const range = parsePeriodKey(period);
    if (!range) throw validationFailed({ period: 'validation.invalid' });
    return range;
  }

  /** The periods the system makes the rows of by itself: the one that is being filed (the previous one) and the one that is running. */
  private inWindow(range: PeriodRange, today: string): boolean {
    const current = periodContaining(range.kind, today);
    return range.start === current.start || range.start === previousPeriod(current).start;
  }

  async list(query: VatListQuery, locale: AppLocale): Promise<ApiResult> {
    const today = todayInAmsterdam();
    const range = this.parseRange(query.period);
    if (range && this.deadlines.setting<boolean>('createVatAutomatically') && this.inWindow(range, today)) await this.ensure(range, 'automatic');
    const where = this.where(query, range);
    const [total, rows, steps] = await Promise.all([
      this.prisma.vatPeriod.count({ where }),
      this.prisma.vatPeriod.findMany({ where, orderBy: this.orderBy(query.sort, range), include: VAT_INCLUDE, ...toSkipTake(query) }),
      this.steps.active(),
    ]);
    const extra: Record<string, unknown> = { steps: steps.map(step => this.steps.view(step, locale)) };
    if (range) extra.period = this.periodView(range, today, locale);
    if (query.stats) extra.stats = await this.stats(query, range, steps, today);
    return paged(await this.views(rows, steps, today), pageMeta(total, query, extra));
  }

  private periodView(range: PeriodRange, today: string, locale: AppLocale) {
    const dueOn = this.deadlines.vatDue(range.kind, range.end);
    return { key: periodKey(range), kind: range.kind, label: periodLabel(range, locale), start: range.start, end: range.end, dueOn, daysLeft: daysBetween(today, dueOn) };
  }

  /** The counters above the grid: how many rows, how many are complete, how many are filed, and how far each step is. */
  private async stats(query: VatListQuery, range: PeriodRange | null, steps: readonly VatStep[], today: string) {
    const rows = await this.prisma.vatPeriod.findMany({ where: this.where({ ...query, open: undefined }, range), select: { ticks: true, completedAt: true, kind: true, periodEnd: true } });
    const filing = steps.filter(step => step.isFiling).map(step => step.code);
    const byStep = Object.fromEntries(steps.map(step => [step.code, 0]));
    let done = 0;
    let filed = 0;
    let overdue = 0;
    for (const row of rows) {
      const ticks = readTicks(row.ticks);
      const complete = row.completedAt !== null;
      if (complete) done += 1;
      const isFiled = filedOf(ticks, filing, complete).filed;
      if (isFiled) filed += 1;
      else if (this.deadlines.vatDue(rangeOf(row.kind, formatDay(row.periodEnd)).kind, formatDay(row.periodEnd)) < today) overdue += 1;
      for (const step of steps) if (ticks[step.code]) byStep[step.code] = (byStep[step.code] ?? 0) + 1;
    }
    return { total: rows.length, done, open: rows.length - done, filed, notFiled: rows.length - filed, overdue, byStep };
  }

  async one(id: string) {
    const [row, steps] = await Promise.all([this.rowOrThrow(id), this.steps.active()]);
    return (await this.views([row], steps, todayInAmsterdam()))[0]!;
  }

  /**
   * The tabs of the tracker: the periods of a year with how many rows each has and how many are complete, the years that exist, which period to open first (the one that is
   * being filed, until it is complete and past its deadline), and how many clients have each VAT frequency.
   */
  async overview(query: VatOverviewQuery, locale: AppLocale) {
    const today = todayInAmsterdam();
    const kind = (VAT_KINDS as readonly string[]).includes(query.kind ?? '') ? (query.kind as VatKind) : 'quarter';
    const current = periodContaining(kind, today);
    // The first visit of a new quarter finds its rows ready.
    await this.ensureWindow(kind, today);
    const [totals, dones, clients] = await Promise.all([
      this.prisma.vatPeriod.groupBy({ by: ['periodStart'], where: { kind, isActive: true }, _count: { _all: true } }),
      this.prisma.vatPeriod.groupBy({ by: ['periodStart'], where: { kind, isActive: true, completedAt: { not: null } }, _count: { _all: true } }),
      this.prisma.$queryRaw<Array<{ frequency: string | null; total: bigint }>>`SELECT NULLIF("data"->>'vat_frequency', '') AS frequency, count(*) AS total FROM "Client" WHERE "isActive" = true GROUP BY 1`,
    ]);
    const total = new Map(totals.map(entry => [formatDay(entry.periodStart), entry._count._all]));
    const done = new Map(dones.map(entry => [formatDay(entry.periodStart), entry._count._all]));
    const years = [...new Set([current.year, current.year - 1, ...totals.map(entry => entry.periodStart.getUTCFullYear())])].sort((a, b) => b - a);

    // The period being filed is the previous one; it stays the first tab until it is complete and past its deadline.
    const previous = previousPeriod(current);
    const previousCount = total.get(previous.start) ?? 0;
    const previousOpen = previousCount - (done.get(previous.start) ?? 0);
    const previousDue = this.deadlines.vatDue(previous.kind, previous.end);
    const beingFiled = previousCount > 0 && (previousOpen > 0 || previousDue >= today);
    const first = beingFiled ? previous : current;
    const defaultPeriod = periodKey(first);
    // The tabs show the year of the period to open first, unless a year was asked for.
    const year = query.year ? Number(query.year) : first.year;

    const starts: string[] = kind === 'quarter' ? [1, 4, 7, 10].map(month => `${year}-${String(month).padStart(2, '0')}-01`) : kind === 'month' ? Array.from({ length: 12 }, (_value, index) => `${year}-${String(index + 1).padStart(2, '0')}-01`) : [`${year}-01-01`];
    const periods = starts.map(start => {
      const range = periodContaining(kind, start);
      const count = total.get(start) ?? 0;
      const complete = done.get(start) ?? 0;
      return { ...this.periodView(range, today, locale), total: count, done: complete, open: count - complete, isCurrent: start === current.start };
    });

    const frequency = (code: string) => Number(clients.filter(entry => entry.frequency === code).reduce((sum, entry) => sum + entry.total, 0n));
    return {
      kind,
      year,
      years,
      periods,
      defaultPeriod,
      currentPeriod: periodKey(current),
      clients: { quarter: frequency('quarter'), month: frequency('month'), year: frequency('year') },
      withoutFrequency: Number(clients.filter(entry => entry.frequency === null).reduce((sum, entry) => sum + entry.total, 0n)),
    };
  }

  /* ── Making the rows of a period ──────────────────────────────────────────────────────────────────────────────── */

  /** Makes the rows a period is missing: one for every active client whose VAT frequency is this kind. Returns how many were made. */
  async ensure(range: PeriodRange, source: 'automatic' | 'manual'): Promise<number> {
    const missing = await this.prisma.client.findMany({
      where: { isActive: true, data: { path: ['vat_frequency'], equals: range.kind }, vatPeriods: { none: { kind: range.kind, periodStart: parseDay(range.start) } } },
      select: { id: true },
    });
    if (!missing.length) return 0;
    const made = await this.prisma.vatPeriod.createMany({ data: missing.map(client => ({ clientId: client.id, kind: range.kind, periodStart: parseDay(range.start), periodEnd: parseDay(range.end) })), skipDuplicates: true });
    if (made.count) await this.audit.log({ action: 'created', entityType: VAT_PERIOD_ENTITY, entityLabel: periodLabel(range, 'nl'), after: { period: periodKey(range), rows: made.count }, meta: { source } });
    return made.count;
  }

  /** The rows of the period that is being filed (the previous one) and of the one that is running, for one kind of period. */
  private async ensureWindow(kind: VatKind, today: string): Promise<number> {
    if (!this.deadlines.setting<boolean>('createVatAutomatically')) return 0;
    const current = periodContaining(kind, today);
    return (await this.ensure(previousPeriod(current), 'automatic')) + (await this.ensure(current, 'automatic'));
  }

  /** Every night: the rows of the quarter that is being filed and of the one that is running (and the same for months and years). */
  async ensureCurrent(): Promise<number> {
    const today = todayInAmsterdam();
    let made = 0;
    for (const kind of VAT_KINDS) made += await this.ensureWindow(kind, today);
    return made;
  }

  /** `POST /taxes/vat/generate` — a person asks for the rows of a period (an older one, or the next). */
  async generate(period: string): Promise<{ created: number; period: string }> {
    const range = parsePeriodKey(period);
    if (!range) throw validationFailed({ period: 'validation.invalid' });
    // The next period may be made in advance; further than that is a typing mistake.
    const latest = nextPeriod(periodContaining(range.kind, todayInAmsterdam()));
    if (range.start > latest.start) throw validationFailed({ period: 'taxes.periodTooFar' });
    if (range.year < 2000) throw validationFailed({ period: 'validation.invalid' });
    return { created: await this.ensure(range, 'manual'), period: periodKey(range) };
  }

  /* ── Ticking ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  private assertEditable(row: VatRow): void {
    if (!row.isActive) throw new ConflictException({ code: 'vat_period_inactive', message: 'This row is switched off.' });
  }

  /** After the ticks changed: a row is complete when every step that counts is ticked (and stays complete until somebody takes a tick away). */
  private async settle(id: string, steps: readonly VatStep[]): Promise<boolean> {
    const fresh = await this.prisma.vatPeriod.findUniqueOrThrow({ where: { id }, select: { ticks: true, completedAt: true } });
    const ticks = readTicks(fresh.ticks);
    const complete = steps.every(step => ticks[step.code]);
    if (complete !== (fresh.completedAt !== null)) await this.prisma.vatPeriod.update({ where: { id }, data: { completedAt: complete ? new Date() : null } });
    return complete;
  }

  /** Puts ticks on a row, or takes them away — atomically, so two people ticking different steps of the same row never lose each other's tick. */
  private async apply(id: string, codes: readonly string[], done: boolean, userId: string): Promise<void> {
    if (done) {
      const at = new Date().toISOString();
      const added = Object.fromEntries(codes.map(code => [code, { at, by: userId }]));
      await this.prisma.$executeRaw`UPDATE "VatPeriod" SET "ticks" = "ticks" || ${JSON.stringify(added)}::jsonb, "updatedAt" = now() WHERE "id" = ${id}`;
    } else {
      await this.prisma.$executeRaw`UPDATE "VatPeriod" SET "ticks" = "ticks" - ${[...codes]}::text[], "updatedAt" = now() WHERE "id" = ${id}`;
    }
  }

  async setStep(id: string, code: string, done: boolean, user: AuthenticatedUser) {
    const [row, steps] = await Promise.all([this.rowOrThrow(id), this.steps.active()]);
    this.assertEditable(row);
    if (!steps.some(step => step.code === code)) throw validationFailed({ step: 'validation.invalid' });
    if (Boolean(readTicks(row.ticks)[code]) === done) return this.one(id);
    await this.apply(id, [code], done, user.id);
    const complete = await this.settle(id, steps);
    await this.audit.log({
      action: 'updated',
      entityType: VAT_PERIOD_ENTITY,
      entityId: id,
      entityLabel: this.label(row),
      before: { [code]: !done, completed: row.completedAt !== null },
      after: { [code]: done, completed: complete },
    });
    return this.one(id);
  }

  /** Ticks (or takes away) the same steps for many rows. Rows that are switched off or already in that state are left alone. */
  async bulk(dto: VatBulkDto, user: AuthenticatedUser) {
    const steps = await this.steps.active();
    const wanted = [...new Set(dto.steps)];
    if (wanted.some(code => !steps.some(step => step.code === code))) throw validationFailed({ steps: 'validation.invalid' });
    const rows = await this.prisma.vatPeriod.findMany({ where: { id: { in: [...new Set(dto.ids)] }, isActive: true }, include: VAT_INCLUDE });
    let updated = 0;
    for (const row of rows) {
      const ticks = readTicks(row.ticks);
      const changing = wanted.filter(code => Boolean(ticks[code]) !== dto.done);
      if (!changing.length) continue;
      await this.apply(row.id, changing, dto.done, user.id);
      const complete = await this.settle(row.id, steps);
      await this.audit.log({
        action: 'updated',
        entityType: VAT_PERIOD_ENTITY,
        entityId: row.id,
        entityLabel: this.label(row),
        before: { ...Object.fromEntries(changing.map(code => [code, !dto.done])), completed: row.completedAt !== null },
        after: { ...Object.fromEntries(changing.map(code => [code, dto.done])), completed: complete },
      });
      updated += 1;
    }
    return { updated, skipped: new Set(dto.ids).size - updated };
  }

  async update(id: string, dto: VatPeriodUpdateDto) {
    const row = await this.rowOrThrow(id);
    const note = dto.note === undefined ? row.note : dto.note.trim();
    if (note !== row.note) {
      await this.prisma.vatPeriod.update({ where: { id }, data: { note } });
      await this.audit.log({ action: 'updated', entityType: VAT_PERIOD_ENTITY, entityId: id, entityLabel: this.label(row), before: { note: row.note }, after: { note } });
    }
    return this.one(id);
  }

  /** Switches a row off (a client that needed no return this quarter — it stays for history) or on again. */
  async setActive(id: string, dto: ActiveDto, user: AuthenticatedUser) {
    const row = await this.rowOrThrow(id);
    if (row.isActive === dto.isActive) return this.one(id);
    await this.prisma.vatPeriod.update({
      where: { id },
      data: dto.isActive ? { isActive: true, deactivatedAt: null, deactivatedById: null, deactivationReason: '' } : { isActive: false, deactivatedAt: new Date(), deactivatedById: user.id, deactivationReason: dto.reason?.trim() ?? '' },
    });
    await this.audit.log({ action: dto.isActive ? 'activated' : 'deactivated', entityType: VAT_PERIOD_ENTITY, entityId: id, entityLabel: this.label(row), ...(dto.reason?.trim() && { meta: { reason: dto.reason.trim() } }) });
    return this.one(id);
  }

  /* ── Export ───────────────────────────────────────────────────────────────────────────────────────────────────── */

  async exportTable(query: VatExportQuery, locale: AppLocale): Promise<ExportTable> {
    const today = todayInAmsterdam();
    const range = this.parseRange(query.period);
    const where = this.where(query, range);
    this.exports.assertSize(await this.prisma.vatPeriod.count({ where }));
    const [rows, steps] = await Promise.all([this.prisma.vatPeriod.findMany({ where, orderBy: this.orderBy(query.sort, range), include: VAT_INCLUDE }), this.steps.active()]);
    const views = await this.views(rows, steps, today);
    const nl = locale === 'nl';
    const named = steps.map(step => ({ step, header: [locale === 'nl' ? step.groupNl : step.groupEn, locale === 'nl' ? step.nameNl : step.nameEn].filter(Boolean).join(' · ') }));
    const subtitle = [range ? periodLabel(range, locale) : '', query.open ? (nl ? 'alleen open' : 'open only') : '', query.search?.trim() ? `${nl ? 'Zoekterm' : 'Search'}: ${query.search.trim()}` : ''].filter(Boolean).join(' · ');
    return {
      title: nl ? 'Btw-aangiften' : 'VAT returns',
      subtitle: subtitle || undefined,
      locale,
      columns: [
        { key: 'number', header: nl ? 'Klantnr.' : 'Client no.', width: 10 },
        { key: 'client', header: nl ? 'Klant' : 'Client', width: 28 },
        ...(range ? [] : [{ key: 'period', header: nl ? 'Periode' : 'Period', width: 14 }]),
        { key: 'dueOn', header: nl ? 'Deadline' : 'Deadline', type: 'date' as const, width: 12 },
        ...named.map(({ step, header }) => ({ key: step.code, header, type: 'boolean' as const, width: 12 })),
        { key: 'ticked', header: nl ? 'Aantal' : 'Count', type: 'number' as const, width: 8 },
        { key: 'done', header: nl ? 'Klaar' : 'Done', type: 'boolean' as const, width: 8 },
        { key: 'filedOn', header: nl ? 'Verstuurd op' : 'Filed on', type: 'date' as const, width: 12 },
        { key: 'responsible', header: nl ? 'Verantwoordelijke' : 'Responsible', width: 20 },
        { key: 'note', header: nl ? 'Opmerking' : 'Note', width: 30 },
      ],
      rows: views.map(view => ({
        number: view.client.number,
        client: view.client.name,
        period: periodLabel(rangeOf(view.kind, view.periodStart), locale),
        dueOn: view.dueOn,
        ...Object.fromEntries(steps.map(step => [step.code, Boolean(view.ticks[step.code])])),
        ticked: view.ticked,
        done: view.done,
        filedOn: view.filedOn,
        responsible: view.responsible?.name ?? '',
        note: view.note,
      })),
    };
  }
}
