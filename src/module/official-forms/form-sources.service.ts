import { Injectable, NotFoundException } from '@nestjs/common';
import { isValidDay, todayInAmsterdam } from '../../common/dates.js';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import { asRecord, columnValues } from '../../common/record-values.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { validationFailed } from '../../common/validation/failure.js';
import type { Employee, Person } from '../../generated/prisma/client.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { SettingsService } from '../../lib/settings/settings.service.js';
import { CLIENT_COLUMNS } from '../clients/client-record.js';
import { EMPLOYEE_COLUMNS, RATE_FIELD } from '../employees/employee-record.js';
import { canViewField } from '../forms/field-access.js';
import { isEmptyValue, isEncryptedField, type FieldDef, type FormDoc } from '../forms/form-doc.js';
import { FormRecordsService } from '../forms/form-records.service.js';
import { FormsService } from '../forms/forms.service.js';
import { ListsService } from '../lists/lists.service.js';
import { PERSON_COLUMNS } from '../people/person-record.js';
import { OFFICE_NAMESPACE } from '../settings/settings.definitions.js';
import { addressLine, cityLine, fullName, initialsName, money, plainNumber, shortDay, streetLine, yesNo, type DocLocale } from '../templates/merge-format.js';
import { SIGNING_ROLES } from './official-forms.constants.js';
import { NOTHING, initialsOf, type Resolved } from './form-values.js';

export type SourceGroupKey = 'client' | 'person' | 'employee' | 'office' | 'form' | 'period';

export interface SourceEntry {
  /** `client.kvk` — what a mapping refers to. */
  key: string;
  label: string;
  /** The type of the form field it comes from (`date`, `select`, `bsn` …), or `text` / `date` / `number` for what the system works out. */
  type: string;
  /** A sensitive value: a form that holds it is only opened by people who may see sensitive data. */
  restricted: boolean;
  computed: boolean;
  /** `select` fields: the codes with their names — for a check box that is ticked for one of them. */
  choices?: Array<{ code: string; name: string }>;
}

export interface SourceGroup {
  key: SourceGroupKey;
  label: string;
  entries: SourceEntry[];
}

/** Who and what a form is being filled in for. */
export interface SubjectInput {
  clientId: string;
  personId?: string | null;
  employeeId?: string | null;
  period?: { start: string; end: string } | null;
}

interface Scalar {
  raw: unknown;
  text: string;
  type: string;
}

/** Everything a mapping can read for one client (and one person, one worker): the values, what the person asking may not see, and what the system works out. */
export interface SubjectContext {
  locale: DocLocale;
  client: { id: string; number: string; name: string; isActive: boolean; legalForm: string | null };
  person: { id: string; name: string; role: string | null } | null;
  employee: { id: string; name: string } | null;
  docs: { client: FormDoc; person: FormDoc; employee: FormDoc };
  values: { client: Record<string, unknown>; person: Record<string, unknown>; employee: Record<string, unknown> };
  computed: { client: Record<string, string>; person: Record<string, string>; employee: Record<string, string> };
  scalars: { office: Record<string, Scalar>; form: Record<string, Scalar>; period: Record<string, Scalar> };
  /** `person.bsn`: values the person asking may not see. */
  hidden: Set<string>;
  names: Map<string, Map<string, string>>;
  users: Map<string, string>;
}

interface Computed {
  key: string;
  nl: string;
  en: string;
  type: string;
}

const GROUP_LABELS: Record<SourceGroupKey, { nl: string; en: string }> = {
  client: { nl: 'Klant', en: 'Client' },
  person: { nl: 'Persoon (eigenaar, bestuurder of werknemer)', en: 'Person (owner, director or worker)' },
  employee: { nl: 'Dienstverband van de werknemer', en: 'The worker’s employment' },
  office: { nl: 'Kantoor (Nexra)', en: 'Office (Nexra)' },
  form: { nl: 'Formulier (datum, plaats, wie invult)', en: 'Form (date, place, who fills it in)' },
  period: { nl: 'Periode', en: 'Period' },
};

const ADDRESS_LINES: Computed[] = [
  { key: 'street_line', nl: 'Straat en huisnummer', en: 'Street and number', type: 'text' },
  { key: 'city_line', nl: 'Postcode en plaats', en: 'Postal code and city', type: 'text' },
  { key: 'address', nl: 'Adres op één regel', en: 'Address on one line', type: 'text' },
];

