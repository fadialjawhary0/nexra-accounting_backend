import { emptyDoc, type Condition, type FieldDef, type FieldFlags, type FieldType, type FormDoc, type Named, type SectionDef } from '../../src/module/forms/form-doc.js';

/**
 * The first form definitions, from Ahmad's own field list (docs/12) plus what his forms and inspections need. They are only *created* by
 * the seed: once a form exists, the form builder owns it (renames, new fields, reordering are never overwritten).
 * Every field has a stable `key` (what records store), labels in Dutch and English, and an optional rule that shows it only for some
 * legal forms. `system` fields are the ones the logic reads: they can be renamed, moved and hidden, never deleted or retyped.
 */
const named = (nl: string, en: string): Named => ({ nl, en });

interface FieldOptions {
  kind?: FieldDef['kind'];
  required?: boolean;
  locked?: boolean;
  width?: FieldDef['width'];
  list?: string;
  choices?: Array<[code: string, nl: string, en: string]>;
  help?: Named;
  placeholder?: Named;
  showWhen?: Condition;
  sensitive?: boolean;
  default?: FieldDef['default'];
  validation?: FieldDef['validation'];
  flags?: Partial<FieldFlags>;
}

const NO_FLAGS: FieldFlags = { list: false, filter: false, export: true, search: false, unique: false, complete: false };

class FormBuilder {
  readonly doc: FormDoc = emptyDoc();
  private current = '';

  section(key: string, nl: string, en: string, showWhen: Condition | null = null): this {
    this.current = key;
    this.doc.sections.push({ key, names: named(nl, en), order: this.doc.sections.length, showWhen } satisfies SectionDef);
    return this;
  }

  field(key: string, type: FieldType, nl: string, en: string, options: FieldOptions = {}): this {
    const order = this.doc.fields.filter(field => field.section === this.current).length;
    this.doc.fields.push({
      key,
      kind: options.kind ?? 'system',
      type,
      labels: named(nl, en),
      help: options.help ?? named('', ''),
      placeholder: options.placeholder ?? named('', ''),
      section: this.current,
      order,
      width: options.width ?? (type === 'textarea' ? 'full' : 'half'),
      required: options.required ?? false,
      locked: options.locked ?? false,
      active: true,
      default: options.default ?? null,
      list: options.list ?? null,
      choices: (options.choices ?? []).map(([code, choiceNl, choiceEn]) => ({ code, names: named(choiceNl, choiceEn) })),
      validation: options.validation ?? {},
      showWhen: options.showWhen ?? null,
      viewPermission: options.sensitive || type === 'bsn' ? 'personal_data.view' : null,
      editPermission: options.sensitive || type === 'bsn' ? 'personal_data.edit' : null,
      // Restricted values are never in an export unless the form builder switches that on for somebody who may see them.
      flags: { ...NO_FLAGS, ...(options.sensitive || type === 'bsn' ? { export: false } : {}), ...options.flags },
    });
    return this;
  }
}

const LEGAL_PERSONS: Condition = { field: 'legal_form', op: 'in', value: ['bv', 'nv', 'stichting', 'vereniging', 'cooperatie'] };
const WITH_OWNER: Condition = { field: 'legal_form', op: 'in', value: ['eenmanszaak', 'vof', 'maatschap', 'cv'] };

