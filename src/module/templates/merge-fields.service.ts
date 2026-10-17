import { Injectable, NotFoundException } from '@nestjs/common';
import { addDays, daysBetween, formatDay, isValidDay, todayInAmsterdam } from '../../common/dates.js';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import { asRecord, columnValues } from '../../common/record-values.js';
import type { Client, Employee, Person } from '../../generated/prisma/client.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { SettingsService } from '../../lib/settings/settings.service.js';
import { CalendarService } from '../calendar/calendar.service.js';
import { CLIENT_COLUMNS } from '../clients/client-record.js';
import { CONTRACT_COLUMNS, CONTRACT_ENTITY, CONTRACT_TYPES, addMonths, durationWords, monthsBetween } from '../contracts/contract-record.js';
import { EMPLOYEE_COLUMNS, RATE_FIELD } from '../employees/employee-record.js';
import { EmployeeRatesService } from '../employees/employee-rates.service.js';
import { toCents } from '../hours/hours-time.js';
import { COUNTERPARTY_COLUMNS, COUNTERPARTY_ENTITY, INVOICE_ENTITY } from '../invoices/invoices.constants.js';
import { canViewField } from '../forms/field-access.js';
import { isEmptyValue, isEncryptedField, type FieldDef, type FormDoc } from '../forms/form-doc.js';
import { FormRecordsService } from '../forms/form-records.service.js';
import { FormsService } from '../forms/forms.service.js';
import { ListsService } from '../lists/lists.service.js';
import { PERSON_COLUMNS } from '../people/person-record.js';
import type { PermissionMatrix } from '../roles/permission-catalog.js';
import { OFFICE_NAMESPACE } from '../settings/settings.definitions.js';
import {
  addressLine,
  cityLine,
  euro,
  firstOfNextMonth,
  fullName,
  initialsName,
  longDay,
  money,
  periodText,
  plainNumber,
  salutationLine,
  shortDay,
  streetLine,
  yesNo,
  type DocLocale,
} from './merge-format.js';
import { INVOICE_FIELDS, invoiceData, sampleInvoice, type InvoiceInput } from './invoice-merge.js';
import { STATEMENT_FIELDS, sampleStatement, statementData, type StatementInput } from './statement-merge.js';

/** The nested data a template is filled with: `{ employee: { first_name: 'Jan' } }`. Every value is text, already written the way the document needs it. */
export type MergeData = Record<string, Record<string, string>>;

export interface MergeField {
  /** What is typed in the Word file, without braces: `employee.first_name`. */
  tag: string;
  label: string;
  type: string;
  /** Calculated by the system (not a field of a form). */
  computed: boolean;
}

export interface MergeGroup {
  key: string;
  label: string;
  fields: MergeField[];
}

interface Computed {
  key: string;
  nl: string;
  en: string;
  type: 'text' | 'date' | 'number' | 'flag';
}

const NAMESPACES = [
  { key: 'contract', nl: 'Contract', en: 'Contract' },
  { key: 'statement', nl: 'Loonstaat', en: 'Salary statement' },
  { key: 'invoice', nl: 'Factuur', en: 'Invoice' },
  { key: 'recipient', nl: 'Het andere bedrijf (ontvanger of afzender)', en: 'The other company (recipient or sender)' },
  { key: 'employee', nl: 'Werknemer', en: 'Employee' },
  { key: 'client', nl: 'Klant (werkgever)', en: 'Client (employer)' },
  { key: 'office', nl: 'Kantoor', en: 'Office' },
  { key: 'document', nl: 'Document', en: 'Document' },
] as const;

const flag = (key: string, nl: string, en: string): Computed => ({ key, nl, en, type: 'flag' });

/** A salary-statement template is filled from the statement, an invoice template from the invoice; every other template (contracts, letters) from the contract. */
export const STATEMENT_KIND = 'salary_statement';
export const INVOICE_KIND = 'invoice';
const groupsFor = (kind?: string) =>
  NAMESPACES.filter(namespace => {
    if (kind === STATEMENT_KIND) return !['contract', 'invoice', 'recipient'].includes(namespace.key);
    if (kind === INVOICE_KIND) return !['contract', 'statement', 'employee'].includes(namespace.key);
    return !['statement', 'invoice', 'recipient'].includes(namespace.key);
  });

