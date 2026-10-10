import { matrixAllows, type PermissionMatrix } from '../roles/permission-catalog.js';
import type { FieldDef, FormDoc } from './form-doc.js';

/**
 * Who may see and change which field. Every answer that carries record values (record, list, export, search, AI) passes through
 * these helpers, so a field limited to people with access to sensitive data (BSN, IBAN, wages) never leaks through a side door.
 */
export const canViewField = (field: FieldDef, matrix: PermissionMatrix): boolean => !field.viewPermission || matrixAllows(matrix, field.viewPermission);

/** Changing a value needs its edit permission and, of course, being able to see it. */
export const canEditField = (field: FieldDef, matrix: PermissionMatrix): boolean => canViewField(field, matrix) && (!field.editPermission || matrixAllows(matrix, field.editPermission));

/** The form as this person gets it: fields they may not see are not even mentioned. */
export const docFor = (doc: FormDoc, matrix: PermissionMatrix): FormDoc => ({ ...doc, fields: doc.fields.filter(field => canViewField(field, matrix)) });

/** The record's values without the fields this person may not see. */
export function valuesFor(doc: FormDoc, data: Record<string, unknown>, matrix: PermissionMatrix): Record<string, unknown> {
  const hidden = new Set(doc.fields.filter(field => !canViewField(field, matrix)).map(field => field.key));
  return Object.fromEntries(Object.entries(data).filter(([key]) => !hidden.has(key)));
}