export const CLIENT_FORM: FormDoc = new FormBuilder()
  .section('general', 'Algemeen', 'General')
  .field('number', 'text', 'Klantnummer', 'Client number', { required: true, locked: true, width: 'third', help: named('Het nummer waaronder je deze klant kent; ook voor de map en SnelStart.', 'The number you know this client by; also used for the folder and SnelStart.'), flags: { list: true, filter: true, search: true, unique: true } })
  .field('name', 'text', 'Bedrijfsnaam', 'Company name', { required: true, locked: true, flags: { list: true, filter: true, search: true, complete: true } })
  .field('trade_name', 'text', 'Handelsnaam', 'Trade name', { kind: 'custom', help: named('Alleen invullen als de handelsnaam afwijkt van de bedrijfsnaam.', 'Only if the trade name differs from the company name.'), flags: { search: true } })
  .field('legal_form', 'select', 'Rechtsvorm', 'Legal form', { required: true, locked: true, list: 'legal_form', help: named('Bepaalt welke andere gegevens het formulier toont.', 'Decides which other details the form shows.'), flags: { list: true, filter: true, complete: true } })
  .field('sector', 'select', 'Branche', 'Sector', { kind: 'custom', list: 'sector', flags: { filter: true } })
  .field('responsible_user', 'user', 'Verantwoordelijke medewerker', 'Responsible staff member', { width: 'half', help: named('Wie op kantoor deze klant behandelt.', 'Who at the office handles this client.'), flags: { filter: true } })
  .field('contact_person', 'text', 'Contactpersoon', 'Contact person', { flags: { list: true, search: true } })
  .field('client_since', 'date', 'Klant sinds', 'Client since', { kind: 'custom' })
  .field('notes', 'textarea', 'Notities', 'Notes', { kind: 'custom', width: 'full' })

  .section('address', 'Adres', 'Address')
  .field('street', 'text', 'Straatnaam', 'Street', { width: 'full', flags: { complete: true } })
  .field('house_number', 'text', 'Huisnummer', 'House number', { width: 'third', flags: { complete: true } })
  .field('house_number_suffix', 'text', 'Toevoeging', 'Suffix', { width: 'third' })
  .field('postal_code', 'postcode', 'Postcode', 'Postal code', { width: 'third', placeholder: named('1234 AB', '1234 AB'), flags: { search: true, complete: true } })
  .field('city', 'text', 'Plaats', 'City', { flags: { list: true, filter: true, search: true, complete: true } })

  .section('contact', 'Contact', 'Contact')
  .field('phone_1', 'phone', 'Telefoon 1', 'Phone 1', { flags: { list: true, complete: true } })
  .field('phone_2', 'phone', 'Telefoon 2', 'Phone 2')
  .field('email_1', 'email', 'E-mail 1', 'E-mail 1', { flags: { list: true, search: true, complete: true } })
  .field('email_2', 'email', 'E-mail 2', 'E-mail 2')
  .field('website', 'url', 'Website', 'Website', { kind: 'custom', width: 'full' })

  .section('bank', 'Bank', 'Bank')
  .field('iban_1', 'iban', 'IBAN 1', 'IBAN 1')
  .field('iban_2', 'iban', 'IBAN 2', 'IBAN 2')
  .field('g_account', 'iban', 'G-rekening', 'G-account', { help: named('IBAN van de geblokkeerde rekening voor loonheffingen en btw.', 'IBAN of the blocked account for payroll tax and VAT.') })
  .field('g_account_bank', 'select', 'Bank van de G-rekening', 'G-account bank', { kind: 'custom', list: 'bank' })

  .section('registration', 'Registratie en belastingen', 'Registration and taxes')
  .field('kvk', 'kvk', 'KvK-nummer', 'Chamber of Commerce number', { flags: { list: true, filter: true, search: true, unique: true, complete: true } })
  .field('vat_number', 'vat', 'BTW-nummer', 'VAT number', { help: named('Het omzetbelastingnummer, zoals de Belastingdienst het gebruikt.', 'The turnover-tax number as the tax authority uses it.'), flags: { search: true, complete: true } })
  .field('vat_id_number', 'vat', 'Btw-identificatienummer', 'VAT identification number', { help: named('Staat op facturen; bij een eenmanszaak verschilt het van het BTW-nummer.', 'Shown on invoices; for a sole proprietorship it differs from the VAT number.') })
  .field('rsin', 'rsin', 'RSIN', 'RSIN', { showWhen: { field: 'legal_form', op: 'nin', value: ['eenmanszaak'] }, help: named('Rechtspersonen- en Samenwerkingsverbanden Informatienummer (9 cijfers).', 'Legal-entity identification number (9 digits).') })
  .field('payroll_tax_number', 'payrollTax', 'Loonheffingennummer', 'Payroll tax number', { placeholder: named('123456789L01', '123456789L01') })
  .field('payroll_period', 'select', 'Aangifteperiode loonheffingen', 'Payroll tax period', { kind: 'custom', list: 'payroll_period' })
  .field('vat_frequency', 'select', 'Btw-aangifte', 'VAT return', { kind: 'custom', list: 'vat_frequency', flags: { filter: true } })
  .field('income_tax', 'boolean', 'Inkomstenbelasting (IB) voor de eigenaar', 'Income tax (IB) for the owner', { kind: 'custom', showWhen: WITH_OWNER, width: 'full' })
  .field('corporate_tax', 'boolean', 'Vennootschapsbelasting (VPB)', 'Corporate income tax (VPB)', { kind: 'custom', showWhen: LEGAL_PERSONS, width: 'full' })

  .section('inspection', 'Controle en certificering', 'Inspection and certification')
  .field('nen_4400', 'boolean', 'NEN 4400-1 gecertificeerd', 'NEN 4400-1 certified', { kind: 'custom', width: 'full', flags: { filter: true } })
  .field('cao', 'select', 'CAO', 'Collective labour agreement', { kind: 'custom', list: 'cao' }).doc;