/** What the system calculates itself, per group. */
const COMPUTED: Record<string, Computed[]> = {
  contract: [
    { key: 'duration_months', nl: 'Duur in maanden (berekend)', en: 'Length in months (calculated)', type: 'number' },
    { key: 'duration_text', nl: 'Duur in woorden (“8 maanden”)', en: 'Length in words (“8 months”)', type: 'text' },
    { key: 'period_text', nl: 'Periode in een zin (“van … tot en met …”)', en: 'Period as a sentence (“from … up to and including …”)', type: 'text' },
    { key: 'working_days_count', nl: 'Aantal werkdagen in het contract', en: 'Number of working days in the contract', type: 'number' },
    { key: 'sent_on', nl: 'Verstuurd op', en: 'Sent on', type: 'date' },
    { key: 'signed_on', nl: 'Ondertekend op', en: 'Signed on', type: 'date' },
    { key: 'terminated_on', nl: 'Laatste werkdag bij beëindiging', en: 'Last day when terminated', type: 'date' },
    { key: 'termination_reason', nl: 'Reden van beëindiging', en: 'Reason for termination', type: 'text' },
    { key: 'termination_note', nl: 'Toelichting bij beëindiging', en: 'Note on the termination', type: 'text' },
    { key: 'notice_deadline', nl: 'Uiterste datum voor de aanzegging (een maand voor het einde)', en: 'Last day to give notice (one month before the end)', type: 'date' },
    flag('is_on_call', 'Blok alleen voor oproepovereenkomsten: {#contract.is_on_call} … {/contract.is_on_call}', 'Block for on-call contracts only: {#contract.is_on_call} … {/contract.is_on_call}'),
    flag('is_fixed_term', 'Blok alleen voor contracten voor bepaalde tijd', 'Block for fixed-term contracts only'),
    flag('is_permanent', 'Blok alleen voor contracten voor onbepaalde tijd', 'Block for permanent contracts only'),
    flag('is_internship', 'Blok alleen voor stageovereenkomsten', 'Block for internship agreements only'),
    flag('is_freelance', 'Blok alleen voor ZZP-overeenkomsten', 'Block for freelance agreements only'),
    flag('is_services', 'Blok alleen voor overeenkomsten van opdracht', 'Block for services agreements only'),
    flag('has_end_date', 'Blok alleen als er een einddatum is', 'Block only when there is an end date'),
    flag('has_probation', 'Blok alleen als er een proeftijd is', 'Block only when there is a probation period'),
  ],
  employee: [
    { key: 'full_name', nl: 'Volledige naam (Jan van der Berg)', en: 'Full name (Jan van der Berg)', type: 'text' },
    { key: 'initials_name', nl: 'Voorletters en achternaam (J. van der Berg)', en: 'Initials and surname (J. van der Berg)', type: 'text' },
    { key: 'salutation_line', nl: 'Aanhef (Geachte heer Van der Berg)', en: 'Salutation (Dear Mr Van der Berg)', type: 'text' },
    { key: 'street_line', nl: 'Straat en huisnummer', en: 'Street and number', type: 'text' },
    { key: 'city_line', nl: 'Postcode en plaats', en: 'Postal code and city', type: 'text' },
    { key: 'address', nl: 'Adres op één regel', en: 'Address on one line', type: 'text' },
  ],
  client: [
    { key: 'street_line', nl: 'Straat en huisnummer', en: 'Street and number', type: 'text' },
    { key: 'city_line', nl: 'Postcode en plaats', en: 'Postal code and city', type: 'text' },
    { key: 'address', nl: 'Adres op één regel', en: 'Address on one line', type: 'text' },
    { key: 'representative_name', nl: 'Naam van de eigenaar of bestuurder die tekent', en: 'Name of the owner or director who signs', type: 'text' },
    { key: 'representative_role', nl: 'Functie van die persoon (eigenaar, bestuurder …)', en: 'Role of that person (owner, director …)', type: 'text' },
  ],
  recipient: [
    { key: 'street_line', nl: 'Straat en huisnummer', en: 'Street and number', type: 'text' },
    { key: 'city_line', nl: 'Postcode en plaats', en: 'Postal code and city', type: 'text' },
    { key: 'address', nl: 'Adres op één regel', en: 'Address on one line', type: 'text' },
  ],
  office: [
    { key: 'name', nl: 'Naam van het kantoor', en: 'Name of the office', type: 'text' },
    { key: 'trade_name', nl: 'Handelsnaam', en: 'Trade name', type: 'text' },
    { key: 'street_line', nl: 'Straat en huisnummer', en: 'Street and number', type: 'text' },
    { key: 'city_line', nl: 'Postcode en plaats', en: 'Postal code and city', type: 'text' },
    { key: 'address', nl: 'Adres op één regel', en: 'Address on one line', type: 'text' },
    { key: 'phone', nl: 'Telefoon', en: 'Phone', type: 'text' },
    { key: 'email', nl: 'E-mail', en: 'E-mail', type: 'text' },
    { key: 'website', nl: 'Website', en: 'Website', type: 'text' },
    { key: 'kvk', nl: 'KvK-nummer', en: 'Chamber of Commerce number', type: 'text' },
    { key: 'vat_number', nl: 'BTW-nummer', en: 'VAT number', type: 'text' },
    { key: 'iban', nl: 'IBAN', en: 'IBAN', type: 'text' },
  ],
  document: [
    { key: 'today', nl: 'Datum van vandaag (31-12-2026)', en: 'Today’s date (31-12-2026)', type: 'date' },
    { key: 'year', nl: 'Het huidige jaar', en: 'The current year', type: 'number' },
    { key: 'place', nl: 'Plaats van het kantoor', en: 'Place of the office', type: 'text' },
  ],
};

