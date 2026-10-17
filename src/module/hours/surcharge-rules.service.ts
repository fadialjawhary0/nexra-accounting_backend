import { Injectable, NotFoundException } from '@nestjs/common';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { validationFailed } from '../../common/validation/failure.js';
import { Prisma, type SurchargeRule } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import type { SurchargeRuleDto, UpdateSurchargeRuleDto } from './dto/hours.dto.js';
import { MINUTES_PER_DAY, WEEKDAY_CODES, parseClock, toCents } from './hours-time.js';
import type { PayRule, SurchargeKind } from './pay-calculator.js';

type RuleRow = SurchargeRule & { client: { id: string; number: string; name: string } | null };
const WITH_CLIENT = { client: { select: { id: true, number: true, name: true } } } as const;

const WEEKDAYS: readonly string[] = WEEKDAY_CODES;
const WEEK_MINUTES = 7 * MINUTES_PER_DAY;

/**
 * The surcharge rules (Settings → Hours & pay): extra pay for weekend days, public holidays, overtime and evening hours. A rule is a kind, what
 * the kind needs (`conditions`), an amount (a percentage of the hourly rate, or a fixed amount per hour), an optional client, and a switch. The
 * rules that ship with the system are examples and start switched off — nobody is paid a surcharge nobody agreed to.
 */
