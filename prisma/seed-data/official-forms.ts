/*
 * The addresses the office often sends forms to (from how it works today, docs/10): public addresses of the tax authority and a bank; no client data is here. The forms
 * themselves are not shipped: the office uploads its own PDFs (Ahmad's notes, 06-11-2026).
 */

export interface SeedAddress {
  name: string;
  department?: string;
  box?: string;
  boxKind?: 'po_box' | 'freepost';
  postalCode: string;
  city: string;
  category: 'tax_authority' | 'bank' | 'other';
  note: string;
}

export const SEED_ADDRESSES: SeedAddress[] = [
  {
    name: 'Belastingdienst / Centrale Administratieve Processen',
    department: 'Team WKA (g-rekeningen)',
    box: '9048',
    postalCode: '7300 GK',
    city: 'Apeldoorn',
    category: 'tax_authority',
    note: 'Aanvraag en deblokkering van een g-rekening. Bron: de pagina “G-rekening” van de Belastingdienst; controleer het adres altijd op het formulier zelf.',
  },
  {
    name: 'Belastingdienst',
    box: '100',
    postalCode: '6400 AC',
    city: 'Heerlen',
    category: 'tax_authority',
    note: 'Aanvraag verklaring betalingsgedrag. Bron: de formulierpagina van de Belastingdienst; controleer het adres op het formulier.',
  },
  {
    name: 'Belastingdienst',
    box: '2892',
    postalCode: '6401 DJ',
    city: 'Heerlen',
    category: 'tax_authority',
    note: 'Melding loonheffingen. [Aangenomen] Dit adres staat bij verwante meldingen loonheffingen; het staat niet op de formulierpagina zelf — controleer het adres op het formulier.',
  },
  {
    name: 'Belastingdienst',
    box: '21020',
    boxKind: 'freepost',
    postalCode: '6400 XC',
    city: 'Heerlen',
    category: 'tax_authority',
    note: 'Opgaaf rekeningnummer ondernemers (CA 041): een antwoordnummer, je hoeft er geen postzegel op te plakken. Controleer het adres op het formulier.',
  },
  {
    name: 'ABN AMRO Bank N.V.',
    department: 'Processing Business Generic, afdeling Client Services (PAC AA8433)',
    box: '283',
    postalCode: '1000 EA',
    city: 'Amsterdam',
    category: 'bank',
    note: 'De getekende g-rekeningovereenkomst, nadat de Belastingdienst de aanvraag heeft goedgekeurd. Bron: de g-rekeningpagina van ABN AMRO.',
  },
];