const PERSON_ID_TYPES: Array<[string, string, string]> = [
  ['id_card', 'Identiteitskaart', 'ID card'],
  ['passport', 'Paspoort', 'Passport'],
  ['residence_permit', 'Verblijfsdocument', 'Residence permit'],
  ['driving_licence', 'Rijbewijs', 'Driving licence'],
];

const PERMIT_TYPES: Array<[string, string, string]> = [
  ['residence_permit', 'Verblijfsvergunning', 'Residence permit'],
  ['work_permit', 'Tewerkstellingsvergunning', 'Work permit'],
  ['single_permit', 'Gecombineerde vergunning (GVVA)', 'Single permit (GVVA)'],
  ['eu_registration', 'EU-registratie', 'EU registration'],
  ['none', 'Geen vergunning nodig', 'No permit needed'],
];

export const PERSON_FORM: FormDoc = new FormBuilder()
  .section('person', 'Persoon', 'Person')
  .field('salutation', 'select', 'Aanhef', 'Salutation', { list: 'salutation', width: 'third' })
  .field('initials', 'text', 'Voorletters', 'Initials', { width: 'third' })
  .field('first_name', 'text', 'Voornaam', 'First name', { required: true, locked: true, flags: { list: true, search: true } })
  .field('infix', 'text', 'Tussenvoegsel', 'Name prefix', { width: 'third', help: named('Bijvoorbeeld “van”, “de”, “van der”.', 'For example “van”, “de”, “van der”.') })
  .field('last_name', 'text', 'Achternaam', 'Last name', { required: true, locked: true, flags: { list: true, search: true } })
  .field('date_of_birth', 'date', 'Geboortedatum', 'Date of birth', { validation: { notFuture: true } })
  .field('nationality', 'select', 'Nationaliteit', 'Nationality', { kind: 'custom', list: 'nationality', flags: { filter: true } })
  .field('bsn', 'bsn', 'BSN', 'Citizen service number (BSN)', { help: named('Alleen zichtbaar voor mensen met toegang tot gevoelige gegevens.', 'Only visible to people with access to sensitive data.'), flags: { unique: true } })

  .section('contact', 'Contact', 'Contact')
  .field('phone', 'phone', 'Telefoon', 'Phone')
  .field('email', 'email', 'E-mail', 'E-mail', { flags: { search: true } })
  .field('mobile', 'phone', 'Mobiel nummer', 'Mobile number', { help: named('Voor WhatsApp, in internationaal formaat (+31 6 …).', 'For WhatsApp, in international format (+31 6 …).'), flags: { list: true } })

  .section('address', 'Adres', 'Address')
  .field('street', 'text', 'Straatnaam', 'Street', { width: 'full' })
  .field('house_number', 'text', 'Huisnummer', 'House number', { width: 'third' })
  .field('house_number_suffix', 'text', 'Toevoeging', 'Suffix', { width: 'third' })
  .field('postal_code', 'postcode', 'Postcode', 'Postal code', { width: 'third' })
  .field('city', 'text', 'Plaats', 'City', { flags: { list: true, filter: true, search: true } })

  .section('bank', 'Bank', 'Bank')
  .field('iban', 'iban', 'IBAN', 'IBAN', { sensitive: true, help: named('Alleen zichtbaar voor mensen met toegang tot gevoelige gegevens.', 'Only visible to people with access to sensitive data.') })

  .section('id_document', 'Identiteitsbewijs', 'Identity document')
  .field('id_type', 'select', 'Soort document', 'Type of document', { kind: 'custom', choices: PERSON_ID_TYPES, sensitive: true })
  .field('id_number', 'text', 'Documentnummer', 'Document number', { kind: 'custom', sensitive: true })
  .field('id_expiry', 'date', 'Geldig tot', 'Valid until', { kind: 'custom', sensitive: true, help: named('Hiermee waarschuwt het systeem als een document bijna verloopt.', 'The system warns when a document is about to expire.') })
  .field('id_file', 'file', 'Kopie van het document', 'Copy of the document', { kind: 'custom', sensitive: true, width: 'full' })
  .field('permit_type', 'select', 'Verblijfs- of werkvergunning', 'Residence or work permit', { kind: 'custom', choices: PERMIT_TYPES, sensitive: true })
  .field('permit_number', 'text', 'Nummer van de vergunning', 'Permit number', { kind: 'custom', sensitive: true })
  .field('permit_expiry', 'date', 'Vergunning geldig tot', 'Permit valid until', { kind: 'custom', sensitive: true, help: named('Hiermee waarschuwt het systeem als een vergunning bijna verloopt.', 'The system warns when a permit is about to expire.') }).doc;