/** Field types that never go into a document: a file has no text, and a link to a client is written through the client's own fields. */
const SKIPPED_TYPES: ReadonlySet<string> = new Set(['file', 'client']);

interface Docs {
  client: FormDoc;
  person: FormDoc;
  employee: FormDoc;
  contract: FormDoc;
  invoice: FormDoc;
  counterparty: FormDoc;
}

interface Lookups {
  /** `list key → code → name` in the language of the document. */
  names: Map<string, Map<string, string>>;
  users: Map<string, string>;
}

/** What a contract's data is built from (real or made up). */
interface Inputs {
  client: Record<string, unknown>;
  person: Record<string, unknown>;
  employment: Record<string, unknown>;
  contract: Record<string, unknown>;
  facts: {
    durationMonths: number | null;
    sentOn: string | null;
    signedOn: string | null;
    terminatedOn: string | null;
    terminationReason: string;
    terminationNote: string;
    workingDays: number | null;
  };
  representative: { name: string; role: string } | null;
  today: string;
}

/**
 * The merge fields of the Word templates: which tags exist (every field of the client, person, employee and contract forms — so a field Ahmad adds
 * in the form builder is available in every template at once — plus the ones the system calculates), and the data a tag is replaced with.
 * Restricted values (BSN, IBAN of a worker …) are never merged: a generated contract is a file that everybody who may see contracts can open.
 */