/** What the system works out itself, per group. */
const COMPUTED: Record<SourceGroupKey, Computed[]> = {
  client: [
    ...ADDRESS_LINES,
    { key: 'representative_name', nl: 'Naam van de eigenaar of bestuurder die tekent', en: 'Name of the owner or director who signs', type: 'text' },
    { key: 'representative_role', nl: 'Functie van die persoon (eigenaar, bestuurder …)', en: 'Role of that person (owner, director …)', type: 'text' },
  ],
  person: [
    { key: 'full_name', nl: 'Volledige naam (Jan van der Berg)', en: 'Full name (Jan van der Berg)', type: 'text' },
    { key: 'initials_name', nl: 'Voorletters en achternaam (J. van der Berg)', en: 'Initials and surname (J. van der Berg)', type: 'text' },
    { key: 'initials_derived', nl: 'Voorletters (het veld, anders afgeleid van de voornaam)', en: 'Initials (the field, else worked out from the first name)', type: 'text' },
    { key: 'surname', nl: 'Achternaam met voorvoegsel (van der Berg)', en: 'Surname with prefix (van der Berg)', type: 'text' },
    ...ADDRESS_LINES,
    { key: 'role', nl: 'Rol bij de klant (eigenaar, bestuurder …)', en: 'Role at the client (owner, director …)', type: 'text' },
  ],
  employee: [],
  office: [
    { key: 'name', nl: 'Naam van het kantoor', en: 'Name of the office', type: 'text' },
    { key: 'trade_name', nl: 'Handelsnaam', en: 'Trade name', type: 'text' },
    { key: 'street', nl: 'Straat', en: 'Street', type: 'text' },
    { key: 'house_number', nl: 'Huisnummer', en: 'House number', type: 'text' },
    { key: 'house_number_suffix', nl: 'Toevoeging', en: 'Suffix', type: 'text' },
    { key: 'postal_code', nl: 'Postcode', en: 'Postal code', type: 'postcode' },
    { key: 'city', nl: 'Plaats', en: 'City', type: 'text' },
    ...ADDRESS_LINES,
    { key: 'phone', nl: 'Telefoon', en: 'Phone', type: 'phone' },
    { key: 'email', nl: 'E-mail', en: 'E-mail', type: 'email' },
    { key: 'website', nl: 'Website', en: 'Website', type: 'url' },
    { key: 'kvk', nl: 'KvK-nummer', en: 'Chamber of Commerce number', type: 'kvk' },
    { key: 'vat_number', nl: 'BTW-nummer', en: 'VAT number', type: 'vat' },
    { key: 'iban', nl: 'IBAN', en: 'IBAN', type: 'iban' },
  ],
  form: [
    { key: 'today', nl: 'Datum van vandaag', en: 'Today’s date', type: 'date' },
    { key: 'year', nl: 'Het huidige jaar', en: 'The current year', type: 'number' },
    { key: 'place', nl: 'Plaats van het kantoor', en: 'Place of the office', type: 'text' },
    { key: 'user_name', nl: 'Naam van wie het formulier invult', en: 'Name of the person filling the form in', type: 'text' },
  ],
  period: [
    { key: 'start', nl: 'Eerste dag van de periode', en: 'First day of the period', type: 'date' },
    { key: 'end', nl: 'Laatste dag van de periode', en: 'Last day of the period', type: 'date' },
    { key: 'year', nl: 'Jaar van de periode', en: 'Year of the period', type: 'number' },
  ],
};

const FORM_GROUPS = ['client', 'person', 'employee'] as const;
type FormGroup = (typeof FORM_GROUPS)[number];
const ENTITY_OF: Record<FormGroup, string> = { client: 'client', person: 'person', employee: 'employee' };

/** A value only people with access to sensitive data may see (a BSN, a field the form builder limited). */
export const isRestrictedField = (field: FieldDef): boolean => isEncryptedField(field) || field.viewPermission !== null;

/**
 * Where the values of a form come from: every field of the client, person and employee forms (read from the live form definitions, so a field added in the form
 * builder can be mapped at once), what the system works out (a full name, an address on one line, who signs), the office's own details, today's date and the
 * period. Also the data a form is filled from for one client — with the values this person may not see left out.
 */
