import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '../../lib/database/prisma.service.js';
import type { PermissionMatrix } from '../roles/permission-catalog.js';
import { canEditField, canViewField } from './field-access.js';
import type { FormDoc } from './form-doc.js';
import { validateValues, type ValueResult } from './form-values.js';
import { FormsService } from './forms.service.js';

/**
 * Checks the values of a record against its form: formats, choices, required fields, rules that hide fields, files, and who may change
 * which field. Every module that saves records with admin-defined fields (clients, employees, contracts …) calls this one service.
 */
@Injectable()
export class FormValidationService {
  constructor(
    private readonly forms: FormsService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * `patch` = what was submitted, `existing` = the record's `data` so far. Returns the cleaned values to merge into `data` and the
   * errors per field. Pass `doc` to check against another document than the live one (the form builder's "try it").
   */
  async check(entity: string, patch: Record<string, unknown>, existing: Record<string, unknown>, matrix: PermissionMatrix, doc?: FormDoc): Promise<ValueResult> {
    const form = doc ?? (await this.forms.live(entity)).doc;
    const fields = form.fields.filter(field => field.active);

    const listKeys = [...new Set(fields.filter(field => (field.type === 'select' || field.type === 'multiselect') && field.list).map(field => field.list as string))];
    const items = listKeys.length ? await this.prisma.listItem.findMany({ where: { isActive: true, list: { key: { in: listKeys } } }, select: { code: true, list: { select: { key: true } } } }) : [];
    const lists = new Map<string, Set<string>>();
    for (const item of items) lists.set(item.list.key, (lists.get(item.list.key) ?? new Set()).add(item.code));

    const fileIds = fields
      .filter(field => field.type === 'file')
      .map(field => (patch[field.key] as { id?: unknown } | null | undefined)?.id)
      .filter((id): id is string => typeof id === 'string');
    const files = fileIds.length ? await this.prisma.storedFile.findMany({ where: { id: { in: fileIds }, isActive: true }, select: { id: true, name: true, size: true, mimeType: true } }) : [];

    const users = fields.some(field => field.type === 'user') ? await this.prisma.user.findMany({ where: { status: 'active' }, select: { id: true } }) : [];

    return validateValues(form, patch, existing, {
      lists,
      files: new Map(files.map(file => [file.id, file])),
      users: new Set(users.map(user => user.id)),
      canView: field => canViewField(field, matrix),
      canEdit: field => canEditField(field, matrix),
    });
  }

  /** Same, but answers a 422 with `fields` (message keys per field) when something is wrong. */
  async checkOrThrow(entity: string, patch: Record<string, unknown>, existing: Record<string, unknown>, matrix: PermissionMatrix): Promise<Record<string, unknown>> {
    const { values, errors } = await this.check(entity, patch, existing, matrix);
    if (Object.keys(errors).length) throw new UnprocessableEntityException({ code: 'validation_failed', message: 'Validation failed', fields: errors });
    return values;
  }
}
