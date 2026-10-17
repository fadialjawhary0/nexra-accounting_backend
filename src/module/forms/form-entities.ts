import type { Named } from './form-doc.js';

/**
 * The records that have an editable form. Each feature phase adds its entity here (employee in Phase 7, contract in Phase 8 …) and
 * seeds its first definition (prisma/seed-data/forms.ts). `area` is the permission area that guards the records of the entity.
 */
export interface FormEntity {
  names: Named;
  description: Named;
  area: string;
  /** Other permission areas whose people also fill in this form (the person form is used for workers too). */
  alsoViewableBy?: readonly string[];
}

export const FORM_ENTITIES: Record<string, FormEntity> = {
  client: {
    names: { nl: 'Klant', en: 'Client' },
    description: { nl: 'De gegevens van een klant: bedrijf, adres, bank, btw en alles wat Ahmad er zelf bij wil.', en: 'A client’s details: company, address, bank, VAT and anything else the office wants to record.' },
    area: 'clients',
  },
  person: {
    names: { nl: 'Persoon', en: 'Person' },
    description: { nl: 'De gegevens van een mens: eigenaren, bestuurders, vennoten, contactpersonen en werknemers.', en: 'The details of a human being: owners, directors, partners, contact persons and employees.' },
    area: 'clients',
    alsoViewableBy: ['employees'],
  },
  employee: {
    names: { nl: 'Werknemer', en: 'Employee' },
    description: { nl: 'Het dienstverband van een werknemer bij een klant: functie, data in en uit dienst, uurloon en alles wat Ahmad er zelf bij wil.', en: 'An employee’s employment at a client: function, start and end date, hourly rate and anything else the office wants to record.' },
    area: 'employees',
  },
  contract: {
    names: { nl: 'Contract', en: 'Contract' },
    description: { nl: 'De afspraken van een arbeidsovereenkomst: type, looptijd, werktijden, loon en alles wat Ahmad er zelf bij wil. De velden worden ook samenvoegvelden voor de Word-sjablonen.', en: 'The terms of an employment contract: type, term, working hours, wage and anything else the office wants to record. The fields also become merge fields for the Word templates.' },
    area: 'contracts',
  },
  hour_entry: {
    names: { nl: 'Uren', en: 'Hours' },
    description: { nl: 'De gegevens bij een dag werken: waar het werk is gedaan, voor welke inlener, welke opdracht en een opmerking. De uren zelf en de begin- en eindtijd staan altijd op het scherm.', en: 'The details of a day of work: where it was done, for which hirer, which assignment and a note. The hours themselves and the start and end time are always on the screen.' },
    area: 'hours',
  },
  counterparty: {
    names: { nl: 'Bedrijf (uitzendbureau of inlener)', en: 'Company (staffing company or hirer)' },
    description: { nl: 'Een bedrijf dat geen klant is maar wel in de keten zit: het uitzendbureau dat werknemers levert of het bedrijf dat werknemers inhuurt. De gegevens komen op facturen en brieven.', en: 'A company that is not a client but is part of the chain: the staffing company that supplies workers, or the company that hires them. The details go on invoices and letters.' },
    area: 'invoices',
  },
  invoice: {
    names: { nl: 'Factuur', en: 'Invoice' },
    description: { nl: 'De gegevens van een factuur naast wat het systeem zelf nodig heeft (klant, bedrijf, data, regels, btw en bedragen): referentie, opdracht en opmerking. De velden worden samenvoegvelden voor het factuursjabloon.', en: 'An invoice’s details besides what the system needs itself (client, company, dates, lines, VAT and amounts): reference, assignment and remark. The fields become merge fields for the invoice template.' },
    area: 'invoices',
  },
};

export const FORM_ENTITY_KEYS = Object.keys(FORM_ENTITIES);

/** Keys a custom field may never take: they are columns or bookkeeping of the record itself. */
export const RESERVED_FIELD_KEYS: ReadonlySet<string> = new Set(['id', 'data', 'created_at', 'updated_at', 'is_active', 'search_text', 'created_by', 'deleted_at']);