@Injectable()
export class FormSourcesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly forms: FormsService,
    private readonly records: FormRecordsService,
    private readonly lists: ListsService,
    private readonly settings: SettingsService,
  ) {}

  /* ── What can be used ─────────────────────────────────────────────────────────────────────────────────────────── */

  private async docs(): Promise<{ client: FormDoc; person: FormDoc; employee: FormDoc }> {
    const [client, person, employee] = await Promise.all(FORM_GROUPS.map(group => this.forms.live(ENTITY_OF[group])));
    return { client: client!.doc, person: person!.doc, employee: employee!.doc };
  }

  /** The groups of sources for the mapping editor, in the language of the screen. */
  async catalog(locale: AppLocale): Promise<SourceGroup[]> {
    const docs = await this.docs();
    const listKeys = [...new Set(FORM_GROUPS.flatMap(group => docs[group].fields.filter(field => field.list).map(field => field.list as string)))];
    const lookups = await this.lists.lookups(listKeys, locale);
    const groups: SourceGroup[] = [];
    for (const key of Object.keys(GROUP_LABELS) as SourceGroupKey[]) {
      const entries: SourceEntry[] = [];
      if (key === 'client' || key === 'person' || key === 'employee') {
        const doc = docs[key];
        const sections = new Map(doc.sections.map(section => [section.key, section.order]));
        const ordered = doc.fields.filter(field => field.active && field.type !== 'file' && !(key === 'employee' && field.key === RATE_FIELD) && !(key === 'employee' && field.key === 'client')).sort((a, b) => (sections.get(a.section) ?? 0) - (sections.get(b.section) ?? 0) || a.order - b.order);
        for (const field of ordered) {
          const choices =
            field.type === 'select' || field.type === 'multiselect'
              ? field.list
                ? (lookups[field.list]?.items ?? []).filter(item => item.active).map(item => ({ code: item.code, name: item.name }))
                : field.choices.map(choice => ({ code: choice.code, name: choice.names[locale] || choice.names.nl }))
              : undefined;
          entries.push({ key: `${key}.${field.key}`, label: field.labels[locale] || field.labels.nl, type: field.type, restricted: isRestrictedField(field), computed: false, ...(choices?.length && { choices: choices.slice(0, 80) }) });
        }
      }
      for (const entry of COMPUTED[key]) entries.push({ key: `${key}.${entry.key}`, label: entry[locale], type: entry.type, restricted: false, computed: true });
      if (entries.length) groups.push({ key, label: GROUP_LABELS[key][locale], entries });
    }
    return groups;
  }

  /** Every key a mapping may refer to. */
  async knownKeys(): Promise<Set<string>> {
    const docs = await this.docs();
    const keys = new Set<string>();
    for (const group of FORM_GROUPS) for (const field of docs[group].fields) keys.add(`${group}.${field.key}`);
    for (const group of Object.keys(COMPUTED) as SourceGroupKey[]) for (const entry of COMPUTED[group]) keys.add(`${group}.${entry.key}`);
    return keys;
  }

  /* ── The people a form can be about ───────────────────────────────────────────────────────────────────────────── */

  /** The client with the people linked to it (owner, directors, partners, contacts) and its workers — what the person filling a form in chooses from. */
  async subjects(clientId: string, locale: AppLocale) {
    const client = await this.prisma.client.findUnique({ where: { id: clientId }, select: { id: true, number: true, name: true, isActive: true, legalForm: true } });
    if (!client) throw new NotFoundException({ code: 'not_found', message: 'Client not found' });
    const [links, workers, roles] = await Promise.all([
      this.prisma.clientPerson.findMany({ where: { clientId, endedOn: null }, include: { person: true }, orderBy: { createdAt: 'asc' } }),
      this.prisma.employee.findMany({ where: { clientId }, include: { person: true }, orderBy: [{ isActive: 'desc' }, { person: { lastName: 'asc' } }] }),
      this.lists.lookups(['person_role'], locale),
    ]);
    const roleName = new Map((roles.person_role?.items ?? []).map(item => [item.code, item.name]));
    const nameOf = (person: Pick<Person, 'firstName' | 'lastName' | 'data'>) => fullName({ firstName: person.firstName, lastName: person.lastName, infix: String(asRecord(person.data).infix ?? '') });
    const signing = this.signingLink(links);
    return {
      client,
      people: links.map(link => ({ id: link.personId, name: nameOf(link.person), role: link.role, roleName: roleName.get(link.role) ?? link.role, signs: signing?.id === link.id })),
      workers: workers.map(worker => ({ id: worker.id, personId: worker.personId, name: nameOf(worker.person), isActive: worker.isActive })),
    };
  }

  /** The person who signs for a company: the owner, else a director, else a partner. */
  private signingLink<T extends { role: string; id: string }>(links: T[]): T | null {
    return [...links].filter(link => (SIGNING_ROLES as readonly string[]).includes(link.role)).sort((a, b) => SIGNING_ROLES.indexOf(a.role as (typeof SIGNING_ROLES)[number]) - SIGNING_ROLES.indexOf(b.role as (typeof SIGNING_ROLES)[number]))[0] ?? null;
  }

  /* ── The data of one subject ──────────────────────────────────────────────────────────────────────────────────── */

  async context(input: SubjectInput, user: AuthenticatedUser, subject: string, locale: DocLocale): Promise<SubjectContext> {
    const client = await this.prisma.client.findUnique({ where: { id: input.clientId } });
    if (!client) throw new NotFoundException({ code: 'not_found', message: 'Client not found' });
    const links = await this.prisma.clientPerson.findMany({ where: { clientId: client.id, endedOn: null }, include: { person: true }, orderBy: { createdAt: 'asc' } });

    let employee: (Employee & { person: Person }) | null = null;
    if (input.employeeId) {
      employee = await this.prisma.employee.findUnique({ where: { id: input.employeeId }, include: { person: true } });
      if (!employee || employee.clientId !== client.id) throw validationFailed({ employeeId: 'validation.invalid' });
    }
    let person: Person | null = employee?.person ?? null;
    let role: string | null = null;
    if (!person && input.personId) {
      const link = links.find(entry => entry.personId === input.personId);
      if (!link) throw validationFailed({ personId: 'validation.invalid' });
      person = link.person;
    }
    if (!person && subject === 'person') person = this.signingLink(links)?.person ?? null;
    const signer = this.signingLink(links);
    if (person) role = links.find(link => link.personId === person!.id)?.role ?? null;

    const docs = await this.docs();
    const values = {
      client: { ...this.records.decode(asRecord(client.data)), ...columnValues(CLIENT_COLUMNS, client) },
      person: person ? { ...this.records.decode(asRecord(person.data)), ...columnValues(PERSON_COLUMNS, person) } : {},
      employee: employee ? { ...this.records.decode(asRecord(employee.data)), ...columnValues(EMPLOYEE_COLUMNS, employee) } : {},
    };
    const hidden = new Set<string>();
    for (const group of FORM_GROUPS) for (const field of docs[group].fields) if (!canViewField(field, user.matrix)) hidden.add(`${group}.${field.key}`);

    const listKeys = new Set<string>(['person_role']);
    const userIds = new Set<string>();
    for (const group of FORM_GROUPS) {
      for (const field of docs[group].fields) {
        if (field.list) listKeys.add(field.list);
        const value = values[group][field.key];
        if (field.type === 'user' && typeof value === 'string') userIds.add(value);
      }
    }
    const [lookups, users] = await Promise.all([this.lists.lookups([...listKeys], locale), userIds.size ? this.prisma.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, name: true } }) : []]);
    const names = new Map(Object.entries(lookups).map(([key, list]) => [key, new Map(list.items.map(item => [item.code, item.name]))]));
    const roleName = (code: string | null) => (code ? (names.get('person_role')?.get(code) ?? code) : '');

    const personValues = values.person;
    const parts = { firstName: String(personValues.first_name ?? ''), infix: String(personValues.infix ?? ''), lastName: String(personValues.last_name ?? ''), initials: String(personValues.initials ?? '') };
    const signerName = signer ? fullName({ firstName: signer.person.firstName, lastName: signer.person.lastName, infix: String(asRecord(signer.person.data).infix ?? '') }) : '';
    const computed: SubjectContext['computed'] = {
      client: { street_line: streetLine(values.client), city_line: cityLine(values.client), address: addressLine(values.client), representative_name: signerName, representative_role: roleName(signer?.role ?? null) },
      person: person
        ? { full_name: fullName(parts), initials_name: initialsName(parts), initials_derived: parts.initials.trim() || initialsOf(parts.firstName), surname: [parts.infix, parts.lastName].map(part => part.trim()).filter(Boolean).join(' '), street_line: streetLine(personValues), city_line: cityLine(personValues), address: addressLine(personValues), role: roleName(role) }
        : {},
      employee: {},
    };

    const today = todayInAmsterdam();
    const office = this.settings.group(OFFICE_NAMESPACE) as Record<string, string>;
    const officeParts = { street: office.street, house_number: office.houseNumber, house_number_suffix: office.houseNumberSuffix, postal_code: office.postalCode, city: office.city };
    const text = (type: string, value: string): Scalar => ({ raw: value, text: value, type });
    const period = input.period && isValidDay(input.period.start) && isValidDay(input.period.end) ? input.period : null;
    const scalars: SubjectContext['scalars'] = {
      office: {
        name: text('text', office.name ?? ''),
        trade_name: text('text', office.tradeName ?? ''),
        street: text('text', office.street ?? ''),
        house_number: text('text', office.houseNumber ?? ''),
        house_number_suffix: text('text', office.houseNumberSuffix ?? ''),
        postal_code: text('postcode', office.postalCode ?? ''),
        city: text('text', office.city ?? ''),
        street_line: text('text', streetLine(officeParts)),
        city_line: text('text', cityLine(officeParts)),
        address: text('text', addressLine(officeParts)),
        phone: text('phone', office.phone ?? ''),
        email: text('email', office.email ?? ''),
        website: text('url', office.website ?? ''),
        kvk: text('kvk', office.kvk ?? ''),
        vat_number: text('vat', office.vatNumber ?? ''),
        iban: text('iban', office.iban ?? ''),
      },
      form: {
        today: { raw: today, text: shortDay(today), type: 'date' },
        year: { raw: Number(today.slice(0, 4)), text: today.slice(0, 4), type: 'number' },
        place: text('text', office.city ?? ''),
        user_name: text('text', user.name),
      },
      period: period
        ? {
            start: { raw: period.start, text: shortDay(period.start), type: 'date' },
            end: { raw: period.end, text: shortDay(period.end), type: 'date' },
            year: { raw: Number(period.start.slice(0, 4)), text: period.start.slice(0, 4), type: 'number' },
          }
        : {},
    };

    return {
      locale,
      client: { id: client.id, number: client.number, name: client.name, isActive: client.isActive, legalForm: client.legalForm },
      person: person ? { id: person.id, name: fullName(parts), role } : null,
      employee: employee ? { id: employee.id, name: fullName(parts) } : null,
      docs,
      values,
      computed,
      scalars,
      hidden,
      names,
      users: new Map(users.map(entry => [entry.id, entry.name])),
    };
  }

  /** A copy of the context with other values on top (what the AI read from a photo): the keys are `client.kvk` …; a value that was hidden is shown (it came from the person's own document). */
  withOverlay(context: SubjectContext, overlay: Record<string, unknown>): SubjectContext {
    const values = { client: { ...context.values.client }, person: { ...context.values.person }, employee: { ...context.values.employee } };
    const hidden = new Set(context.hidden);
    for (const [key, value] of Object.entries(overlay)) {
      const [group, name] = key.split('.') as [string, string | undefined];
      if (!name || (group !== 'client' && group !== 'person' && group !== 'employee')) continue;
      values[group][name] = value;
      hidden.delete(key);
    }
    return { ...context, values, hidden };
  }

  /** One value, as it is stored and as a person reads it. */
  resolve(context: SubjectContext, key: string): Resolved {
    const dot = key.indexOf('.');
    if (dot < 0) return NOTHING;
    const group = key.slice(0, dot);
    const name = key.slice(dot + 1);
    if (group === 'office' || group === 'form' || group === 'period') {
      const entry = context.scalars[group][name];
      return entry ? { raw: isEmptyValue(entry.raw) ? null : entry.raw, text: entry.text, type: entry.type, restricted: false, hidden: false } : NOTHING;
    }
    if (group !== 'client' && group !== 'person' && group !== 'employee') return NOTHING;
    const computed = context.computed[group][name];
    if (computed !== undefined) return { raw: computed || null, text: computed, type: 'text', restricted: false, hidden: false };
    const field = context.docs[group].fields.find(candidate => candidate.key === name);
    if (!field || field.type === 'file') return NOTHING;
    const restricted = isRestrictedField(field);
    if (context.hidden.has(key)) return { raw: null, text: '', type: field.type, restricted, hidden: true };
    const raw = context.values[group][name];
    return { raw: isEmptyValue(raw) ? null : raw, text: this.display(field, raw, context), type: field.type, restricted, hidden: false };
  }

  /** The text a person would read for a value: dates as `31-12-2026`, choices by their name, yes / no as words. */
  private display(field: FieldDef, raw: unknown, context: SubjectContext): string {
    if (isEmptyValue(raw)) return '';
    const name = (code: unknown) => {
      const text = String(code);
      return (field.list ? context.names.get(field.list)?.get(text) : undefined) ?? field.choices.find(choice => choice.code === text)?.names[context.locale] ?? text;
    };
    switch (field.type) {
      case 'number':
        return plainNumber(Number(raw), context.locale);
      case 'money':
        return money(Number(raw), context.locale);
      case 'date':
        return typeof raw === 'string' && isValidDay(raw) ? shortDay(raw) : '';
      case 'boolean':
        return yesNo(raw === true, context.locale);
      case 'select':
        return name(raw);
      case 'multiselect':
        return (Array.isArray(raw) ? raw : [raw]).map(name).join(', ');
      case 'user':
        return context.users.get(String(raw)) ?? '';
      case 'client':
        return '';
      default:
        return String(raw);
    }
  }
}