/**
 * The employment of a worker at a client (the person — name, BSN, address, ID document — is the person form). The fields the logic needs
 * are system fields: the client, the function, the days in and out of service, the hourly rate.
 */
export const EMPLOYEE_FORM: FormDoc = new FormBuilder()
  .section('employment', 'Dienstverband', 'Employment')
  .field('client', 'client', 'Klant (werkgever)', 'Client (employer)', { required: true, locked: true, width: 'full', help: named('De klant bij wie deze persoon werkt.', 'The client this person works for.'), flags: { filter: true, complete: true } })
  .field('function', 'select', 'Functie', 'Function', { list: 'employee_function', flags: { list: true, filter: true, search: true, complete: true } })
  .field('start_date', 'date', 'In dienst vanaf', 'In service since', { help: named('De eerste werkdag.', 'The first working day.'), flags: { list: true, complete: true } })
  .field('end_date', 'date', 'Uit dienst per', 'Left service on', { help: named('Wordt ingevuld als je de werknemer stopzet; je kunt de datum ook vooraf invullen.', 'Filled in when you mark the employee as left; you can also fill it in ahead of time.') })
  .field('hourly_rate', 'money', 'Uurloon (bruto)', 'Hourly rate (gross)', { help: named('Het uurloon van vandaag. Een wijziging wordt in de uurloongeschiedenis bewaard.', 'Today’s hourly rate. A change is kept in the rate history.'), flags: { list: true } })
  .field('work_kind', 'select', 'Soort inzet', 'How the worker is used', {
    list: 'work_kind',
    default: 'own',
    width: 'full',
    help: named(
      'Bepaalt wat de afstemming van uren, loon en facturen verwacht: een werknemer van de klant wordt uitbetaald; een uitgeleende werknemer staat ook op facturen aan een inlener; een ingeleende werknemer werkt via een uitzendbureau (de klant krijgt de factuur van het bureau).',
      'Decides what the reconciliation of hours, pay and invoices expects: the client’s own employee is paid; a hired-out employee is also on invoices to a hirer; a hired-in worker works through a staffing company (the client gets the staffing company’s invoice).',
    ),
    flags: { filter: true },
  })
  .field('notes', 'textarea', 'Notities', 'Notes', { kind: 'custom', width: 'full' }).doc;

/** Contract types and the situations the form changes for (a field only shows for the types it applies to). */
const typeIn = (...types: string[]): Condition => ({ field: 'type', op: 'in', value: types });
const WITH_END: Condition = { field: 'type', op: 'nin', value: ['permanent'] };
const EMPLOYMENT: Condition = typeIn('on_call', 'fixed_term', 'permanent', 'internship');
const WITH_HOURS: Condition = typeIn('fixed_term', 'permanent', 'internship');
const HOURLY: Condition = typeIn('on_call', 'freelance', 'services');
const MONTHLY: Condition = typeIn('fixed_term', 'permanent', 'internship');

/**
 * The terms of a contract (docs/12). The client and the worker are chosen first and are not fields of this form; the type decides which fields apply
 * (an on-call contract has an hourly rate, a fixed-term contract a monthly salary and working hours). The length in months can be typed before the dates
 * (Ahmad, 17-10-2026): with a start date it fills in the end date — the day before the same date that many months later — and a hand-picked end date
 * fills in the length when it is whole months. Every field is also a merge field of the Word templates (`{contract.hourly_rate}`).
 * Holiday entitlements and the collective agreement are not asked here (Ahmad, 17-10-2026): the build-up comes from Settings → Hours & pay, the
 * collective agreement from the client (`{client.cao}`).
 */
