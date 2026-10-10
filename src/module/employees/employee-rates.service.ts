import { Injectable, NotFoundException } from '@nestjs/common';
import { formatDay, isValidDay, parseDay, todayInAmsterdam } from '../../common/dates.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { validationFailed } from '../../common/validation/failure.js';
import { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { personName } from '../people/person-record.js';
import type { AddRateDto } from './dto/employee.dto.js';

export interface RateRow {
  id: string;
  rate: number;
  validFrom: string;
  note: string;
  /** The rate that applies today. */
  current: boolean;
}

/**
 * The hourly rate of a worker over time. A change adds a row that starts on its day; the past is never overwritten, so the hours, salary
 * statements and invoices of an earlier month keep the rate that was true then. "Today's rate" is the latest row that has started.
 */
@Injectable()
export class EmployeeRatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Today's rate of each of these workers (workers without a rate are left out). */
  async currentRates(employeeIds: string[]): Promise<Map<string, number>> {
    if (!employeeIds.length) return new Map();
    const rows = await this.prisma.$queryRaw<Array<{ employeeId: string; rate: number }>>(Prisma.sql`
      SELECT DISTINCT ON ("employeeId") "employeeId", "rate"::float8 AS "rate" FROM "RateHistory"
      WHERE "employeeId" IN (${Prisma.join(employeeIds)}) AND "validFrom" <= (now() AT TIME ZONE 'Europe/Amsterdam')::date
      ORDER BY "employeeId", "validFrom" DESC`);
    return new Map(rows.map(row => [row.employeeId, Number(row.rate)]));
  }

  async current(employeeId: string): Promise<number | null> {
    return (await this.currentRates([employeeId])).get(employeeId) ?? null;
  }

  /** The history, newest first; the row that applies today is marked. */
  async list(employeeId: string): Promise<RateRow[]> {
    const rows = await this.prisma.rateHistory.findMany({ where: { employeeId }, orderBy: { validFrom: 'desc' } });
    const today = todayInAmsterdam();
    const currentId = rows.find(row => formatDay(row.validFrom) <= today)?.id;
    return rows.map(row => ({ id: row.id, rate: row.rate.toNumber(), validFrom: formatDay(row.validFrom), note: row.note, current: row.id === currentId }));
  }

  /** Makes `rate` apply from `validFrom` (inside the caller's transaction): a second rate for the same day replaces the first. */
  async setFrom(tx: Prisma.TransactionClient, employeeId: string, rate: number, validFrom: string, userId: string, note = ''): Promise<void> {
    const day = parseDay(validFrom);
    await tx.rateHistory.upsert({
      where: { employeeId_validFrom: { employeeId, validFrom: day } },
      create: { employeeId, rate, validFrom: day, note, createdById: userId },
      update: { rate, note, createdById: userId },
    });
  }

  /** "New hourly rate from …" on the worker's page: also for a past or future day. */
  async add(employeeId: string, dto: AddRateDto, user: AuthenticatedUser): Promise<RateRow[]> {
    const employee = await this.employeeOrThrow(employeeId);
    if (!isValidDay(dto.validFrom)) throw validationFailed({ validFrom: 'validation.invalidDate' });
    const before = await this.current(employeeId);
    await this.prisma.$transaction(tx => this.setFrom(tx, employeeId, dto.rate, dto.validFrom, user.id, dto.note?.trim() ?? ''));
    const after = await this.current(employeeId);
    await this.audit.log({
      action: 'updated',
      entityType: 'employee',
      entityId: employeeId,
      entityLabel: this.label(employee),
      before: { hourly_rate: before },
      after: { hourly_rate: after },
      meta: { rate: dto.rate, validFrom: dto.validFrom },
    });
    return this.list(employeeId);
  }

  async remove(employeeId: string, rateId: string, user: AuthenticatedUser): Promise<RateRow[]> {
    const employee = await this.employeeOrThrow(employeeId);
    const row = await this.prisma.rateHistory.findFirst({ where: { id: rateId, employeeId } });
    if (!row) throw new NotFoundException({ code: 'not_found', message: 'Rate not found' });
    const before = await this.current(employeeId);
    await this.prisma.rateHistory.delete({ where: { id: rateId } });
    await this.audit.log({
      action: 'updated',
      entityType: 'employee',
      entityId: employeeId,
      entityLabel: this.label(employee),
      before: { hourly_rate: before },
      after: { hourly_rate: await this.current(employeeId) },
      meta: { removedRate: row.rate.toNumber(), validFrom: formatDay(row.validFrom), by: user.id },
    });
    return this.list(employeeId);
  }

  private async employeeOrThrow(employeeId: string) {
    const employee = await this.prisma.employee.findUnique({ where: { id: employeeId }, include: { person: true, client: { select: { number: true } } } });
    if (!employee) throw new NotFoundException({ code: 'not_found', message: 'Employee not found' });
    return employee;
  }

  private label(employee: { person: Parameters<typeof personName>[0]; client: { number: string } }): string {
    return `${personName(employee.person)} (${employee.client.number})`;
  }
}
