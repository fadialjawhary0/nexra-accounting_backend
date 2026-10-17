import { ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { formatDay, parseDay } from '../../common/dates.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { validationFailed } from '../../common/validation/failure.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { personName } from '../people/person-record.js';
import { ReconciliationService } from '../reconciliation/reconciliation.service.js';
import { matrixAllows } from '../roles/permission-catalog.js';
import type { ClosePeriodDto, ReleaseLockDto } from './dto/hours.dto.js';
import { HOURS_AREA } from './hours.constants.js';
import { firstOfMonth, isMonth, lastOfMonth } from './hours-time.js';

export interface LockBrief {
  id: string;
  from: string;
  to: string;
  kind: string;
  statementId: string | null;
  invoiceId: string | null;
  note: string;
}

/** Which days of which workers are closed, looked up once for a request. */
export class LockIndex {
  constructor(private readonly byWorker: Map<string, LockBrief[]>) {}

  covering(employeeId: string, day: string): LockBrief | null {
    return this.byWorker.get(employeeId)?.find(lock => lock.from <= day && day <= lock.to) ?? null;
  }
}

/**
 * Closed days. A salary statement closes the days it covers, an invoice the days its lines bill; the office can also close a period by hand (typically
 * a month, once the hours, salaries and invoices of that month match — if they do not, a reason is needed). Changing a closed day is still possible —
 * with the permission to approve and a reason — and every such change is in the audit log; nothing silently moves under a statement that was already
 * paid or an invoice that was already sent.
 */
@Injectable()
export class PeriodLocksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly reconciliation: ReconciliationService,
  ) {}

  /** The locks that touch `from → to` for these workers. */
  async index(employeeIds: string[], from: string, to: string): Promise<LockIndex> {
    const rows = employeeIds.length
      ? await this.prisma.periodLock.findMany({ where: { employeeId: { in: employeeIds }, fromDate: { lte: parseDay(to) }, toDate: { gte: parseDay(from) } }, orderBy: { fromDate: 'asc' } })
      : [];
    const byWorker = new Map<string, LockBrief[]>();
    for (const row of rows) {
      const list = byWorker.get(row.employeeId) ?? [];
      list.push({ id: row.id, from: formatDay(row.fromDate), to: formatDay(row.toDate), kind: row.kind, statementId: row.statementId, invoiceId: row.invoiceId, note: row.note });
      byWorker.set(row.employeeId, list);
    }
    return new LockIndex(byWorker);
  }

  /**
   * A change to a closed day: allowed with the permission to approve and a reason. Returns `true` when the day was closed (so the caller can note
   * it in the audit log), `false` when it was open. Throws 403 `period_locked` / 422 `reason_required` otherwise.
   */
  assertEditable(lock: LockBrief | null, user: AuthenticatedUser, reason: string | undefined): boolean {
    if (!lock) return false;
    if (!matrixAllows(user.matrix, `${HOURS_AREA}.approve`)) {
      throw new ForbiddenException({ code: 'period_locked', message: 'These days are closed.', details: { from: lock.from, to: lock.to } });
    }
    if (!reason?.trim()) {
      throw new UnprocessableEntityException({ code: 'reason_required', message: 'A reason is needed to change closed days.', fields: { reason: 'validation.required' }, details: { from: lock.from, to: lock.to } });
    }
    return true;
  }

  /** Closes the days of a statement (inside the statement's transaction). */
  async lockForStatement(tx: Prisma.TransactionClient, statement: { id: string; employeeId: string; from: string; to: string }, userId: string): Promise<void> {
    await tx.periodLock.create({ data: { employeeId: statement.employeeId, fromDate: parseDay(statement.from), toDate: parseDay(statement.to), kind: 'statement', statementId: statement.id, createdById: userId } });
  }

  /** Closes the days the hours lines of an invoice bill (inside the transaction that issues or checks the invoice). */
  async lockForInvoice(tx: Prisma.TransactionClient, invoice: { id: string; lines: Array<{ employeeId: string | null; from: string | null; to: string | null }> }, userId: string): Promise<void> {
    await tx.periodLock.deleteMany({ where: { invoiceId: invoice.id } });
    for (const line of invoice.lines) {
      if (!line.employeeId || !line.from || !line.to) continue;
      await tx.periodLock.create({ data: { employeeId: line.employeeId, fromDate: parseDay(line.from), toDate: parseDay(line.to), kind: 'invoice', invoiceId: invoice.id, createdById: userId } });
    }
  }

  /** Opens the days of an invoice again (it was cancelled, credited or taken back to "received"). */
  async unlockInvoice(tx: Prisma.TransactionClient, invoiceId: string): Promise<void> {
    await tx.periodLock.deleteMany({ where: { invoiceId } });
  }

  /* ── Reading ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  async list(query: { employeeId?: string; clientId?: string; from?: string; to?: string }) {
    const rows = await this.prisma.periodLock.findMany({
      where: {
        ...(query.employeeId && { employeeId: query.employeeId }),
        ...(query.clientId && { employee: { clientId: query.clientId } }),
        ...(query.from && { toDate: { gte: parseDay(query.from) } }),
        ...(query.to && { fromDate: { lte: parseDay(query.to) } }),
      },
      include: { employee: { include: { person: true, client: { select: { number: true, name: true } } } } },
      orderBy: [{ fromDate: 'desc' }, { createdAt: 'desc' }],
      take: 500,
    });
    return rows.map(row => ({
      id: row.id,
      employeeId: row.employeeId,
      employee: personName(row.employee.person),
      client: `${row.employee.client.number} – ${row.employee.client.name}`,
      from: formatDay(row.fromDate),
      to: formatDay(row.toDate),
      kind: row.kind,
      statementId: row.statementId,
      invoiceId: row.invoiceId,
      note: row.note,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /* ── Closing and reopening by hand ────────────────────────────────────────────────────────────────────────────── */

  /**
   * Closes a period (usually a month) for some workers, or for every worker of a client. Hours, pay and invoices of each worker are put side by side first:
   * where they do not match, closing needs a reason (`reconciliation_mismatch` lists what is wrong), which is kept with the lock and in the audit log.
   */
  async close(dto: ClosePeriodDto, user: AuthenticatedUser) {
    const { from, to } = this.period(dto);
    const workers = await this.workersFor(dto, from, to);
    if (!workers.length) throw validationFailed({ employeeIds: 'validation.required' });

    const todo: typeof workers = [];
    for (const worker of workers) {
      const existing = await this.prisma.periodLock.findFirst({ where: { employeeId: worker.id, kind: 'manual', fromDate: parseDay(from), toDate: parseDay(to) } });
      if (!existing) todo.push(worker);
    }
    const figures = await this.reconciliation.forWorkers(todo.map(worker => worker.id), from, to);
    const different = todo.filter(worker => figures.get(worker.id)?.status === 'differences');
    const reason = dto.reason?.trim() ?? '';
    if (different.length && !reason) {
      throw new UnprocessableEntityException({
        code: 'reconciliation_mismatch',
        message: 'Hours, pay and invoices do not match for some workers. Give a reason to close the period anyway.',
        fields: { reason: 'validation.required' },
        details: { from, to, workers: different.map(worker => ({ employeeId: worker.id, name: personName(worker.person), clientNumber: worker.client.number, causes: figures.get(worker.id)?.causes ?? [] })) },
      });
    }

    let created = 0;
    for (const worker of todo) {
      const off = different.includes(worker);
      const note = [dto.note?.trim(), off ? reason : ''].filter(Boolean).join(' · ');
      const lock = await this.prisma.periodLock.create({ data: { employeeId: worker.id, fromDate: parseDay(from), toDate: parseDay(to), kind: 'manual', note, createdById: user.id } });
      created += 1;
      await this.audit.log({
        action: 'locked',
        entityType: 'hours',
        entityId: worker.id,
        entityLabel: `${personName(worker.person)} (${worker.client.number})`,
        after: { from, to },
        meta: { lockId: lock.id, note, ...(off && { reason, differences: figures.get(worker.id)?.causes.map(cause => cause.code) }) },
      });
    }
    return { closed: created, skipped: workers.length - created, from, to };
  }

  async release(id: string, dto: ReleaseLockDto, user: AuthenticatedUser) {
    const lock = await this.prisma.periodLock.findUnique({ where: { id }, include: { employee: { include: { person: true, client: { select: { number: true } } } } } });
    if (!lock) throw new NotFoundException({ code: 'not_found', message: 'Period not found' });
    if (lock.kind === 'statement') throw new ConflictException({ code: 'lock_belongs_to_statement', message: 'This period is closed by a salary statement. Cancel the statement to open it again.' });
    if (lock.kind === 'invoice') throw new ConflictException({ code: 'lock_belongs_to_invoice', message: 'This period is closed by an invoice. Take the invoice back (or credit it) to open it again.' });
    if (!dto.reason?.trim()) throw validationFailed({ reason: 'validation.required' });
    await this.prisma.periodLock.delete({ where: { id } });
    await this.audit.log({ action: 'unlocked', entityType: 'hours', entityId: lock.employeeId, entityLabel: `${personName(lock.employee.person)} (${lock.employee.client.number})`, before: { from: formatDay(lock.fromDate), to: formatDay(lock.toDate) }, meta: { reason: dto.reason.trim(), by: user.id } });
    return { released: true };
  }

  /* ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  private period(dto: ClosePeriodDto): { from: string; to: string } {
    if (dto.month !== undefined) {
      if (!isMonth(dto.month)) throw validationFailed({ month: 'validation.invalid' });
      return { from: firstOfMonth(dto.month), to: lastOfMonth(dto.month) };
    }
    if (!dto.from || !dto.to) throw validationFailed({ month: 'validation.required' });
    if (dto.to < dto.from) throw validationFailed({ to: 'validation.endBeforeStart' });
    return { from: dto.from, to: dto.to };
  }

  /** The workers a period is closed for: the chosen ones, or those of the client who were employed in the period. */
  private async workersFor(dto: ClosePeriodDto, from: string, to: string) {
    const include = { person: true, client: { select: { number: true } } } as const;
    if (dto.employeeIds?.length) return this.prisma.employee.findMany({ where: { id: { in: dto.employeeIds } }, include });
    if (!dto.clientId) return [];
    return this.prisma.employee.findMany({
      where: {
        clientId: dto.clientId,
        AND: [{ OR: [{ startDate: null }, { startDate: { lte: parseDay(to) } }] }, { OR: [{ endDate: null }, { endDate: { gte: parseDay(from) } }] }],
      },
      include,
    });
  }
}