export const CONTRACT_FORM: FormDoc = new FormBuilder()
  .section('contract', 'Contract', 'Contract')
  .field('type', 'select', 'Soort contract', 'Contract type', { required: true, locked: true, list: 'contract_type', help: named('Bepaalt welke andere gegevens het formulier toont.', 'Decides which other details the form shows.'), flags: { list: true, filter: true, search: true } })
  .field('function', 'select', 'Functie', 'Function', { list: 'employee_function', help: named('De functie op het contract; standaard die van de werknemer.', 'The function on the contract; by default the employee’s own.'), flags: { list: true, filter: true, search: true } })
  .field('duration_months', 'number', 'Duur (maanden)', 'Length (months)', {
    showWhen: WITH_END,
    width: 'third',
    validation: { min: 1, max: 120 },
    help: named('Vul het aantal maanden en de ingangsdatum in: de einddatum wordt dan ingevuld (9 maanden vanaf 01-01 loopt tot en met 30-09).', 'Fill in the number of months and the start date: the end date is then filled in (9 months from 01-01 runs up to and including 30-09).'),
  })
  .field('start_date', 'date', 'Ingangsdatum', 'Start date', { required: true, locked: true, flags: { list: true, filter: true, complete: true } })
  .field('end_date', 'date', 'Einddatum', 'End date', { locked: true, showWhen: WITH_END, help: named('De laatste dag van het contract. Wordt ingevuld vanuit de duur; je kunt hem ook zelf kiezen.', 'The last day of the contract. Filled in from the length; you can also pick it yourself.'), flags: { list: true, filter: true } })
  .field('probation_months', 'number', 'Proeftijd (maanden)', 'Probation (months)', { showWhen: EMPLOYMENT, default: 0, validation: { min: 0, max: 2 }, help: named('0 = geen proeftijd. Het systeem waarschuwt als een proeftijd niet is toegestaan.', '0 = no probation. The system warns when a probation period is not allowed.') })
  .field('signing_place', 'text', 'Plaats van ondertekening', 'Place of signing')
  .field('signing_date', 'date', 'Datum van ondertekening', 'Date of signing', { help: named('De datum die op het contract komt te staan.', 'The date that is printed on the contract.') })

  .section('work', 'Werk en werktijden', 'Work and hours', WITH_HOURS)
  .field('hours_per_week', 'number', 'Uren per week', 'Hours per week', { validation: { min: 0, max: 80 }, flags: { filter: true } })
  .field('working_days', 'text', 'Werkdagen', 'Working days', { placeholder: named('maandag t/m vrijdag', 'Monday to Friday') })
  .field('working_hours', 'text', 'Gebruikelijke werktijden', 'Usual working hours', { placeholder: named('08:00 – 17:00', '08:00 – 17:00') })
  .field('workplace', 'text', 'Standplaats', 'Place of work', { width: 'full', help: named('Het adres waar de werknemer gewoonlijk werkt.', 'The address where the employee usually works.') })

  .section('pay', 'Loon', 'Wage')
  .field('hourly_rate', 'money', 'Uurloon (bruto)', 'Hourly rate (gross)', { showWhen: HOURLY, help: named('Een nieuw uurloon wordt ook in de uurloongeschiedenis van de werknemer gezet.', 'A new hourly rate is also added to the employee’s rate history.'), flags: { list: true, filter: true } })
  .field('monthly_salary', 'money', 'Bruto maandloon', 'Gross monthly salary', { showWhen: MONTHLY, flags: { list: true, filter: true } })
  .field('holiday_allowance_percent', 'number', 'Vakantietoeslag (%)', 'Holiday allowance (%)', { showWhen: MONTHLY, default: 8, validation: { min: 0, max: 100 } })
  .field('holiday_accrual_period', 'text', 'Opbouwperiode vakantietoeslag', 'Holiday allowance accrual period', { showWhen: MONTHLY, default: 'juni t/m mei' })
  .field('holiday_payout_month', 'text', 'Uitbetaling vakantietoeslag', 'Holiday allowance payout', { showWhen: MONTHLY, default: 'juni' })

  .section('other', 'Overig', 'Other')
  .field('notes', 'textarea', 'Notities', 'Notes', { kind: 'custom', width: 'full' }).doc;