@Injectable()
export class MergeFieldsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly forms: FormsService,
    private readonly records: FormRecordsService,
    private readonly lists: ListsService,
    private readonly settings: SettingsService,
    private readonly calendar: CalendarService,
    private readonly rates: EmployeeRatesService,
  ) {}

  /* ── What can be used ─────────────────────────────────────────────────────────────────────────────────────────── */

  /** The groups of merge fields for the helper next to a template, in the language of the screen. */
  async catalog(locale: AppLocale, matrix?: PermissionMatrix, kind?: string): Promise<MergeGroup[]> {
    const docs = await this.docs();
    return groupsFor(kind).map(namespace => ({
      key: namespace.key,
      label: namespace[locale],
      fields: this.fieldsOf(namespace.key, docs, locale, matrix),
    }));
  }

  /** Every tag a template of this kind may use (every kind when none is given). */
  async knownTags(kind?: string): Promise<Set<string>> {
    const docs = await this.docs();
    const groups = kind === undefined ? NAMESPACES : groupsFor(kind);
    return new Set(groups.flatMap(namespace => this.fieldsOf(namespace.key, docs, 'nl').map(field => field.tag)));
  }

  private fieldsOf(namespace: string, docs: Docs, locale: AppLocale, matrix?: PermissionMatrix): MergeField[] {
    const fields: MergeField[] = [];
    const seen = new Set<string>();
    const add = (key: string, label: string, type: string, computed: boolean) => {
      const tag = `${namespace}.${key}`;
      if (seen.has(tag)) return;
      seen.add(tag);
      fields.push({ tag, label, type, computed });
    };
    const fromForm = (doc: FormDoc) => {
      const ordered = [...doc.fields].filter(field => this.usable(field, matrix)).sort((a, b) => (doc.sections.find(s => s.key === a.section)?.order ?? 0) - (doc.sections.find(s => s.key === b.section)?.order ?? 0) || a.order - b.order);
      for (const field of ordered) {
        const label = field.labels[locale] || field.labels.nl;
        add(field.key, label, field.type, false);
        if (field.type === 'date') add(`${field.key}_long`, locale === 'nl' ? `${label} (voluit)` : `${label} (in words)`, 'text', false);
        if (field.type === 'money') add(`${field.key}_number`, locale === 'nl' ? `${label} (alleen het bedrag)` : `${label} (amount only)`, 'text', false);
      }
    };
    if (namespace === 'statement') {
      for (const entry of STATEMENT_FIELDS) add(entry.key, entry[locale], entry.type, true);
      return fields;
    }
    if (namespace === 'invoice') {
      fromForm(docs.invoice);
      for (const entry of INVOICE_FIELDS) add(entry.key, entry[locale], entry.type, true);
      return fields;
    }
    if (namespace === 'recipient') fromForm(docs.counterparty);
    if (namespace === 'contract') fromForm(docs.contract);
    if (namespace === 'employee') {
      fromForm(docs.employee);
      fromForm(docs.person);
    }
    if (namespace === 'client') fromForm(docs.client);
    for (const entry of COMPUTED[namespace] ?? []) {
      add(entry.key, entry[locale], entry.type, true);
      if (entry.type === 'date') add(`${entry.key}_long`, locale === 'nl' ? `${entry[locale]} (voluit)` : `${entry[locale]} (in words)`, 'text', true);
    }
    return fields;
  }

  private usable(field: FieldDef, matrix?: PermissionMatrix): boolean {
    return field.active && !SKIPPED_TYPES.has(field.type) && !isEncryptedField(field) && (!matrix || canViewField(field, matrix));
  }

  /* ── The data ─────────────────────────────────────────────────────────────────────────────────────────────────── */

  /** Made-up data for a template preview: a preview never shows a real person or client. */
  async sample(docLocale: DocLocale, kind?: string): Promise<Record<string, unknown>> {
    const docs = await this.docs();
    const today = todayInAmsterdam();
    const start = firstOfNextMonth(today);
    const end = addDays(addMonths(start, 12), -1);

    const sampleValues = (doc: FormDoc, known: Record<string, unknown>, listFirst: Map<string, string>): Record<string, unknown> => {
      const values: Record<string, unknown> = {};
      for (const field of doc.fields) {
        if (!this.usable(field)) continue;
        if (field.key in known) {
          values[field.key] = known[field.key];
          continue;
        }
        const label = field.labels[docLocale] || field.labels.nl;
        switch (field.type) {
          case 'number':
            values[field.key] = typeof field.default === 'number' ? field.default : 8;
            break;
          case 'money':
            values[field.key] = 2400.5;
            break;
          case 'date':
            values[field.key] = today;
            break;
          case 'boolean':
            values[field.key] = true;
            break;
          case 'select':
            values[field.key] = (field.list ? listFirst.get(field.list) : undefined) ?? field.choices[0]?.code ?? null;
            break;
          case 'multiselect':
            values[field.key] = [(field.list ? listFirst.get(field.list) : undefined) ?? field.choices[0]?.code].filter(Boolean);
            break;
          case 'email':
            values[field.key] = 'voorbeeld@example.nl';
            break;
          case 'phone':
            values[field.key] = '+31 6 12345678';
            break;
          case 'postcode':
            values[field.key] = '1234 AB';
            break;
          case 'iban':
            values[field.key] = 'NL91 ABNA 0417 1643 00';
            break;
          case 'url':
            values[field.key] = 'https://www.example.nl';
            break;
          default:
            values[field.key] = `[${label}]`;
        }
      }
      return values;
    };

    const everyDoc: FormDoc[] = [docs.client, docs.person, docs.employee, docs.contract];
    const listKeys = [...new Set(everyDoc.flatMap(doc => doc.fields.filter(field => field.list).map(field => field.list as string)))];
    const lookups = await this.lists.lookups(listKeys, docLocale);
    const listFirst = new Map(Object.entries(lookups).map(([key, list]) => [key, list.items.find(item => item.active)?.code ?? ''] as const).filter(([, code]) => code));

    const inputs: Inputs = {
      client: sampleValues(docs.client, { number: '042', name: 'Voorbeeldbedrijf B.V.', street: 'Voorbeeldstraat', house_number: '12', house_number_suffix: '', postal_code: '1234 AB', city: 'Utrecht', legal_form: 'bv' }, listFirst),
      person: sampleValues(docs.person, { salutation: 'mr', initials: 'J.', first_name: 'Jan', infix: 'de', last_name: 'Vries', date_of_birth: '1990-05-17', street: 'Werknemersstraat', house_number: '3', house_number_suffix: '', postal_code: '4321 BA', city: 'Utrecht' }, listFirst),
      employment: sampleValues(docs.employee, { start_date: start, hourly_rate: 14.5 }, listFirst),
      contract: sampleValues(docs.contract, { type: 'fixed_term', start_date: start, end_date: end, hourly_rate: 14.5, monthly_salary: 2400.5, probation_months: 1, signing_place: 'Utrecht', signing_date: today }, listFirst),
      facts: { durationMonths: 12, sentOn: null, signedOn: null, terminatedOn: null, terminationReason: '', terminationNote: '', workingDays: this.workingDays(start, end) },
      representative: { name: 'M. Voorbeeld', role: docLocale === 'nl' ? 'Directeur' : 'Director' },
      today,
    };
    if (kind === INVOICE_KIND) {
      const recipient = sampleValues(docs.counterparty, { name: 'Voorbeeld Uitzendbureau B.V.', kvk: '12345678', vat_number: 'NL123456789B01', contact_person: 'A. Voorbeeld', street: 'Industrieweg', house_number: '8', house_number_suffix: '', postal_code: '3542 AD', city: 'Utrecht', iban: 'NL91 ABNA 0417 1643 00' }, listFirst);
      const details = sampleValues(docs.invoice, { reference: 'PO-2026-117', assignment: 'Project Voorbeeld', remarks: docLocale === 'nl' ? 'Betaling graag binnen de betaaltermijn.' : 'Please pay within the payment term.' }, listFirst);
      const lookups = await this.lookupsFor(docs, inputs, docLocale, [
        [docs.counterparty, recipient],
        [docs.invoice, details],
      ]);
      return { ...this.build(docs, inputs, docLocale, lookups), ...this.invoiceGroups(docs, recipient, details, invoiceData(sampleInvoice(today), docLocale), docLocale, lookups) };
    }
    const data = this.build(docs, inputs, docLocale, await this.lookupsFor(docs, inputs, docLocale));
    return kind === STATEMENT_KIND ? { ...data, statement: statementData(sampleStatement(today), docLocale) } : data;
  }

  /** The data of one contract (its client, worker and terms), written the way a document in `docLocale` writes it. `matrix` — what the person may see; `null` for the system itself. */
  async forContract(contractId: string, docLocale: DocLocale, matrix: PermissionMatrix | null): Promise<MergeData> {
    const contract = await this.prisma.contract.findUnique({ where: { id: contractId }, include: { client: true, employee: { include: { person: true } } } });
    if (!contract) throw new NotFoundException({ code: 'not_found', message: 'Contract not found' });
    const docs = await this.docs();
    const parties = await this.parties(docs, { ...contract.employee, client: contract.client }, matrix);
    const pick = (doc: FormDoc, values: Record<string, unknown>) => this.visible(doc, values, matrix);
    const start = contract.startDate.toISOString().slice(0, 10);
    const end = contract.endDate ? contract.endDate.toISOString().slice(0, 10) : null;
    const day = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : null);

    const inputs: Inputs = {
      client: parties.client,
      person: parties.person,
      employment: parties.employment,
      contract: pick(docs.contract, { ...this.records.publicValues(asRecord(contract.data)), ...columnValues(CONTRACT_COLUMNS, contract) }),
      facts: {
        durationMonths: contract.durationMonths,
        sentOn: day(contract.sentOn),
        signedOn: day(contract.signedOn),
        terminatedOn: day(contract.terminatedOn),
        terminationReason: contract.terminationReason ?? '',
        terminationNote: contract.terminationNote,
        workingDays: end ? this.workingDays(start, end, contract.clientId) : null,
      },
      representative: parties.representative,
      today: todayInAmsterdam(),
    };
    return this.build(docs, inputs, docLocale, await this.lookupsFor(docs, inputs, docLocale));
  }

  /**
   * The data of a salary statement: the worker, the client and the office as every document has them, plus the `statement` group (the totals, and the
   * lines that the template repeats) written in the document's language. `statement` is what was frozen when the statement was made.
   */
  async forStatement(employeeId: string, statement: StatementInput, docLocale: DocLocale, matrix: PermissionMatrix | null): Promise<Record<string, unknown>> {
    const employee = await this.prisma.employee.findUnique({ where: { id: employeeId }, include: { client: true, person: true } });
    if (!employee) throw new NotFoundException({ code: 'not_found', message: 'Employee not found' });
    const docs = await this.docs();
    const parties = await this.parties(docs, employee, matrix);
    const inputs: Inputs = {
      ...parties,
      contract: {},
      facts: { durationMonths: null, sentOn: null, signedOn: null, terminatedOn: null, terminationReason: '', terminationNote: '', workingDays: null },
      today: todayInAmsterdam(),
    };
    const data = this.build(docs, inputs, docLocale, await this.lookupsFor(docs, inputs, docLocale));
    return { ...data, statement: statementData(statement, docLocale) };
  }

  /**
   * The data of an invoice: the client it belongs to as `client` (the issuer of an outgoing invoice, the receiver of an incoming one), the other company as
   * `recipient`, the office, and the `invoice` group — the invoice form's fields, the totals and the lines the template repeats. It is what was saved on
   * the invoice, never today's hours.
   */
  async forInvoice(invoiceId: string, docLocale: DocLocale): Promise<Record<string, unknown>> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { client: true, counterparty: true, otherClient: true, creditOf: { select: { number: true } }, lines: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], include: { employee: { include: { person: true } } } } },
    });
    if (!invoice) throw new NotFoundException({ code: 'not_found', message: 'Invoice not found' });
    const docs = await this.docs();
    const side = await this.clientParty(docs, invoice.client, null);
    const inputs: Inputs = {
      client: side.client,
      person: {},
      employment: {},
      contract: {},
      facts: { durationMonths: null, sentOn: null, signedOn: null, terminatedOn: null, terminationReason: '', terminationNote: '', workingDays: null },
      representative: side.representative,
      today: todayInAmsterdam(),
    };
    // The other company as the company form has it; another client of the office is mapped onto the same keys.
    const other = invoice.counterparty
      ? { ...this.records.publicValues(asRecord(invoice.counterparty.data)), ...columnValues(COUNTERPARTY_COLUMNS, invoice.counterparty) }
      : this.clientAsCompany(invoice.otherClient as Client);
    const details = this.records.publicValues(asRecord(invoice.data));
    const lookups = await this.lookupsFor(docs, inputs, docLocale, [
      [docs.counterparty, other],
      [docs.invoice, details],
    ]);

    const date = invoice.invoiceDate ? formatDay(invoice.invoiceDate) : inputs.today;
    const dueDate = invoice.dueDate ? formatDay(invoice.dueDate) : date;
    const input: InvoiceInput = {
      number: invoice.number ?? '',
      credit: invoice.kind === 'credit',
      creditOfNumber: invoice.creditOf?.number ?? '',
      date,
      dueDate,
      periodFrom: formatDay(invoice.periodFrom),
      periodTo: formatDay(invoice.periodTo),
      vatPercent: invoice.vatPercent.toNumber(),
      vatShifted: invoice.vatShifted,
      subtotalCents: toCents(invoice.subtotal.toNumber()),
      vatCents: toCents(invoice.vatAmount.toNumber()),
      totalCents: toCents(invoice.total.toNumber()),
      gAccountPercent: invoice.gAccountPercent.toNumber(),
      gAccountCents: toCents(invoice.gAccountAmount.toNumber()),
      paymentDays: Math.max(0, daysBetween(date, dueDate)),
      lines: invoice.lines.map(line => ({
        kind: line.kind as 'hours' | 'markup' | 'other',
        worker: line.employee ? fullName({ firstName: line.employee.person.firstName, lastName: line.employee.person.lastName, infix: String(asRecord(line.employee.person.data).infix ?? '') }) : line.rawName,
        description: line.description,
        from: line.fromDate ? formatDay(line.fromDate) : null,
        to: line.toDate ? formatDay(line.toDate) : null,
        minutes: line.minutes,
        rateCents: line.rate === null ? null : toCents(line.rate.toNumber()),
        amountCents: toCents(line.amount.toNumber()),
      })),
    };
    return { ...this.build(docs, inputs, docLocale, lookups), ...this.invoiceGroups(docs, other, details, invoiceData(input, docLocale), docLocale, lookups) };
  }

  /** Another client of the office as the company form has it (its phone, e-mail and IBAN fields have other keys). */
  private clientAsCompany(client: Client): Record<string, unknown> {
    const values = { ...this.records.publicValues(asRecord(client.data)), ...columnValues(CLIENT_COLUMNS, client) };
    return { ...values, phone: values.phone_1 ?? values.phone_2, email: values.email_1 ?? values.email_2, iban: values.iban_1 ?? values.iban_2 };
  }

  /** The `recipient` and `invoice` groups: the company form's values and the invoice form's values written as text, and the invoice's own computed fields. */
  private invoiceGroups(docs: Docs, other: Record<string, unknown>, details: Record<string, unknown>, computed: Record<string, unknown>, locale: DocLocale, lookups: Lookups) {
    const recipient: Record<string, string> = {};
    for (const field of docs.counterparty.fields) if (this.usable(field)) Object.assign(recipient, this.write(field, other[field.key], locale, lookups));
    Object.assign(recipient, { street_line: streetLine(other), city_line: cityLine(other), address: addressLine(other) });
    const invoice: Record<string, unknown> = {};
    for (const field of docs.invoice.fields) if (this.usable(field)) Object.assign(invoice, this.write(field, details[field.key], locale, lookups));
    Object.assign(invoice, computed);
    return { recipient, invoice };
  }

  /** The values of a form without the fields this person may not see (`null` matrix = the system itself: everything). */
  private visible(doc: FormDoc, values: Record<string, unknown>, matrix: PermissionMatrix | null): Record<string, unknown> {
    if (!matrix) return values;
    return Object.fromEntries(
      Object.entries(values).filter(([key]) => {
        const field = doc.fields.find(entry => entry.key === key);
        return !field || canViewField(field, matrix);
      }),
    );
  }

  /** A client as form values, and who signs for it (the owner, a director or a partner). */
  private async clientParty(docs: Docs, client: Client, matrix: PermissionMatrix | null) {
    const people = await this.prisma.clientPerson.findMany({ where: { clientId: client.id, endedOn: null }, include: { person: true }, orderBy: { createdAt: 'asc' } });
    const priority = ['owner', 'director', 'partner'];
    const chosen = [...people].filter(link => link.role !== 'contact' && link.role !== 'shareholder').sort((a, b) => priority.indexOf(a.role) - priority.indexOf(b.role))[0] ?? null;
    return {
      client: this.visible(docs.client, { ...this.records.publicValues(asRecord(client.data)), ...columnValues(CLIENT_COLUMNS, client) }, matrix),
      representative: chosen ? { name: fullName({ firstName: chosen.person.firstName, lastName: chosen.person.lastName, infix: String(asRecord(chosen.person.data).infix ?? '') }), role: chosen.role } : null,
    };
  }

  /** A worker's client, person and employment as form values, and who signs for the client. */
  private async parties(docs: Docs, employee: Employee & { client: Client; person: Person }, matrix: PermissionMatrix | null) {
    const rate = await this.rates.current(employee.id);
    const side = await this.clientParty(docs, employee.client, matrix);
    return {
      client: side.client,
      person: this.visible(docs.person, { ...this.records.publicValues(asRecord(employee.person.data)), ...columnValues(PERSON_COLUMNS, employee.person) }, matrix),
      employment: this.visible(docs.employee, { ...this.records.publicValues(asRecord(employee.data)), ...columnValues(EMPLOYEE_COLUMNS, employee), ...(rate !== null && { [RATE_FIELD]: rate }) }, matrix),
      representative: side.representative,
    };
  }

  private workingDays(start: string, end: string, clientId?: string): number {
    return this.calendar.workingDaysBetween(addDays(start, -1), end, clientId);
  }

  private async docs(): Promise<Docs> {
    const [client, person, employee, contract, invoice, counterparty] = await Promise.all(['client', 'person', 'employee', CONTRACT_ENTITY, INVOICE_ENTITY, COUNTERPARTY_ENTITY].map(entity => this.forms.live(entity)));
    return { client: client!.doc, person: person!.doc, employee: employee!.doc, contract: contract!.doc, invoice: invoice!.doc, counterparty: counterparty!.doc };
  }

  /** The names of pick-list items and staff members the values point at. */
  private async lookupsFor(docs: Docs, inputs: Inputs, locale: DocLocale, extra: Array<[FormDoc, Record<string, unknown>]> = []): Promise<Lookups> {
    const listKeys = new Set<string>(['termination_reason', 'person_role', 'contract_type']);
    const userIds = new Set<string>();
    const sources: Array<[FormDoc, Record<string, unknown>]> = [
      [docs.client, inputs.client],
      [docs.person, inputs.person],
      [docs.employee, inputs.employment],
      [docs.contract, inputs.contract],
      ...extra,
    ];
    for (const [doc, values] of sources) {
      for (const field of doc.fields) {
        if (field.list) listKeys.add(field.list);
        const value = values[field.key];
        if (field.type === 'user' && typeof value === 'string') userIds.add(value);
      }
    }
    const [lookups, users] = await Promise.all([this.lists.lookups([...listKeys], locale), userIds.size ? this.prisma.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, name: true } }) : []]);
    return {
      names: new Map(Object.entries(lookups).map(([key, list]) => [key, new Map(list.items.map(item => [item.code, item.name]))])),
      users: new Map(users.map(user => [user.id, user.name])),
    };
  }

  /* ── Writing the values ───────────────────────────────────────────────────────────────────────────────────────── */

  private build(docs: Docs, inputs: Inputs, locale: DocLocale, lookups: Lookups): MergeData {
    const data: MergeData = { contract: {}, employee: {}, client: {}, office: {}, document: {} };
    const fill = (target: Record<string, string>, doc: FormDoc, values: Record<string, unknown>) => {
      for (const field of doc.fields) {
        if (!this.usable(field)) continue;
        Object.assign(target, this.write(field, values[field.key], locale, lookups));
      }
    };
    // Both forms of a worker end up in one group; where a key exists in both, the employment wins.
    fill(data.client!, docs.client, inputs.client);
    fill(data.employee!, docs.person, inputs.person);
    fill(data.employee!, docs.employee, inputs.employment);
    fill(data.contract!, docs.contract, inputs.contract);

    const person = inputs.person;
    const text = (values: Record<string, unknown>, key: string) => (typeof values[key] === 'string' ? (values[key] as string) : '');
    const parts = { firstName: text(person, 'first_name'), infix: text(person, 'infix'), lastName: text(person, 'last_name'), initials: text(person, 'initials') };
    Object.assign(data.employee!, {
      full_name: fullName(parts),
      initials_name: initialsName(parts),
      salutation_line: salutationLine(text(person, 'salutation'), parts, locale),
      street_line: streetLine(person),
      city_line: cityLine(person),
      address: addressLine(person),
    });
    Object.assign(data.client!, {
      street_line: streetLine(inputs.client),
      city_line: cityLine(inputs.client),
      address: addressLine(inputs.client),
      representative_name: inputs.representative?.name ?? '',
      representative_role: inputs.representative ? (lookups.names.get('person_role')?.get(inputs.representative.role) ?? inputs.representative.role) : '',
    });

    const start = text(inputs.contract, 'start_date');
    const end = text(inputs.contract, 'end_date');
    const type = text(inputs.contract, 'type');
    const day = (value: string | null) => (value && isValidDay(value) ? shortDay(value) : '');
    const words = (value: string | null) => (value && isValidDay(value) ? longDay(value, locale) : '');
    // The last day to give notice of (non-)renewal: a month before the end — and on a working day, so a Sunday moves it to the Friday before.
    const notice = end && isValidDay(end) ? this.calendar.previousWorkingDay(addMonths(end, -1)) : null;
    const probation = Number(inputs.contract.probation_months ?? 0);
    const months = inputs.facts.durationMonths ?? (start && end ? monthsBetween(start, end) : null);
    Object.assign(data.contract!, {
      duration_months: months === null ? '' : String(months),
      duration_text: durationWords(months, locale),
      period_text: periodText(start || null, end || null, locale),
      working_days_count: inputs.facts.workingDays === null ? '' : String(inputs.facts.workingDays),
      sent_on: day(inputs.facts.sentOn),
      sent_on_long: words(inputs.facts.sentOn),
      signed_on: day(inputs.facts.signedOn),
      signed_on_long: words(inputs.facts.signedOn),
      terminated_on: day(inputs.facts.terminatedOn),
      terminated_on_long: words(inputs.facts.terminatedOn),
      termination_reason: lookups.names.get('termination_reason')?.get(inputs.facts.terminationReason) ?? inputs.facts.terminationReason,
      termination_note: inputs.facts.terminationNote,
      notice_deadline: notice ? shortDay(notice) : '',
      notice_deadline_long: notice ? longDay(notice, locale) : '',
      has_end_date: end ? '1' : '',
      has_probation: probation > 0 ? '1' : '',
      ...Object.fromEntries(CONTRACT_TYPES.map(entry => [`is_${entry}`, entry === type ? '1' : ''])),
    });

    const office = this.settings.group(OFFICE_NAMESPACE) as Record<string, string>;
    const officeFields = { street: office.street, house_number: office.houseNumber, house_number_suffix: office.houseNumberSuffix, postal_code: office.postalCode, city: office.city };
    Object.assign(data.office!, {
      name: office.name ?? '',
      trade_name: office.tradeName ?? '',
      street_line: streetLine(officeFields),
      city_line: cityLine(officeFields),
      address: addressLine(officeFields),
      phone: office.phone ?? '',
      email: office.email ?? '',
      website: office.website ?? '',
      kvk: office.kvk ?? '',
      vat_number: office.vatNumber ?? '',
      iban: office.iban ?? '',
    });
    Object.assign(data.document!, {
      today: shortDay(inputs.today),
      today_long: longDay(inputs.today, locale),
      year: inputs.today.slice(0, 4),
      place: office.city ?? '',
    });
    return data;
  }

  /** One field's value as text, plus the variants (`_long` for a date, `_number` for money). */
  private write(field: FieldDef, raw: unknown, locale: DocLocale, lookups: Lookups): Record<string, string> {
    const out: Record<string, string> = {};
    const key = field.key;
    const name = (code: unknown) => {
      const text = String(code);
      return (field.list ? lookups.names.get(field.list)?.get(text) : undefined) ?? field.choices.find(choice => choice.code === text)?.names[locale] ?? text;
    };
    if (isEmptyValue(raw)) {
      out[key] = '';
      if (field.type === 'date') out[`${key}_long`] = '';
      if (field.type === 'money') out[`${key}_number`] = '';
      return out;
    }
    switch (field.type) {
      case 'number':
        out[key] = plainNumber(Number(raw), locale);
        break;
      case 'money':
        out[key] = euro(Number(raw), locale);
        out[`${key}_number`] = money(Number(raw), locale);
        break;
      case 'date':
        out[key] = typeof raw === 'string' && isValidDay(raw) ? shortDay(raw) : '';
        out[`${key}_long`] = typeof raw === 'string' && isValidDay(raw) ? longDay(raw, locale) : '';
        break;
      case 'boolean':
        out[key] = yesNo(raw === true, locale);
        break;
      case 'select':
        out[key] = name(raw);
        break;
      case 'multiselect':
        out[key] = (Array.isArray(raw) ? raw : [raw]).map(name).join(', ');
        break;
      case 'user':
        out[key] = lookups.users.get(String(raw)) ?? '';
        break;
      default:
        out[key] = String(raw);
    }
    return out;
  }
}
