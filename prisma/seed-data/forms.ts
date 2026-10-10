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
      validation: {},
      showWhen: options.showWhen ?? null,
      viewPermission: options.sensitive || type === 'bsn' ? 'personal_data.view' : null,
      editPermission: options.sensitive || type === 'bsn' ? 'personal_data.edit' : null,
      flags: { ...NO_FLAGS, ...options.flags },
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

export const PERSON_FORM: FormDoc = new FormBuilder()
  .section('person', 'Persoon', 'Person')
  .field('salutation', 'select', 'Aanhef', 'Salutation', { list: 'salutation', width: 'third' })
  .field('initials', 'text', 'Voorletters', 'Initials', { width: 'third' })
  .field('first_name', 'text', 'Voornaam', 'First name', { required: true, locked: true, flags: { list: true, search: true } })
  .field('infix', 'text', 'Tussenvoegsel', 'Name prefix', { width: 'third', help: named('Bijvoorbeeld “van”, “de”, “van der”.', 'For example “van”, “de”, “van der”.') })
  .field('last_name', 'text', 'Achternaam', 'Last name', { required: true, locked: true, flags: { list: true, search: true } })
  .field('date_of_birth', 'date', 'Geboortedatum', 'Date of birth')
  .field('nationality', 'select', 'Nationaliteit', 'Nationality', { kind: 'custom', list: 'nationality' })
  .field('bsn', 'bsn', 'BSN', 'Citizen service number (BSN)', { help: named('Alleen zichtbaar voor mensen met toegang tot gevoelige gegevens.', 'Only visible to people with access to sensitive data.'), flags: { unique: true } })

  .section('contact', 'Contact', 'Contact')
  .field('phone', 'phone', 'Telefoon', 'Phone', { flags: { list: true } })
  .field('email', 'email', 'E-mail', 'E-mail', { flags: { list: true, search: true } })

  .section('address', 'Adres', 'Address')
  .field('street', 'text', 'Straatnaam', 'Street', { width: 'full' })
  .field('house_number', 'text', 'Huisnummer', 'House number', { width: 'third' })
  .field('house_number_suffix', 'text', 'Toevoeging', 'Suffix', { width: 'third' })
  .field('postal_code', 'postcode', 'Postcode', 'Postal code', { width: 'third' })
  .field('city', 'text', 'Plaats', 'City')

  .section('id_document', 'Identiteitsbewijs', 'Identity document')
  .field('id_type', 'select', 'Soort document', 'Type of document', { kind: 'custom', choices: PERSON_ID_TYPES, sensitive: true })
  .field('id_number', 'text', 'Documentnummer', 'Document number', { kind: 'custom', sensitive: true })
  .field('id_expiry', 'date', 'Geldig tot', 'Valid until', { kind: 'custom', sensitive: true, help: named('Hiermee waarschuwt het systeem als een document bijna verloopt.', 'The system warns when a document is about to expire.') })
  .field('id_file', 'file', 'Kopie van het document', 'Copy of the document', { kind: 'custom', sensitive: true, width: 'full' }).doc;

export const SEED_FORMS: Record<string, FormDoc> = { client: CLIENT_FORM, person: PERSON_FORM };
