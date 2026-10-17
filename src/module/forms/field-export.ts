import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import type { ExportColumn } from '../../lib/exports/export.types.js';
import { isEmptyValue, type FieldDef } from './form-doc.js';

/** How a form field is written in an exported table (Excel formats numbers, money, dates and yes / no as such). */
export const exportType = (field: FieldDef): ExportColumn['type'] => {
  switch (field.type) {
    case 'number':
      return 'number';
    case 'money':
      return 'money';
    case 'date':
      return 'date';
    case 'boolean':
      return 'boolean';
    default:
      return 'text';
  }
};

export const exportWidth = (field: FieldDef): number => (field.type === 'textarea' ? 40 : field.type === 'boolean' ? 12 : field.type === 'date' ? 14 : field.type === 'select' || field.type === 'multiselect' ? 18 : 22);

/** The name of a choice in the field's pick-list (or its own choices); the code itself when it is not known any more. */
const choiceName = (field: FieldDef, code: string, names: Map<string, Map<string, string>>, locale: AppLocale): string =>
  field.list ? (names.get(field.list)?.get(code) ?? code) : (field.choices.find(choice => choice.code === code)?.names[locale] ?? code);

/**
 * One cell of an export: pick-list codes become names, people become their names, files their file name.
 * `names` holds the pick-lists by key (`list key → code → name`), `userNames` the users by id.
 */
export function exportValue(field: FieldDef, value: unknown, names: Map<string, Map<string, string>>, userNames: Map<string, string>, locale: AppLocale): unknown {
  if (isEmptyValue(value)) return null;
  switch (field.type) {
    case 'select':
      return typeof value === 'string' ? choiceName(field, value, names, locale) : value;
    case 'multiselect':
      return Array.isArray(value) ? value.map(code => (typeof code === 'string' ? choiceName(field, code, names, locale) : code)).join(', ') : value;
    case 'user':
      return typeof value === 'string' ? (userNames.get(value) ?? '') : value;
    case 'file':
      return (value as { name?: string }).name ?? null;
    default:
      return value;
  }
}