/**
 * The details of one day of work. The hours and the clock times are always on the screen (they are not fields of this form); what is here is what a
 * salary statement prints next to the hours — "where" is the hirer, the workplace and the assignment — and what an inspector may ask about.
 */
export const HOUR_ENTRY_FORM: FormDoc = new FormBuilder()
  .section('where', 'Waar gewerkt', 'Where it was worked')
  .field('workplace', 'text', 'Werkplek of locatie', 'Workplace or location', { width: 'full', help: named('Bijvoorbeeld het adres van de klant of de naam van het project.', 'For example the client’s address or the name of the project.'), flags: { list: true, search: true } })
  .field('hirer', 'client', 'Inlener', 'Hirer', { help: named('Alleen invullen als de werknemer voor een andere klant van het kantoor werkte dan zijn werkgever.', 'Only if the employee worked for another client of the office than their employer.'), flags: { list: true, filter: true } })
  .field('assignment', 'text', 'Opdracht of project', 'Assignment or project', { flags: { list: true, search: true } })
  .section('other', 'Overig', 'Other')
  .field('note', 'textarea', 'Opmerking', 'Note', { kind: 'custom', width: 'full' }).doc;

/**
 * A company that is not a client but is part of the staffing chain: the staffing agency that supplies workers, or a company that hires them. Name, KvK
 * number and VAT number are the columns the logic reads; the rest is what an invoice or a letter needs.
 */
export const COUNTERPARTY_FORM: FormDoc = new FormBuilder()
  .section('general', 'Algemeen', 'General')
  .field('name', 'text', 'Bedrijfsnaam', 'Company name', { required: true, locked: true, width: 'full', flags: { list: true, search: true } })
  .field('kvk', 'kvk', 'KvK-nummer', 'Chamber of Commerce number', { flags: { list: true, search: true } })
  .field('vat_number', 'vat', 'BTW-nummer', 'VAT number', { flags: { search: true } })
  .field('contact_person', 'text', 'Contactpersoon', 'Contact person', { flags: { list: true, search: true } })
  .field('notes', 'textarea', 'Notities', 'Notes', { kind: 'custom', width: 'full' })

  .section('address', 'Adres', 'Address')
  .field('street', 'text', 'Straatnaam', 'Street', { width: 'full' })
  .field('house_number', 'text', 'Huisnummer', 'House number', { width: 'third' })
  .field('house_number_suffix', 'text', 'Toevoeging', 'Suffix', { width: 'third' })
  .field('postal_code', 'postcode', 'Postcode', 'Postal code', { width: 'third', placeholder: named('1234 AB', '1234 AB'), flags: { search: true } })
  .field('city', 'text', 'Plaats', 'City', { flags: { list: true, filter: true, search: true } })

  .section('contact', 'Contact en bank', 'Contact and bank')
  .field('phone', 'phone', 'Telefoon', 'Phone')
  .field('email', 'email', 'E-mail', 'E-mail', { flags: { search: true } })
  .field('iban', 'iban', 'IBAN', 'IBAN')
  .field('website', 'url', 'Website', 'Website', { kind: 'custom', width: 'full' }).doc;

/**
 * What an invoice carries besides what the logic needs (the client, the other company, the dates, the lines, the VAT and the amounts are fixed). The
 * fields are merge fields of the invoice template (`{invoice.reference}`).
 */
export const INVOICE_FORM: FormDoc = new FormBuilder()
  .section('details', 'Gegevens', 'Details')
  .field('reference', 'text', 'Referentie', 'Reference', { help: named('Het kenmerk of ordernummer van de ander, zoals dat op de factuur staat.', 'The other party’s reference or order number, as it stands on the invoice.'), flags: { list: true, search: true } })
  .field('assignment', 'text', 'Opdracht of project', 'Assignment or project', { flags: { search: true } })
  .field('remarks', 'textarea', 'Opmerking op de factuur', 'Remark on the invoice', { width: 'full', help: named('Komt op de factuur te staan (bijvoorbeeld een betalingsafspraak).', 'Printed on the invoice (for example a payment agreement).') }).doc;

export const SEED_FORMS: Record<string, FormDoc> = { client: CLIENT_FORM, person: PERSON_FORM, employee: EMPLOYEE_FORM, contract: CONTRACT_FORM, hour_entry: HOUR_ENTRY_FORM, counterparty: COUNTERPARTY_FORM, invoice: INVOICE_FORM };
