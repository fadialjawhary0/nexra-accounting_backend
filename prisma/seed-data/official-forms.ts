import { emptyMapping, type Choice, type FieldMapping, type SourceRef, type TextFormat, type Test } from '../../src/module/official-forms/form-mapping.js';
import type { SampleField, SampleForm } from './official-form-pdfs.js';

/*
 * The library that ships with the system: the six forms the office files with the tax authority (from how it works today, docs/10), each as a made-up fillable example
 * PDF with its mapping already made, and the addresses they are sent to. Everything about the real forms (the numbers on them, where they are published) is public
 * information; no client data is here. The office replaces an example by uploading the official PDF as a new edition.
 */

export interface SeedAddress {
  /** Only for linking a form to its address in this file. */
  key: string;
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
    key: 'wka',
    name: 'Belastingdienst / Centrale Administratieve Processen',
    department: 'Team WKA (g-rekeningen)',
    box: '9048',
    postalCode: '7300 GK',
    city: 'Apeldoorn',
    category: 'tax_authority',
    note: 'Aanvraag en deblokkering van een g-rekening. Bron: de pagina “G-rekening” van de Belastingdienst; controleer het adres altijd op het formulier zelf.',
  },
  {
    key: 'heerlen_100',
    name: 'Belastingdienst',
    box: '100',
    postalCode: '6400 AC',
    city: 'Heerlen',
    category: 'tax_authority',
    note: 'Aanvraag verklaring betalingsgedrag. Bron: de formulierpagina van de Belastingdienst; controleer het adres op het formulier.',
  },
  {
    key: 'heerlen_2892',
    name: 'Belastingdienst',
    box: '2892',
    postalCode: '6401 DJ',
    city: 'Heerlen',
    category: 'tax_authority',
    note: 'Melding loonheffingen. [Aangenomen] Dit adres staat bij verwante meldingen loonheffingen; het staat niet op de formulierpagina zelf — controleer het adres op het formulier.',
  },
  {
    key: 'heerlen_freepost',
    name: 'Belastingdienst',
    box: '21020',
    boxKind: 'freepost',
    postalCode: '6400 XC',
    city: 'Heerlen',
    category: 'tax_authority',
    note: 'Opgaaf rekeningnummer ondernemers (CA 041): een antwoordnummer, je hoeft er geen postzegel op te plakken. Controleer het adres op het formulier.',
  },
  {
    key: 'abn_amro',
    name: 'ABN AMRO Bank N.V.',
    department: 'Processing Business Generic, afdeling Client Services (PAC AA8433)',
    box: '283',
    postalCode: '1000 EA',
    city: 'Amsterdam',
    category: 'bank',
    note: 'De getekende g-rekeningovereenkomst, nadat de Belastingdienst de aanvraag heeft goedgekeurd. Bron: de g-rekeningpagina van ABN AMRO.',
  },
];

interface MappingSpec {
  source: SourceRef;
  format?: TextFormat;
  test?: Test;
  choices?: Choice[];
  fallback?: string;
  required?: boolean;
  hint?: string;
}

type SeedField = SampleField & { map?: MappingSpec };

interface SeedSection {
  title: string;
  fields: SeedField[];
}

export interface SeedForm {
  code: string;
  nameNl: string;
  nameEn: string;
  descriptionNl: string;
  descriptionEn: string;
  authorityCode: string;
  officialUrl: string;
  subject: 'client' | 'person' | 'worker';
  periodKind: 'none' | 'year' | 'range';
  recipient: string | null;
  followUpDays: number | null;
  warnWhenPending: boolean;
  folderCode: string | null;
  sections: SeedSection[];
}

const BASE = 'https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/themaoverstijgend/programmas_en_formulieren/';

const field = (key: string): SourceRef => ({ type: 'field', key });
const ask: SourceRef = { type: 'ask' };
const fixed = (value: string): SourceRef => ({ type: 'fixed', value });
const eq = (value: string): Test => ({ op: 'eq', value });
const choices = (pairs: Array<[string, string]>): Choice[] => pairs.map(([code, option]) => ({ when: eq(code), option }));

const LEGAL_FORMS: Array<[string, string]> = [
  ['eenmanszaak', 'Eenmanszaak'],
  ['vof', 'V.O.F.'],
  ['maatschap', 'Maatschap'],
  ['cv', 'C.V.'],
  ['bv', 'B.V.'],
  ['nv', 'N.V.'],
  ['stichting', 'Stichting'],
  ['vereniging', 'Vereniging'],
  ['cooperatie', 'Coöperatie'],
  ['other', 'Overig'],
];

