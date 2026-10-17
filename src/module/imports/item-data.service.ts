import { Injectable } from '@nestjs/common';
import { valuesFor } from '../forms/field-access.js';
import type { FormDoc } from '../forms/form-doc.js';
import { FormRecordsService } from '../forms/form-records.service.js';
import { FormsService } from '../forms/forms.service.js';
import type { PermissionMatrix } from '../roles/permission-catalog.js';
import type { ItemConfidence, ItemSections } from './imports.constants.js';

/** The sections of an item that are a record with an admin-defined form (the others — the file, hours, invoice lines — are plain). */
export const FORM_SECTIONS = ['client', 'person', 'employee', 'contract', 'invoice'] as const;

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/**
 * What an import item holds: the values read from a file or a row, per record, keyed by the field keys of that record's form. A value of a
 * restricted field (BSN, IBAN, document number …) is stored encrypted exactly like in the records themselves, and is only shown to people who may
 * see that field. Nothing here is a record yet — accepting the item is what saves it.
 */
@Injectable()
export class ItemDataService {
  constructor(
    private readonly forms: FormsService,
    private readonly records: FormRecordsService,
  ) {}

  /** The live form of each section that has one. */
  async docs(sections: readonly string[] = FORM_SECTIONS): Promise<Record<string, FormDoc>> {
    const entries = await Promise.all(sections.filter(section => (FORM_SECTIONS as readonly string[]).includes(section)).map(async section => [section, (await this.forms.live(section)).doc] as const));
    return Object.fromEntries(entries);
  }

  /** What is stored: values of encrypted fields are encrypted. */
  async seal(data: ItemSections): Promise<ItemSections> {
    const docs = await this.docs(Object.keys(data));
    return Object.fromEntries(Object.entries(data).map(([section, values]) => [section, docs[section] ? this.records.encode(docs[section], values) : values]));
  }

  /** What was stored, readable again (a value that cannot be decrypted any more is left out). */
  open(stored: unknown): ItemSections {
    return Object.fromEntries(Object.entries(asRecord(stored)).map(([section, values]) => [section, this.records.decode(asRecord(values))]));
  }

  /** The item as one person may see it: fields their role may not view are left out of the values and the confidence. */
  async visible(data: ItemSections, confidence: ItemConfidence, matrix: PermissionMatrix): Promise<{ data: ItemSections; confidence: ItemConfidence }> {
    const docs = await this.docs(Object.keys(data));
    const shown: ItemSections = {};
    const sure: ItemConfidence = {};
    for (const [section, values] of Object.entries(data)) {
      const doc = docs[section];
      shown[section] = doc ? valuesFor(doc, values, matrix) : values;
      const scores = confidence[section] ?? {};
      sure[section] = Object.fromEntries(Object.entries(scores).filter(([key]) => key in shown[section]!));
    }
    return { data: shown, confidence: sure };
  }

  /** `data` with a patch applied per section: a `null` value removes the key; a section the patch does not mention stays as it is. */
  static merge(data: ItemSections, patch: ItemSections): ItemSections {
    const merged: ItemSections = Object.fromEntries(Object.entries(data).map(([section, values]) => [section, { ...values }]));
    for (const [section, values] of Object.entries(patch)) {
      const target = (merged[section] ??= {});
      for (const [key, value] of Object.entries(values)) {
        if (value === null || value === undefined || value === '') delete target[key];
        else target[key] = value;
      }
    }
    return merged;
  }

  /** Values only the fields of the person's own form may change (keys the form does not know are refused). */
  async onlyKnownKeys(patch: ItemSections): Promise<ItemSections> {
    const docs = await this.docs(Object.keys(patch));
    const clean: ItemSections = {};
    for (const [section, values] of Object.entries(patch)) {
      const doc = docs[section];
      const known = doc ? new Set(doc.fields.map(field => field.key)) : null;
      clean[section] = known ? Object.fromEntries(Object.entries(values).filter(([key]) => known.has(key))) : values;
    }
    return clean;
  }
}
