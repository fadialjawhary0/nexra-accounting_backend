import { Injectable, NotFoundException } from '@nestjs/common';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import { validationFailed } from '../../common/validation/failure.js';
import { Prisma, type DocumentType, type RequiredDocument } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { checkCondition } from '../forms/condition-check.js';
import { isEncryptedField, type Condition, type FieldDef } from '../forms/form-doc.js';
import { FormsService } from '../forms/forms.service.js';
import { REQUIREMENT_FORMS, type RequirementScope } from './document-settings.constants.js';
import { DocumentTypesService } from './document-types.service.js';
import type { RequiredDocumentDto } from './dto/document-settings.dto.js';

const ENTITY = 'required_document';

type Row = RequiredDocument & { type: DocumentType };

/** A field of one of the forms as the rule editor offers it: its key carries the form it belongs to (`person.permit_type`). */
export interface RuleField {
  key: string;
  form: string;
  type: FieldDef['type'];
  labels: FieldDef['labels'];
  list: string | null;
  choices: FieldDef['choices'];
}

/**
 * "A client / worker needs a current document of this type" (Settings → Documents → Required documents). A rule names a type, who it is for and —
 * optionally — a condition in the form builder's language over fields of the client, the worker and the person (`person.permit_type` filled in →
 * a residence permit is needed). The rules are only data; what is missing is worked out against the files every time somebody looks.
 */
@Injectable()
export class RequiredDocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly forms: FormsService,
    private readonly types: DocumentTypesService,
  ) {}

  /* ── Reading ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  /** The fields a rule may look at: active fields of the client, employee and person forms whose value is not encrypted. */
  async fields(scope: RequirementScope | null): Promise<RuleField[]> {
    const out: RuleField[] = [];
    for (const form of REQUIREMENT_FORMS) {
      if (scope && !(form.scopes as readonly string[]).includes(scope)) continue;
      const { doc } = await this.forms.live(form.entity);
      for (const field of doc.fields) {
        if (!field.active || isEncryptedField(field) || field.type === 'file' || field.type === 'textarea') continue;
        out.push({ key: `${form.prefix}${field.key}`, form: form.entity, type: field.type, labels: field.labels, list: field.list, choices: field.choices });
      }
    }
    return out;
  }

  async list(locale: AppLocale) {
    const rows = await this.prisma.requiredDocument.findMany({ include: { type: true }, orderBy: [{ scope: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }] });
    return rows.map(row => this.view(row, locale));
  }

  /** The rules in force, for the check against the files. */
  async active(): Promise<Row[]> {
    const rows = await this.prisma.requiredDocument.findMany({ where: { isActive: true, type: { isActive: true } }, include: { type: true }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
    return rows;
  }

  view(row: Row, locale: AppLocale) {
    return {
      id: row.id,
      typeCode: row.typeCode,
      typeName: DocumentTypesService.nameIn(row.type, locale),
      scope: row.scope,
      condition: row.condition,
      note: row.note,
      order: row.sortOrder,
      isActive: row.isActive,
    };
  }

  /* ── Changing ─────────────────────────────────────────────────────────────────────────────────────────────────── */

  async create(dto: RequiredDocumentDto, locale: AppLocale) {
    const checked = await this.checked(dto);
    const last = await this.prisma.requiredDocument.aggregate({ where: { scope: checked.scope }, _max: { sortOrder: true } });
    const row = await this.prisma.requiredDocument.create({ data: { ...checked, sortOrder: (last._max.sortOrder ?? 0) + 10 }, include: { type: true } });
    await this.audit.log({ action: 'created', entityType: ENTITY, entityId: row.id, entityLabel: this.label(row), after: this.snapshot(row) });
    return this.view(row, locale);
  }

  async update(id: string, dto: RequiredDocumentDto, locale: AppLocale) {
    const row = await this.rowOrThrow(id);
    const checked = await this.checked(dto);
    const updated = await this.prisma.requiredDocument.update({ where: { id }, data: checked, include: { type: true } });
    const diff = AuditService.changes(this.snapshot(row), this.snapshot(updated));
    if (Object.keys(diff.after).length) await this.audit.log({ action: 'updated', entityType: ENTITY, entityId: id, entityLabel: this.label(updated), before: diff.before, after: diff.after });
    return this.view(updated, locale);
  }

  async setActive(id: string, active: boolean, locale: AppLocale) {
    const row = await this.rowOrThrow(id);
    if (row.isActive === active) return this.view(row, locale);
    const updated = await this.prisma.requiredDocument.update({ where: { id }, data: { isActive: active }, include: { type: true } });
    await this.audit.log({ action: active ? 'activated' : 'deactivated', entityType: ENTITY, entityId: id, entityLabel: this.label(row) });
    return this.view(updated, locale);
  }

  /** A rule holds no history (what is missing is never stored), so it can be deleted; the audit log remembers it. */
  async remove(id: string): Promise<void> {
    const row = await this.rowOrThrow(id);
    await this.prisma.requiredDocument.delete({ where: { id } });
    await this.audit.log({ action: 'deleted', entityType: ENTITY, entityId: id, entityLabel: this.label(row), before: this.snapshot(row) });
  }

  /* ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  private async rowOrThrow(id: string): Promise<Row> {
    const row = await this.prisma.requiredDocument.findUnique({ where: { id }, include: { type: true } });
    if (!row) throw new NotFoundException({ code: 'not_found', message: 'Rule not found' });
    return row;
  }

  private label(row: Row): string {
    return `${row.scope === 'client' ? 'Klant' : 'Werknemer'}: ${row.type.nameNl}`;
  }

  private snapshot(row: Row): Record<string, unknown> {
    return { typeCode: row.typeCode, scope: row.scope, condition: row.condition, note: row.note };
  }

  /** The type exists, fits the scope and the condition only looks at fields of the forms that belong to the scope. */
  private async checked(dto: RequiredDocumentDto) {
    const problems: Record<string, string> = {};
    const scope = dto.scope as RequirementScope;
    const type = await this.types.byCode(dto.typeCode);
    if (!type || !type.isActive) problems.typeCode = 'validation.invalid';
    else if (type.scope !== 'any' && type.scope !== scope) problems.scope = 'validation.invalid';

    let condition: Condition | null = null;
    if (dto.condition && Object.keys(dto.condition).length) {
      const known = new Set((await this.fields(scope)).map(field => field.key));
      condition = checkCondition(dto.condition, known);
      if (!condition) problems.condition = 'validation.invalid';
    }
    if (Object.keys(problems).length) throw validationFailed(problems);
    return { typeCode: dto.typeCode, scope, condition: condition ? (condition as unknown as Prisma.InputJsonValue) : Prisma.DbNull, note: (dto.note ?? '').trim() } satisfies Prisma.RequiredDocumentUncheckedCreateInput;
  }

}