const BANKS = ['ING', 'ABN AMRO', 'Rabobank', 'SNS Bank', 'ASN Bank', 'RegioBank', 'Triodos Bank', 'bunq', 'Knab', 'Van Lanschot', 'Handelsbanken', 'Overig'];

/** The questions every form ends with. */
const closing = (): SeedField[] => [
  { kind: 'text', name: 'contact_naam', label: 'Naam contactpersoon', map: { source: field('client.contact_person') } },
  { kind: 'text', name: 'contact_telefoon', label: 'Telefoonnummer', half: true, map: { source: field('client.phone_1') } },
  { kind: 'text', name: 'plaats', label: 'Plaats van ondertekening', half: true, map: { source: field('form.place') } },
  { kind: 'text', name: 'datum', label: 'Datum', half: true, map: { source: field('form.today'), format: 'date_dmy' } },
];

const company = (): SeedField[] => [
  { kind: 'text', name: 'bedrijfsnaam', label: 'Naam van de onderneming', map: { source: field('client.name') } },
  { kind: 'text', name: 'kvk_nummer', label: 'KvK-nummer', maxLength: 8, half: true, map: { source: field('client.kvk') } },
  { kind: 'text', name: 'loonheffingennummer', label: 'Loonheffingennummer', half: true, map: { source: field('client.payroll_tax_number') } },
  { kind: 'text', name: 'omzetbelastingnummer', label: 'Omzetbelastingnummer', half: true, map: { source: field('client.vat_number') } },
];

