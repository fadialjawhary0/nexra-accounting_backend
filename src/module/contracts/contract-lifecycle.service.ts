import { HttpException, Injectable, Logger, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { addDays, formatDay, isValidDay, parseDay, todayInAmsterdam } from '../../common/dates.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { validationFailed } from '../../common/validation/failure.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { SettingsService } from '../../lib/settings/settings.service.js';
import { EmployeeRatesService } from '../employees/employee-rates.service.js';
import { EmployeesService } from '../employees/employees.service.js';
import { ListsService } from '../lists/lists.service.js';
import { personName } from '../people/person-record.js';
import { asRecord } from '../../common/record-values.js';
import { ContractDocumentsService, type GeneratedDocument } from './contract-documents.service.js';
import { FIELD, OPEN_STATUSES, addMonths, type ContractStatus } from './contract-record.js';
import { CONTRACTS_NAMESPACE } from './contracts.settings.js';
import { ContractsService, type ContractRow } from './contracts.service.js';
import type { CancelContractDto, CreateContractDto, RenewContractDto, SendContractDto, SignContractDto, TerminateContractDto } from './dto/contract.dto.js';

/** What happened to the Word / PDF document that was asked for together with an action. */
export type GenerationReport = { ok: true; pdf: boolean; unknown: string[]; empty: string[] } | { ok: false; code: string };

const SYSTEM_CATCH_UP = 'System';

/**
 * What happens to a contract over time: saved as a draft, handed out to be signed (sent), signed (running), ended by itself, terminated early,
 * cancelled before it took effect, renewed — and taken back when that was a mistake. Every step writes an audit entry; nothing is deleted.
 * Signing also tells the worker's own record: the first day of work and the hourly rate (data is entered once and used everywhere).
 */
@Injectable()
export class ContractLifecycleService implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(ContractLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly contracts: ContractsService,
    private readonly documents: ContractDocumentsService,
    private readonly rates: EmployeeRatesService,
    private readonly employees: EmployeesService,
    private readonly lists: ListsService,
    private readonly settings: SettingsService,
  ) {}

  onModuleInit(): void {
    // A worker who leaves takes their open contracts with them.
    this.employees.onStopped(async event => {
      if (!this.settings.get<boolean>(`${CONTRACTS_NAMESPACE}.endContractsWithWorker`)) return;
      await this.endWithWorker(event.employeeId, event.endDate, event.reason, event.user);
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    // The server may have been off at night: catch up on contracts that ran out meanwhile.
    await this.endExpired().catch(error => this.logger.warn(`Could not end expired contracts: ${(error as Error).message}`));
  }

  /* ── Making ───────────────────────────────────────────────────────────────────────────────────────────────────── */

  /** Saves a new draft and, when asked and a template was chosen, makes its Word / PDF document. */
  async create(dto: CreateContractDto, user: AuthenticatedUser) {
    const row = await this.contracts.create(dto, user);
    const generation = dto.generate && row.templateId ? await this.generate(row.id, user) : null;
    return { ...(await this.contracts.get(row.id, user)), generation };
  }

  /** A document is made best-effort next to an action: when the template is broken the contract is still saved, and the report says why not. */
  async generate(contractId: string, user: AuthenticatedUser, options: { templateId?: string; version?: number } = {}): Promise<GenerationReport> {
    try {
      const made: GeneratedDocument = await this.documents.generate(contractId, options, user);
      return { ok: true, pdf: made.pdf, unknown: made.unknown, empty: made.empty };
    } catch (error) {
      const body = error instanceof HttpException ? (error.getResponse() as { code?: string }) : {};
      this.logger.warn(`Could not make the document of contract ${contractId}: ${(error as Error).message}`);
      return { ok: false, code: body.code ?? 'generation_failed' };
    }
  }

  /** A new contract that continues this one: the same worker, client, type, wage and template, starting the day after this one ends. */
  async renew(id: string, dto: RenewContractDto, user: AuthenticatedUser) {
    const source = await this.contracts.findOrThrow(id);
    if (!['active', 'ended'].includes(source.status)) throw validationFailed({ status: 'contracts.cannotRenew' });
    const problems: Record<string, string> = {};
    for (const [key, value] of [['startDate', dto.startDate], ['endDate', dto.endDate]] as const) if (value !== undefined && !isValidDay(value)) problems[key] = 'validation.invalidDate';
    if (Object.keys(problems).length) throw validationFailed(problems);

    const previousEnd = source.endDate ? formatDay(source.endDate) : null;
    const start = dto.startDate ?? (previousEnd ? addDays(previousEnd, 1) : todayInAmsterdam());
    const months = source.durationMonths;
    const end = dto.endDate ?? (previousEnd && months ? addDays(addMonths(start, months), -1) : null);

    const values = { ...this.contracts.values(source), start_date: start, end_date: end } as Record<string, unknown>;
    delete values.signing_date;
    if (!end) delete values.end_date;
    const created = await this.contracts.create(
      { clientId: source.clientId, employeeId: source.employeeId, templateId: dto.templateId ?? source.templateId ?? undefined, renewalOfId: source.id, values },
      user,
    );
    await this.audit.log({ action: 'updated', entityType: 'contract', entityId: source.id, entityLabel: this.contracts.label(source.client, source.employee.person, formatDay(source.startDate)), meta: { renewedBy: created.id } });
    const generation = (dto.generate ?? true) && created.templateId ? await this.generate(created.id, user) : null;
    return { ...(await this.contracts.get(created.id, user)), generation };
  }

  /* ── Status ───────────────────────────────────────────────────────────────────────────────────────────────────── */

  /** The contract was handed to the worker to be signed. */
  async send(id: string, dto: SendContractDto, user: AuthenticatedUser) {
    const row = await this.contracts.findOrThrow(id);
    this.assertStatus(row, ['draft']);
    const date = this.dayOrToday(dto.date, 'date');
    await this.prisma.contract.update({ where: { id }, data: { status: 'sent', sentOn: parseDay(date) } });
    await this.log('sent', row, { before: { status: row.status }, after: { status: 'sent', sentOn: date } });
    return this.contracts.get(id, user);
  }

  /** The contract was signed: it is running (or already over, for a contract that is entered afterwards). The signed copy can come along. */
  async sign(id: string, dto: SignContractDto, user: AuthenticatedUser) {
    const row = await this.contracts.findOrThrow(id);
    this.assertStatus(row, ['draft', 'sent']);
    const signing = asRecord(row.data)[FIELD.signingDate];
    const signedOn = this.dayOrToday(dto.signedOn ?? (typeof signing === 'string' ? signing : undefined), 'signedOn');
    if (dto.fileId) await this.documents.attachScan(id, dto.fileId, user);

    const over = row.endDate && formatDay(row.endDate) < todayInAmsterdam();
    const status: ContractStatus = over ? 'ended' : 'active';
    await this.prisma.contract.update({
      where: { id },
      data: { status, signedOn: parseDay(signedOn), isActive: !over, ...(over && { deactivatedAt: new Date() }) },
    });
    await this.log('signed', row, { before: { status: row.status }, after: { status, signedOn } });
    await this.syncWorker(row, user);
    return this.contracts.get(id, user);
  }

  /** The contract ends early on `date`, for a reason; the termination letter can be made at the same time. */
  async terminate(id: string, dto: TerminateContractDto, user: AuthenticatedUser) {
    const row = await this.contracts.findOrThrow(id);
    this.assertStatus(row, ['active']);
    const problems: Record<string, string> = {};
    if (!isValidDay(dto.date)) problems.date = 'validation.invalidDate';
    else if (dto.date < formatDay(row.startDate)) problems.date = 'validation.endBeforeStart';
    else if (row.endDate && dto.date > formatDay(row.endDate)) problems.date = 'contracts.afterEnd';
    if (!(await this.lists.activeCodes('termination_reason')).has(dto.reason)) problems.reason = 'validation.selectOption';
    if (dto.stopEmployee) {
      const other = await this.prisma.contract.count({ where: { employeeId: row.employeeId, id: { not: id }, status: { in: [...OPEN_STATUSES] } } });
      if (other) problems.stopEmployee = 'contracts.workerHasOtherContracts';
    }
    if (Object.keys(problems).length) throw validationFailed(problems);

    await this.prisma.contract.update({
      where: { id },
      data: { status: 'terminated', isActive: false, deactivatedAt: new Date(), deactivatedById: user.id, terminatedOn: parseDay(dto.date), terminationReason: dto.reason, terminationNote: dto.note?.trim() ?? '' },
    });
    await this.log('status_changed', row, { before: { status: row.status }, after: { status: 'terminated', terminatedOn: dto.date, reason: dto.reason, ...(dto.note?.trim() && { note: dto.note.trim() }) } });

    let letter: GenerationReport | null = null;
    if (dto.letterTemplateId) {
      try {
        const made = await this.documents.letter(id, dto.letterTemplateId, undefined, user);
        letter = { ok: true, pdf: made.pdf, unknown: made.unknown, empty: made.empty };
      } catch (error) {
        const body = error instanceof HttpException ? (error.getResponse() as { code?: string }) : {};
        letter = { ok: false, code: body.code ?? 'generation_failed' };
      }
    }
    // The worker leaves with the contract (their other contracts were checked above); the stop is recorded on the worker.
    if (dto.stopEmployee) await this.employees.setStatus(row.employeeId, { status: 'stopped', date: dto.date, reason: dto.note?.trim() || undefined }, user);
    return { ...(await this.contracts.get(id, user)), letter };
  }

  /** A contract that never took effect (a draft or a contract that was sent but not signed) is cancelled. */
  async cancel(id: string, dto: CancelContractDto, user: AuthenticatedUser) {
    const row = await this.contracts.findOrThrow(id);
    this.assertStatus(row, ['draft', 'sent']);
    await this.cancelRow(row, dto.reason?.trim() ?? '', user.id);
    return this.contracts.get(id, user);
  }

  /** Takes back a termination, a cancellation or an ending that was a mistake. */
  async reopen(id: string, user: AuthenticatedUser) {
    const row = await this.contracts.findOrThrow(id);
    const today = todayInAmsterdam();
    let status: ContractStatus;
    if (row.status === 'terminated') status = 'active';
    else if (row.status === 'cancelled') status = 'draft';
    else if (row.status === 'ended' && row.endDate && formatDay(row.endDate) >= today) status = 'active';
    else throw validationFailed({ status: 'contracts.cannotReopen' });
    await this.prisma.contract.update({
      where: { id },
      data: { status, isActive: true, deactivatedAt: null, deactivatedById: null, terminatedOn: null, terminationReason: null, terminationNote: '' },
    });
    await this.log('activated', row, { before: { status: row.status, terminatedOn: row.terminatedOn ? formatDay(row.terminatedOn) : null }, after: { status } });
    return this.contracts.get(id, user);
  }

  /* ── Automatic ────────────────────────────────────────────────────────────────────────────────────────────────── */

  /** Running contracts whose last day has passed are over. Every night, and once when the server starts. */
  @Cron('20 0 * * *', { timeZone: 'Europe/Amsterdam' })
  async endExpired(): Promise<number> {
    const rows = await this.prisma.contract.findMany({ where: { status: 'active', endDate: { lt: parseDay(todayInAmsterdam()) } }, include: { client: true, employee: { include: { person: true } } } });
    for (const row of rows) {
      await this.prisma.contract.update({ where: { id: row.id }, data: { status: 'ended', isActive: false, deactivatedAt: new Date() } });
      await this.log('status_changed', row, { before: { status: 'active' }, after: { status: 'ended' } }, SYSTEM_CATCH_UP);
    }
    if (rows.length) this.logger.log(`${rows.length} contract(s) ended.`);
    return rows.length;
  }

  /** A worker left: their draft and sent contracts are cancelled, a running one ends on the worker's last day (when that is earlier than its own end). */
  private async endWithWorker(employeeId: string, endDate: string, reason: string, user: AuthenticatedUser): Promise<void> {
    const open = await this.prisma.contract.findMany({ where: { employeeId, status: { in: [...OPEN_STATUSES] } }, include: { client: true, employee: { include: { person: true } } } });
    for (const row of open) {
      const start = formatDay(row.startDate);
      const end = row.endDate ? formatDay(row.endDate) : null;
      if (row.status !== 'active' || endDate < start) {
        await this.cancelRow(row, reason || 'Werknemer uit dienst', user.id);
      } else if (!end || endDate < end) {
        await this.prisma.contract.update({
          where: { id: row.id },
          data: { status: 'terminated', isActive: false, deactivatedAt: new Date(), deactivatedById: user.id, terminatedOn: parseDay(endDate), terminationReason: 'other', terminationNote: reason || 'Werknemer uit dienst' },
        });
        await this.log('status_changed', row, { before: { status: row.status }, after: { status: 'terminated', terminatedOn: endDate, reason: 'other' } });
      }
    }
  }

  /* ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  private async cancelRow(row: ContractRow, reason: string, userId: string): Promise<void> {
    await this.prisma.contract.update({ where: { id: row.id }, data: { status: 'cancelled', isActive: false, deactivatedAt: new Date(), deactivatedById: userId, terminationNote: reason } });
    await this.log('status_changed', row, { before: { status: row.status }, after: { status: 'cancelled', ...(reason && { reason }) } });
  }

  /** Signing sets the worker's first day of work (when it is not known or later) and their hourly rate from the first day of the contract. */
  private async syncWorker(row: ContractRow, user: AuthenticatedUser): Promise<void> {
    if (!this.settings.get<boolean>(`${CONTRACTS_NAMESPACE}.syncWorker`)) return;
    const start = formatDay(row.startDate);
    const employee = row.employee;
    const rate = asRecord(row.data)[FIELD.hourlyRate];
    const changes: Record<string, unknown> = {};
    await this.prisma.$transaction(async tx => {
      if (!employee.startDate || formatDay(employee.startDate) > start) {
        await tx.employee.update({ where: { id: employee.id }, data: { startDate: parseDay(start) } });
        changes.startDate = start;
      }
      if (typeof rate === 'number') {
        const inForce = await tx.rateHistory.findFirst({ where: { employeeId: employee.id, validFrom: { lte: parseDay(start) } }, orderBy: { validFrom: 'desc' } });
        if (!inForce || inForce.rate.toNumber() !== rate) {
          await this.rates.setFrom(tx, employee.id, rate, start, user.id, 'Contract');
          changes.hourly_rate = rate;
        }
      }
    });
    if (Object.keys(changes).length) {
      await this.audit.log({
        action: 'updated',
        entityType: 'employee',
        entityId: employee.id,
        entityLabel: `${personName(employee.person)} (${row.client.number})`,
        after: changes,
        meta: { via: 'contract', contractId: row.id },
      });
    }
  }

  private assertStatus(row: ContractRow, allowed: ContractStatus[]): void {
    if (!allowed.includes(row.status as ContractStatus)) throw validationFailed({ status: 'contracts.wrongStatus' });
  }

  private dayOrToday(value: string | undefined, field: string): string {
    if (value === undefined) return todayInAmsterdam();
    if (!isValidDay(value)) throw validationFailed({ [field]: 'validation.invalidDate' });
    return value;
  }

  private async log(action: string, row: ContractRow, change: { before?: Record<string, unknown>; after?: Record<string, unknown> }, actor?: string): Promise<void> {
    await this.audit.log({
      action,
      entityType: 'contract',
      entityId: row.id,
      entityLabel: this.contracts.label(row.client, row.employee.person, formatDay(row.startDate)),
      before: change.before,
      after: change.after,
      ...(actor && { meta: { by: actor } }),
    });
  }
}
