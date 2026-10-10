import type { Named } from './form-doc.js';

/**
 * The records that have an editable form. Each feature phase adds its entity here (employee in Phase 7, contract in Phase 8 …) and
 * seeds its first definition (prisma/seed-data/forms.ts). `area` is the permission area that guards the records of the entity.
 */
export interface FormEntity {
  names: Named;
  description: Named;
  area: string;
}

export const FORM_ENTITIES: Record<string, FormEntity> = {
  client: {
    names: { nl: 'Klant', en: 'Client' },
    description: { nl: 'De gegevens van een klant: bedrijf, adres, bank, btw en alles wat Ahmad er zelf bij wil.', en: 'A client’s details: company, address, bank, VAT and anything else the office wants to record.' },
    area: 'companies',
  },
  person: {
    names: { nl: 'Persoon', en: 'Person' },
    description: { nl: 'Eigenaren, bestuurders, vennoten en contactpersonen van een klant.', en: 'Owners, directors, partners and contact persons of a client.' },
    area: 'companies',
  },
};

export const FORM_ENTITY_KEYS = Object.keys(FORM_ENTITIES);

/** Keys a custom field may never take: they are columns or bookkeeping of the record itself. */
export const RESERVED_FIELD_KEYS: ReadonlySet<string> = new Set(['id', 'data', 'created_at', 'updated_at', 'is_active', 'search_text', 'created_by', 'deleted_at']);