@Injectable()
export class SurchargeRulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list() {
    const rows = await this.prisma.surchargeRule.findMany({ include: WITH_CLIENT, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
    return rows.map(row => this.serialize(row));
  }

  /** The rules that count, in the shape the calculator wants. */
  async active(): Promise<PayRule[]> {
    const rows = await this.prisma.surchargeRule.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      kind: row.kind as SurchargeKind,
      conditions: (row.conditions ?? {}) as Record<string, unknown>,
      percentBp: row.percent === null ? null : Math.round(row.percent.toNumber() * 100),
      perHourCents: row.amountPerHour === null ? null : toCents(row.amountPerHour.toNumber()),
      clientId: row.clientId,
    }));
  }

  async create(dto: SurchargeRuleDto, user: AuthenticatedUser) {
    const checked = await this.check(dto);
    const last = await this.prisma.surchargeRule.aggregate({ _max: { sortOrder: true } });
    const row = await this.prisma.surchargeRule.create({
      data: { ...checked, note: dto.note?.trim() ?? '', isActive: dto.isActive ?? false, sortOrder: (last._max.sortOrder ?? 0) + 10, createdById: user.id },
      include: WITH_CLIENT,
    });
    await this.audit.log({ action: 'created', entityType: 'surcharge_rule', entityId: row.id, entityLabel: row.name, after: this.snapshot(row) });
    return this.serialize(row);
  }

  async update(id: string, dto: UpdateSurchargeRuleDto) {
    const row = await this.find(id);
    const merged: SurchargeRuleDto = {
      name: dto.name ?? row.name,
      kind: dto.kind ?? (row.kind as SurchargeKind),
      conditions: dto.conditions ?? ((row.conditions ?? {}) as Record<string, unknown>),
      percent: dto.percent !== undefined ? dto.percent : (row.percent?.toNumber() ?? null),
      amountPerHour: dto.amountPerHour !== undefined ? dto.amountPerHour : (row.amountPerHour?.toNumber() ?? null),
      clientId: dto.clientId !== undefined ? dto.clientId : row.clientId,
    };
    const checked = await this.check(merged);
    const data = { ...checked, note: dto.note !== undefined ? dto.note.trim() : row.note, isActive: dto.isActive ?? row.isActive };
    const updated = await this.prisma.surchargeRule.update({ where: { id }, data, include: WITH_CLIENT });
    const diff = this.diff(row, updated);
    if (Object.keys(diff.after).length) {
      const switched = 'isActive' in diff.after;
      await this.audit.log({ action: switched && Object.keys(diff.after).length === 1 ? (updated.isActive ? 'activated' : 'deactivated') : 'updated', entityType: 'surcharge_rule', entityId: id, entityLabel: updated.name, before: diff.before, after: diff.after });
    }
    return this.serialize(updated);
  }

  /** Statements keep the name and the amounts of the rule in their lines, so a rule that is no longer wanted can simply be removed. */
  async remove(id: string) {
    const row = await this.find(id);
    await this.prisma.surchargeRule.delete({ where: { id } });
    await this.audit.log({ action: 'deleted', entityType: 'surcharge_rule', entityId: id, entityLabel: row.name, before: this.snapshot(row) });
    return { deleted: true };
  }

  /* ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  private async find(id: string): Promise<RuleRow> {
    const row = await this.prisma.surchargeRule.findUnique({ where: { id }, include: WITH_CLIENT });
    if (!row) throw new NotFoundException({ code: 'not_found', message: 'Surcharge rule not found' });
    return row;
  }

  /** Checks a rule and returns what is stored; a 422 names every field that is wrong. */
  private async check(dto: SurchargeRuleDto) {
    const problems: Record<string, string> = {};
    if (!dto.name?.trim()) problems.name = 'validation.required';
    const percent = dto.percent ?? null;
    const perHour = dto.amountPerHour ?? null;
    if (percent === null && perHour === null) problems.percent = 'validation.required';
    if (percent !== null && perHour !== null) problems.amountPerHour = 'validation.invalid';
    if (percent !== null && percent <= 0) problems.percent = 'validation.min|{"min":0.01}';
    if (perHour !== null && perHour <= 0) problems.amountPerHour = 'validation.min|{"min":0.01}';

    const raw = dto.conditions ?? {};
    const conditions: Record<string, unknown> = {};
    if (dto.kind === 'weekend') {
      const days = Array.isArray(raw.days) ? raw.days.filter((day): day is string => typeof day === 'string' && WEEKDAYS.includes(day)) : [];
      conditions.days = [...new Set(days)];
    } else if (dto.kind === 'overtime') {
      const after = Number(raw.afterMinutes);
      if (raw.per !== 'day' && raw.per !== 'week') problems.per = 'validation.required';
      if (!Number.isInteger(after) || after < 0 || after > (raw.per === 'week' ? WEEK_MINUTES : MINUTES_PER_DAY)) problems.afterMinutes = 'validation.invalid';
      conditions.per = raw.per;
      conditions.afterMinutes = after;
    } else if (dto.kind === 'evening') {
      const from = parseClock(raw.from);
      const to = parseClock(raw.to);
      if (from === null) problems.from = 'validation.invalid';
      if (to === null) problems.to = 'validation.invalid';
      if (from !== null && to !== null && from === to) problems.to = 'validation.invalid';
      conditions.from = raw.from;
      conditions.to = raw.to;
    }

    const clientId = dto.clientId || null;
    if (clientId && !(await this.prisma.client.findUnique({ where: { id: clientId }, select: { id: true } }))) problems.clientId = 'validation.invalid';
    if (Object.keys(problems).length) throw validationFailed(problems);

    return {
      name: dto.name.trim(),
      kind: dto.kind,
      conditions: conditions as Prisma.InputJsonObject,
      percent: percent === null ? null : new Prisma.Decimal(percent),
      amountPerHour: perHour === null ? null : new Prisma.Decimal(perHour),
      clientId,
    };
  }

  private snapshot(row: RuleRow) {
    return { name: row.name, kind: row.kind, conditions: row.conditions, percent: row.percent?.toNumber() ?? null, amountPerHour: row.amountPerHour?.toNumber() ?? null, client: row.client ? `${row.client.number} – ${row.client.name}` : null, isActive: row.isActive };
  }

  private diff(before: RuleRow, after: RuleRow) {
    return AuditService.changes(this.snapshot(before), this.snapshot(after));
  }

  serialize(row: RuleRow) {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      conditions: (row.conditions ?? {}) as Record<string, unknown>,
      percent: row.percent?.toNumber() ?? null,
      amountPerHour: row.amountPerHour?.toNumber() ?? null,
      client: row.client,
      note: row.note,
      isActive: row.isActive,
      sortOrder: row.sortOrder,
    };
  }
}
