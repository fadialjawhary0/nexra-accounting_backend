import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import { fold } from '../../common/text.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { validationFailed } from '../../common/validation/failure.js';
import type { VatStep } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import type { CreateVatStepDto, UpdateVatStepDto } from './dto/taxes.dto.js';
import { VAT_STEP_ENTITY } from './taxes.constants.js';
import { readTicks } from './vat-ticks.js';

const slug = (text: string): string =>
  fold(text)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);

export interface VatStepView {
  id: string;
  code: string;
  name: string;
  group: string;
  nameNl: string;
  nameEn: string;
  groupNl: string;
  groupEn: string;
  isFiling: boolean;
  isActive: boolean;
  sortOrder: number;
}

/**
 * The steps of the VAT tracker (the columns of the office's quarter sheet). The office edits them in Settings → Taxes: rename, regroup, reorder, add one, switch one off.
 * A period remembers what was ticked by the code of the step, so none of that rewrites history; a step that is switched off no longer counts for "complete".
 */
@Injectable()
export class VatStepsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  all(): Promise<VatStep[]> {
    return this.prisma.vatStep.findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
  }

  active(): Promise<VatStep[]> {
    return this.prisma.vatStep.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
  }

  view(step: VatStep, locale: AppLocale): VatStepView {
    return {
      id: step.id,
      code: step.code,
      name: locale === 'nl' ? step.nameNl : step.nameEn,
      group: locale === 'nl' ? step.groupNl : step.groupEn,
      nameNl: step.nameNl,
      nameEn: step.nameEn,
      groupNl: step.groupNl,
      groupEn: step.groupEn,
      isFiling: step.isFiling,
      isActive: step.isActive,
      sortOrder: step.sortOrder,
    };
  }

  /** Every step, switched-off ones included, for the settings screen. */
  async list(locale: AppLocale) {
    return (await this.all()).map(step => this.view(step, locale));
  }

  private async findOrThrow(id: string): Promise<VatStep> {
    const step = await this.prisma.vatStep.findUnique({ where: { id } });
    if (!step) throw new NotFoundException({ code: 'not_found', message: 'VAT step not found' });
    return step;
  }

  private async freeCode(base: string): Promise<string> {
    const taken = new Set((await this.prisma.vatStep.findMany({ select: { code: true } })).map(step => step.code));
    const start = base || 'step';
    if (!taken.has(start)) return start;
    for (let number = 2; number < 200; number += 1) if (!taken.has(`${start}_${number}`)) return `${start}_${number}`;
    return `${start}_${Date.now()}`;
  }

  async create(dto: CreateVatStepDto, user: AuthenticatedUser, locale: AppLocale) {
    const problems: Record<string, string> = {};
    const nameNl = dto.nameNl.trim();
    const nameEn = dto.nameEn.trim();
    if (!nameNl) problems.nameNl = 'validation.required';
    if (!nameEn) problems.nameEn = 'validation.required';
    if (Object.keys(problems).length) throw validationFailed(problems);
    const groupNl = dto.groupNl?.trim() ?? '';
    const groupEn = dto.groupEn?.trim() ?? '';
    const code = await this.freeCode(slug(`${groupEn} ${nameEn}`));
    const last = await this.prisma.vatStep.aggregate({ _max: { sortOrder: true } });
    const step = await this.prisma.vatStep.create({ data: { code, nameNl, nameEn, groupNl, groupEn, isFiling: dto.isFiling ?? false, sortOrder: (last._max.sortOrder ?? 0) + 10, createdById: user.id } });
    await this.audit.log({ action: 'created', entityType: VAT_STEP_ENTITY, entityId: step.id, entityLabel: `${groupNl ? `${groupNl} – ` : ''}${nameNl}`, after: { code, nameNl, nameEn, groupNl, groupEn, isFiling: step.isFiling } });
    return this.view(step, locale);
  }

  async update(id: string, dto: UpdateVatStepDto, user: AuthenticatedUser, locale: AppLocale) {
    const step = await this.findOrThrow(id);
    const problems: Record<string, string> = {};
    const nameNl = dto.nameNl === undefined ? step.nameNl : dto.nameNl.trim();
    const nameEn = dto.nameEn === undefined ? step.nameEn : dto.nameEn.trim();
    if (!nameNl) problems.nameNl = 'validation.required';
    if (!nameEn) problems.nameEn = 'validation.required';
    if (Object.keys(problems).length) throw validationFailed(problems);
    if (dto.isActive === false && step.isActive && (await this.prisma.vatStep.count({ where: { isActive: true, NOT: { id } } })) === 0) {
      throw new ConflictException({ code: 'vat_steps_last', message: 'The tracker needs at least one step.' });
    }

    const next = {
      nameNl,
      nameEn,
      groupNl: dto.groupNl === undefined ? step.groupNl : dto.groupNl.trim(),
      groupEn: dto.groupEn === undefined ? step.groupEn : dto.groupEn.trim(),
      isFiling: dto.isFiling ?? step.isFiling,
      isActive: dto.isActive ?? step.isActive,
    };
    const diff = AuditService.changes({ nameNl: step.nameNl, nameEn: step.nameEn, groupNl: step.groupNl, groupEn: step.groupEn, isFiling: step.isFiling, isActive: step.isActive }, next);
    if (!Object.keys(diff.after).length) return this.view(step, locale);

    const activeChanged = next.isActive !== step.isActive;
    const updated = await this.prisma.vatStep.update({
      where: { id },
      data: { ...next, ...(activeChanged && (next.isActive ? { deactivatedAt: null, deactivatedById: null } : { deactivatedAt: new Date(), deactivatedById: user.id })) },
    });
    await this.audit.log({
      action: activeChanged ? (next.isActive ? 'activated' : 'deactivated') : 'updated',
      entityType: VAT_STEP_ENTITY,
      entityId: id,
      entityLabel: `${step.groupNl ? `${step.groupNl} – ` : ''}${step.nameNl}`,
      before: diff.before,
      after: diff.after,
    });
    // A period whose only missing step was switched off is complete now.
    if (activeChanged) await this.recompute();
    return this.view(updated, locale);
  }

  async reorder(ids: string[], locale: AppLocale) {
    const steps = await this.all();
    const known = new Set(steps.map(step => step.id));
    if (ids.some(id => !known.has(id))) throw validationFailed({ ids: 'validation.invalid' });
    // The steps that were not named keep their order, after the named ones.
    const order = [...new Set([...ids, ...steps.map(step => step.id)])];
    const before = steps.map(step => step.code);
    await this.prisma.$transaction(order.map((id, index) => this.prisma.vatStep.update({ where: { id }, data: { sortOrder: (index + 1) * 10 } })));
    const after = await this.all();
    const changed = JSON.stringify(before) !== JSON.stringify(after.map(step => step.code));
    if (changed) await this.audit.log({ action: 'updated', entityType: VAT_STEP_ENTITY, entityLabel: 'order', before: { order: before }, after: { order: after.map(step => step.code) } });
    return after.map(step => this.view(step, locale));
  }

  /**
   * Looks at every period that is not complete: when every step that counts now is ticked, it is complete (after a step was switched off). Periods that were complete stay
   * complete — adding a step never reopens a quarter that was filed.
   */
  async recompute(): Promise<number> {
    const codes = (await this.active()).map(step => step.code);
    const open = await this.prisma.vatPeriod.findMany({ where: { completedAt: null, isActive: true }, select: { id: true, ticks: true } });
    const ready = open.filter(row => {
      const ticks = readTicks(row.ticks);
      return codes.every(code => ticks[code]);
    });
    if (!ready.length) return 0;
    await this.prisma.vatPeriod.updateMany({ where: { id: { in: ready.map(row => row.id) } }, data: { completedAt: new Date() } });
    return ready.length;
  }
}