export const SEED_FORMS: SeedForm[] = [
  {
    code: 'melding_loonheffingen',
    nameNl: 'Melding loonheffingen (aanmelding werkgever)',
    nameEn: 'Payroll tax registration (employer registration)',
    descriptionNl: 'Een klant aanmelden als werkgever bij de Belastingdienst. Voor een eenmanszaak komen de naam en het BSN van de eigenaar op het formulier.',
    descriptionEn: 'Register a client as an employer with the tax authority. For a sole proprietorship the owner’s name and BSN go on the form.',
    authorityCode: 'LH 590',
    officialUrl: `${BASE}melding_loonheffingen_aanmelding_werkgever`,
    subject: 'person',
    periodKind: 'none',
    recipient: 'heerlen_2892',
    followUpDays: null,
    warnWhenPending: false,
    folderCode: null,
    sections: [
      {
        title: '1. De onderneming',
        fields: [
          { kind: 'dropdown', name: 'rechtsvorm', label: 'Rechtsvorm', options: LEGAL_FORMS.map(([, name]) => name), map: { source: field('client.legal_form'), choices: choices(LEGAL_FORMS) } },
          { kind: 'text', name: 'bedrijfsnaam', label: 'Naam van de onderneming', map: { source: field('client.name'), required: true } },
          { kind: 'text', name: 'handelsnaam', label: 'Handelsnaam (als die anders is)', map: { source: field('client.trade_name') } },
          { kind: 'text', name: 'kvk_nummer', label: 'KvK-nummer', maxLength: 8, half: true, map: { source: field('client.kvk') } },
          { kind: 'text', name: 'rsin', label: 'RSIN (rechtspersonen)', maxLength: 9, half: true, map: { source: field('client.rsin') } },
          { kind: 'text', name: 'omzetbelastingnummer', label: 'Omzetbelastingnummer', half: true, map: { source: field('client.vat_number') } },
        ],
      },
      {
        title: '2. Het adres van de vestiging',
        fields: [
          { kind: 'text', name: 'straat', label: 'Straat', map: { source: field('client.street') } },
          { kind: 'text', name: 'huisnummer', label: 'Huisnummer', half: true, map: { source: field('client.house_number') } },
          { kind: 'text', name: 'toevoeging', label: 'Toevoeging', half: true, map: { source: field('client.house_number_suffix') } },
          { kind: 'text', name: 'postcode', label: 'Postcode', half: true, map: { source: field('client.postal_code') } },
          { kind: 'text', name: 'plaats_vestiging', label: 'Plaats', map: { source: field('client.city') } },
        ],
      },
      {
        title: '3. De eigenaar (eenmanszaak) of een bestuurder',
        fields: [
          { kind: 'text', name: 'voorletters', label: 'Voorletters', half: true, map: { source: field('person.initials_derived') } },
          { kind: 'text', name: 'voorvoegsel', label: 'Voorvoegsel', half: true, map: { source: field('person.infix') } },
          { kind: 'text', name: 'achternaam', label: 'Achternaam', map: { source: field('person.last_name') } },
          { kind: 'text', name: 'geboortedatum', label: 'Geboortedatum', half: true, map: { source: field('person.date_of_birth'), format: 'date_dmy' } },
          { kind: 'text', name: 'bsn', label: 'Burgerservicenummer (BSN)', maxLength: 9, half: true, map: { source: field('person.bsn'), hint: 'Alleen voor een eenmanszaak. Alleen mensen met toegang tot gevoelige gegevens zien dit nummer.' } },
        ],
      },
      {
        title: '4. Loonheffingen en personeel',
        fields: [
          { kind: 'radio', name: 'tijdvak', label: 'Loontijdvak', options: ['Per week', 'Per vier weken', 'Per maand'], map: { source: field('client.payroll_period'), choices: choices([['week', 'Per week'], ['four_weeks', 'Per vier weken'], ['month', 'Per maand']]) } },
          { kind: 'text', name: 'eerste_werknemer', label: 'Eerste dag dat een werknemer in dienst komt', half: true, map: { source: ask, required: true, hint: 'Typ de datum als dd-mm-jjjj.' } },
          { kind: 'text', name: 'aantal_werknemers', label: 'Verwacht aantal werknemers in de eerste drie maanden', half: true, map: { source: ask } },
          { kind: 'checkbox', name: 'uitzend_payroll', label: 'Er is een uitzend- of payrollovereenkomst', map: { source: ask } },
          { kind: 'checkbox', name: 'premies_werknemersverzekeringen', label: 'De onderneming betaalt premies werknemersverzekeringen', map: { source: ask } },
        ],
      },
      {
        title: '5. De gemachtigde (het kantoor)',
        fields: [
          { kind: 'text', name: 'gemachtigde_naam', label: 'Naam van de gemachtigde', map: { source: field('office.name') } },
          { kind: 'text', name: 'gemachtigde_telefoon', label: 'Telefoonnummer van de gemachtigde', half: true, map: { source: field('office.phone') } },
        ],
      },
      { title: '6. Contact en ondertekening', fields: closing() },
    ],
  },
  {
    code: 'verzoek_deblokkering_g_rekening',
    nameNl: 'Verzoek deblokkering g-rekening',
    nameEn: 'Request to release a G-account',
    descriptionNl: 'Het bedrag vragen dat op de g-rekening van een klant staat en boven wat aan loonheffingen en btw verschuldigd is. Een tweede verzoek wordt niet behandeld zolang een eerste loopt; het duurt ongeveer twee weken.',
    descriptionEn: 'Ask for the amount on a client’s G-account that is more than the payroll tax and VAT owed. A second request is not dealt with while a first one is open; it takes about two weeks.',
    authorityCode: 'CPT 158',
    officialUrl: `${BASE}verzoek_deblokkering_g_rekening`,
    subject: 'client',
    periodKind: 'none',
    recipient: 'wka',
    followUpDays: 14,
    warnWhenPending: true,
    folderCode: 'g_account',
    sections: [
      { title: '1. De aanvrager', fields: company() },
      {
        title: '2. De g-rekening',
        fields: [
          { kind: 'text', name: 'g_rekening', label: 'IBAN van de g-rekening', map: { source: field('client.g_account'), format: 'iban_groups' } },
          { kind: 'dropdown', name: 'bank', label: 'Bank van de g-rekening', options: BANKS, map: { source: field('client.g_account_bank') } },
        ],
      },
      {
        title: '3. Het verzoek',
        fields: [
          { kind: 'text', name: 'bedrag', label: 'Bedrag dat wordt gevraagd (in euro’s)', half: true, map: { source: ask, required: true, hint: 'De Belastingdienst geeft alleen vrij wat boven de verschuldigde loonheffingen en btw uitkomt.' } },
          { kind: 'text', name: 'rekening_uitbetaling', label: 'IBAN waarop het bedrag moet worden overgemaakt', map: { source: field('client.iban_1'), format: 'iban_groups' } },
          { kind: 'text', name: 'toelichting', label: 'Toelichting', multiline: true, map: { source: ask } },
          { kind: 'checkbox', name: 'verrekening_akkoord', label: 'Verrekening met andere schulden bij de Belastingdienst of het UWV is goed', map: { source: fixed('true') } },
        ],
      },
      { title: '4. Contact en ondertekening', fields: closing() },
    ],
  },
  {
    code: 'aanvraag_g_rekening',
    nameNl: 'Aanvraag g-rekening',
    nameEn: 'Application for a G-account',
    descriptionNl: 'Een g-rekening aanvragen voor een klant die personeel uitleent of inleent of die onderaannemer is. Pas als de Belastingdienst de aanvraag goedkeurt, tekent de klant de overeenkomst met de bank.',
    descriptionEn: 'Apply for a G-account for a client that lends or hires staff or works as a subcontractor. Only when the tax authority approves does the client sign the agreement with the bank.',
    authorityCode: 'OV 145',
    officialUrl: `${BASE}aanvraag_g_rekening`,
    subject: 'client',
    periodKind: 'none',
    recipient: 'wka',
    followUpDays: 14,
    warnWhenPending: true,
    folderCode: 'g_account',
    sections: [
      {
        title: '1. De onderneming',
        fields: [
          ...company(),
          { kind: 'text', name: 'straat', label: 'Straat en huisnummer', map: { source: field('client.street_line') } },
          { kind: 'text', name: 'postcode_plaats', label: 'Postcode en plaats', map: { source: field('client.city_line') } },
        ],
      },
      {
        title: '2. De bank',
        fields: [
          { kind: 'dropdown', name: 'bank', label: 'Bank waar de g-rekening komt', options: BANKS, map: { source: field('client.g_account_bank') } },
          { kind: 'text', name: 'bankrekening', label: 'IBAN van de gewone zakelijke rekening', map: { source: field('client.iban_1'), format: 'iban_groups' } },
        ],
      },
      {
        title: '3. Waarom een g-rekening',
        fields: [{ kind: 'radio', name: 'soort', label: 'De onderneming is', options: ['Inlener of aannemer', 'Uitlener of onderaannemer'], map: { source: ask, required: true } }],
      },
      { title: '4. Contact en ondertekening', fields: closing() },
    ],
  },
  {
    code: 'verklaring_betalingsgedrag',
    nameNl: 'Aanvraag verklaring betalingsgedrag (inlenersaansprakelijkheid)',
    nameEn: 'Application for a payment-behaviour declaration (hirer’s liability)',
    descriptionNl: 'De verklaring waarmee een uitlener laat zien dat hij zijn belastingen betaalt. Een inspectie wil er een van maximaal drie maanden oud; zolang er een aanvraag loopt moet je niet opnieuw aanvragen.',
    descriptionEn: 'The declaration with which a staffing company shows that it pays its taxes. An inspection wants one that is at most three months old; do not apply again while a request is open.',
    authorityCode: '',
    officialUrl: `${BASE}aanvraag-verklaring-betalingsgedrag-inlenersaansprakelijkheid`,
    subject: 'client',
    periodKind: 'none',
    recipient: 'heerlen_100',
    followUpDays: 14,
    warnWhenPending: true,
    folderCode: null,
    sections: [
      { title: '1. De uitlener', fields: company() },
      {
        title: '2. Taal en herhaling',
        fields: [
          { kind: 'radio', name: 'taal', label: 'Taal van de verklaring', options: ['Nederlands', 'Engels'], map: { source: fixed('Nederlands') } },
          { kind: 'checkbox', name: 'elke_drie_maanden', label: 'Stuur elke drie maanden vanzelf een nieuwe verklaring', map: { source: ask } },
        ],
      },
      { title: '3. Contact en ondertekening', fields: closing() },
    ],
  },
  {
    code: 'opgaaf_rekeningnummer',
    nameNl: 'Opgaaf rekeningnummer ondernemers',
    nameEn: 'Notification of a bank account number (businesses)',
    descriptionNl: 'Het rekeningnummer doorgeven waarop de Belastingdienst uitbetaalt en afschrijft. Eén formulier voor één rekening; voor een eenmanszaak staat het BSN van de eigenaar op het formulier, voor een rechtspersoon het RSIN.',
    descriptionEn: 'Tell the tax authority which bank account it pays out to and debits. One form per account; the owner’s BSN goes on it for a sole proprietorship, the RSIN for a legal entity.',
    authorityCode: 'CA 041',
    officialUrl: `${BASE}opgaaf-rekeningnummer-ondernemers`,
    subject: 'person',
    periodKind: 'none',
    recipient: 'heerlen_freepost',
    followUpDays: 21,
    warnWhenPending: false,
    folderCode: null,
    sections: [
      {
        title: '1. Wie',
        fields: [
          { kind: 'text', name: 'naam_onderneming', label: 'Naam van de onderneming', map: { source: field('client.name') } },
          { kind: 'text', name: 'bsn', label: 'BSN (eenmanszaak, zelfstandige)', maxLength: 9, half: true, map: { source: field('person.bsn'), hint: 'Alleen voor een eenmanszaak.' } },
          { kind: 'text', name: 'rsin', label: 'RSIN (rechtspersoon, maatschap, v.o.f., c.v.)', maxLength: 9, half: true, map: { source: field('client.rsin') } },
        ],
      },
      {
        title: '2. Het rekeningnummer',
        fields: [
          { kind: 'text', name: 'iban', label: 'IBAN (alleen een betaalrekening)', map: { source: field('client.iban_1'), format: 'compact' } },
          { kind: 'text', name: 'tenaamstelling', label: 'Op naam van', map: { source: field('client.name') } },
          { kind: 'text', name: 'ingangsdatum', label: 'Gebruiken vanaf', half: true, map: { source: ask, hint: 'Typ de datum als dd-mm-jjjj; laat leeg voor zo snel mogelijk.' } },
        ],
      },
      { title: '3. Contact en ondertekening', fields: closing() },
    ],
  },
  {
    code: 'aanvraag_uitstel',
    nameNl: 'Aanvraag uitstel',
    nameEn: 'Request for an extension',
    descriptionNl: 'Uitstel vragen voor het indienen van een aangifte (inkomstenbelasting, vennootschapsbelasting of omzetbelasting) over een jaar. Dit voorbeeld is een eigen opzet: vervang het door het formulier dat de Belastingdienst voor dit uitstel gebruikt.',
    descriptionEn: 'Ask for an extension to file a return (income tax, corporate tax or VAT) for a year. This example is our own layout: replace it with the form the tax authority uses for this extension.',
    authorityCode: '',
    officialUrl: '',
    subject: 'client',
    periodKind: 'year',
    recipient: null,
    followUpDays: null,
    warnWhenPending: false,
    folderCode: null,
    sections: [
      {
        title: '1. De aangifte',
        fields: [
          { kind: 'text', name: 'bedrijfsnaam', label: 'Naam van de klant', map: { source: field('client.name') } },
          { kind: 'text', name: 'kvk_nummer', label: 'KvK-nummer', maxLength: 8, half: true, map: { source: field('client.kvk') } },
          { kind: 'radio', name: 'soort', label: 'Soort aangifte', options: ['Inkomstenbelasting', 'Vennootschapsbelasting', 'Omzetbelasting'], map: { source: ask, required: true } },
          { kind: 'text', name: 'jaar', label: 'Over het jaar', half: true, map: { source: field('period.year') } },
        ],
      },
      {
        title: '2. Het verzoek',
        fields: [
          { kind: 'text', name: 'gewenste_datum', label: 'Uitstel tot en met', half: true, map: { source: ask, required: true, hint: 'Typ de datum als dd-mm-jjjj.' } },
          { kind: 'text', name: 'reden', label: 'Reden van het verzoek', multiline: true, map: { source: ask } },
          { kind: 'text', name: 'gemachtigde', label: 'Gemachtigde', map: { source: field('office.name') } },
        ],
      },
      { title: '3. Contact en ondertekening', fields: closing() },
    ],
  },
];

/** The example PDF of a form. */
export const sampleOf = (form: SeedForm): SampleForm => ({
  title: form.nameNl,
  code: form.authorityCode ? `Formuliercode ${form.authorityCode} (voorbeeld)` : 'Voorbeeld',
  sections: form.sections.map(section => ({
    title: section.title,
    fields: section.fields.map(({ map: _map, ...rest }) => rest as SampleField),
  })),
});

/** The mapping of an example: what goes into each field. */
export const mappingOf = (form: SeedForm): FieldMapping[] =>
  form.sections.flatMap(section =>
    section.fields.flatMap(entry =>
      entry.map
        ? [
            {
              ...emptyMapping(entry.name),
              label: entry.label,
              section: section.title,
              source: entry.map.source,
              format: entry.map.format ?? 'as_is',
              test: entry.kind === 'checkbox' ? (entry.map.test ?? null) : null,
              choices: entry.map.choices ?? [],
              fallback: entry.map.fallback ?? '',
              required: entry.map.required ?? false,
              hint: entry.map.hint ?? '',
            } satisfies FieldMapping,
          ]
        : [],
    ),
  );
