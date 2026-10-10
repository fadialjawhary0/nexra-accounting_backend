import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { isValidDay, parseDay } from '../../common/dates.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { fold } from '../../common/text.js';
import { Prisma, type ClientPerson, type Person } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { FilesService } from '../files/files.service.js';
import { valuesFor } from '../forms/field-access.js';
import { isEmptyValue, type FormDoc } from '../forms/form-doc.js';
import { FormRecordsService } from '../forms/form-records.service.js';
import { FormValidationService } from '../forms/form-validation.service.js';
import { FormsService } from '../forms/forms.service.js';
import { ListsService } from '../lists/lists.service.js';
import type { PermissionMatrix } from '../roles/permission-catalog.js';
import { PERSON_COLUMNS, PERSON_ENTITY, columnValues, day, displayLabel, personName, splitValues } from './client-record.js';
import { ClientsService } from './clients.service.js';
import type { AddPersonDto, PersonLookupQuery, SavePersonDto, UpdatePersonLinkDto } from './dto/client.dto.js';

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const invalid = (fields: Record<string, string>, details?: Record<string, unknown>) =>
  new UnprocessableEntityException({ code: 'validation_failed', message: 'Validation failed', fields, ...(details && { details }) });

/**
 * The people of a client: owners, directors, partners and contact persons. A person is one record that can be linked to several
 * clients (the owner of two companies) with a role at each. Restricted values (BSN, document number — the form's "sensitive"
 * fields) are stored encrypted, only shown to people with access to sensitive data, never in a list, and every time they are
 * shown the audit log says so.
 */
@Injectable()
export class ClientPeopleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly forms: FormsService,
    private readonly validation: FormValidationService,
    private readonly records: FormRecordsService,
    private readonly lists: ListsService,
    private readonly files: FilesService,
    private readonly clients: ClientsService,
  ) {}

  /* ── Reading ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  /** The people of a client, current ones first. Restricted values are left out (`sensitive` names the ones on file). */
  async list(clientId: string, user: AuthenticatedUser) {
    await this.clients.findOrThrow(clientId);
    const { doc } = await this.forms.live(PERSON_ENTITY);
    const links = await this.prisma.clientPerson.findMany({ where: { clientId }, include: { person: true }, orderBy: { createdAt: 'asc' } });
    const current = links.filter(link => !link.endedOn);
    const former = links.filter(link => link.endedOn);
    return [...current, ...former].map(link => this.serializeLink(link, link.person, doc, user.matrix));
  }

  /** One person with everything this user may see — restricted values decrypted (and logged). */
  async get(personId: string, user: AuthenticatedUser) {
    const person = await this.findOrThrow(personId);
    const { doc } = await this.forms.live(PERSON_ENTITY);
    const view = this.serialize(person, doc, user.matrix, true);
    if (view.sensitive.length) {
      await this.audit.log({ action: 'revealed', entityType: 'person', entityId: person.id, entityLabel: personName(person), meta: { fields: view.sensitive } });
    }
    return { ...view, clients: await this.clientsOf(personId) };
  }

  /** The clients a person is linked to, with their role at each. */
  private async clientsOf(personId: string) {
    const links = await this.prisma.clientPerson.findMany({ where: { personId }, include: { client: { select: { id: true, number: true, name: true } } }, orderBy: { createdAt: 'asc' } });
    return links.map(link => ({ linkId: link.id, id: link.client.id, number: link.client.number, name: link.client.name, role: link.role, endedOn: day(link.endedOn) }));
  }

  /** People matching a name, for "link an existing person". */
  async lookup(query: PersonLookupQuery) {
    const search = fold(query.search ?? '');
    const people = await this.prisma.person.findMany({
      where: search ? { searchText: { contains: search } } : {},
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      take: query.limit,
      include: { clients: { include: { client: { select: { number: true, name: true } } }, take: 3, orderBy: { createdAt: 'asc' } } },
    });
    return people.map(person => ({ id: person.id, name: personName(person), clients: person.clients.map(link => ({ number: link.client.number, name: link.client.name, role: link.role })) }));
  }

  /* ── Linking ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  /** Links a person (an existing one, or a new one made from the person form) to a client. */
  async add(clientId: string, dto: AddPersonDto, user: AuthenticatedUser) {
    const client = await this.clients.findOrThrow(clientId);
    const problems: Record<string, string> = {};
    if (!(await this.lists.activeCodes('person_role')).has(dto.role)) problems.role = 'validation.selectOption';
    if (dto.startedOn !== undefined && !isValidDay(dto.startedOn)) problems.startedOn = 'validation.invalidDate';

    let person: Person;
    if (dto.personId) {
      person = await this.findOrThrow(dto.personId);
      if (Object.keys(problems).length) throw invalid(problems);
    } else {
      if (!dto.values) throw invalid({ ...problems, first_name: 'validation.required', last_name: 'validation.required' });
      person = await this.createPerson(dto.values, user, problems);
    }

    const existing = await this.prisma.clientPerson.findUnique({ where: { clientId_personId_role: { clientId, personId: person.id, role: dto.role } } });
    if (existing && !existing.endedOn) throw invalid({ role: 'validation.alreadyExists' });
    const startedOn = dto.startedOn ? parseDay(dto.startedOn) : null;
    const link = existing
      ? await this.prisma.clientPerson.update({ where: { id: existing.id }, data: { endedOn: null, startedOn } })
      : await this.prisma.clientPerson.create({ data: { clientId, personId: person.id, role: dto.role, startedOn } });

    await this.clients.refreshSearch(clientId);
    await this.audit.log({ action: 'linked', entityType: 'client', entityId: clientId, entityLabel: displayLabel(client), meta: { person: personName(person), role: dto.role } });
    const { doc } = await this.forms.live(PERSON_ENTITY);
    return this.serializeLink(link, person, doc, user.matrix);
  }

  /** Changes the role or the dates of a link; an end date means the person no longer has that role (they stay in the history). */
  async updateLink(clientId: string, linkId: string, dto: UpdatePersonLinkDto, user: AuthenticatedUser) {
    const client = await this.clients.findOrThrow(clientId);
    const link = await this.prisma.clientPerson.findFirst({ where: { id: linkId, clientId }, include: { person: true } });
    if (!link) throw new NotFoundException({ code: 'not_found', message: 'Person not found' });

    const problems: Record<string, string> = {};
    if (dto.role !== undefined && !(await this.lists.activeCodes('person_role')).has(dto.role) && dto.role !== link.role) problems.role = 'validation.selectOption';
    for (const key of ['startedOn', 'endedOn'] as const) {
      const value = dto[key];
      if (value !== undefined && value !== null && !isValidDay(value)) problems[key] = 'validation.invalidDate';
    }
    if (dto.role !== undefined && dto.role !== link.role) {
      if (await this.prisma.clientPerson.findUnique({ where: { clientId_personId_role: { clientId, personId: link.personId, role: dto.role } } })) problems.role = 'validation.alreadyExists';
    }
    if (Object.keys(problems).length) throw invalid(problems);

    const data: Prisma.ClientPersonUpdateInput = {
      ...(dto.role !== undefined && { role: dto.role }),
      ...(dto.startedOn !== undefined && { startedOn: dto.startedOn ? parseDay(dto.startedOn) : null }),
      ...(dto.endedOn !== undefined && { endedOn: dto.endedOn ? parseDay(dto.endedOn) : null }),
    };
    const updated = await this.prisma.clientPerson.update({ where: { id: linkId }, data });
    await this.audit.log({
      action: dto.endedOn && !link.endedOn ? 'ended' : 'updated',
      entityType: 'client',
      entityId: clientId,
      entityLabel: displayLabel(client),
      meta: { person: personName(link.person), role: updated.role, ...(dto.endedOn && { endedOn: dto.endedOn }) },
    });
    const { doc } = await this.forms.live(PERSON_ENTITY);
    return this.serializeLink(updated, link.person, doc, user.matrix);
  }

  /** Takes a link away (a person added by mistake). A person who really had the role is ended instead, so the history stays. */
  async removeLink(clientId: string, linkId: string) {
    const client = await this.clients.findOrThrow(clientId);
    const link = await this.prisma.clientPerson.findFirst({ where: { id: linkId, clientId }, include: { person: true } });
    if (!link) throw new NotFoundException({ code: 'not_found', message: 'Person not found' });
    await this.prisma.clientPerson.delete({ where: { id: linkId } });
    await this.clients.refreshSearch(clientId);
    await this.audit.log({ action: 'unlinked', entityType: 'client', entityId: clientId, entityLabel: displayLabel(client), meta: { person: personName(link.person), role: link.role } });
    return { id: linkId };
  }

  /* ── The person record ────────────────────────────────────────────────────────────────────────────────────────── */

  /** Saves what was sent; fields that were left out (or that this person may not see) keep their value. */
  async update(personId: string, dto: SavePersonDto, user: AuthenticatedUser) {
    const person = await this.findOrThrow(personId);
    const { doc } = await this.forms.live(PERSON_ENTITY);
    const existing = { ...this.records.decode(asRecord(person.data)), ...columnValues(PERSON_COLUMNS, person) };

    const { values, errors } = await this.validation.check(PERSON_ENTITY, dto.values, existing, user.matrix);
    const unique = await this.records.checkUnique(PERSON_ENTITY, personId, doc, values, existing);
    await this.failIfInvalid({ ...errors, ...unique.errors }, unique.conflicts);

    const keys = Object.keys(values);
    const diff = this.records.auditChange(doc, Object.fromEntries(keys.map(key => [key, existing[key] ?? null])), Object.fromEntries(keys.map(key => [key, values[key] ?? null])));
    if (!Object.keys(diff.after).length) return this.get(personId, user);

    const { data } = splitValues(PERSON_COLUMNS, values);
    const next = { ...existing };
    for (const [key, value] of Object.entries(values)) {
      if (value === null) delete next[key];
      else next[key] = value;
    }
    const searchText = await this.records.searchText(doc, next, [`${String(next.first_name ?? '')} ${String(next.infix ?? '')} ${String(next.last_name ?? '')}`]);
    const stored = FormRecordsService.merge(asRecord(person.data), this.records.encode(doc, data));
    const updated = await this.prisma.$transaction(async tx => {
      const saved = await tx.person.update({
        where: { id: personId },
        data: {
          ...(typeof values.first_name === 'string' && { firstName: values.first_name }),
          ...(typeof values.last_name === 'string' && { lastName: values.last_name }),
          data: stored as Prisma.InputJsonObject,
          searchText,
        },
      });
      await this.records.claim(tx, PERSON_ENTITY, personId, doc, next);
      return saved;
    });
    await this.files.link(this.fileIds(doc, values), PERSON_ENTITY, personId);
    await this.audit.log({ action: 'updated', entityType: 'person', entityId: personId, entityLabel: personName(updated), before: diff.before, after: diff.after });
    // The person's name is part of the search text of every client they belong to.
    for (const link of await this.prisma.clientPerson.findMany({ where: { personId }, select: { clientId: true } })) await this.clients.refreshSearch(link.clientId);
    return { ...this.serialize(updated, doc, user.matrix, false), clients: await this.clientsOf(personId) };
  }

  /* ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  private async createPerson(input: Record<string, unknown>, user: AuthenticatedUser, problems: Record<string, string>): Promise<Person> {
    const { doc } = await this.forms.live(PERSON_ENTITY);
    const { values, errors } = await this.validation.check(PERSON_ENTITY, input, {}, user.matrix);
    const unique = await this.records.checkUnique(PERSON_ENTITY, null, doc, values, {});
    await this.failIfInvalid({ ...problems, ...errors, ...unique.errors }, unique.conflicts);

    const { columns, data } = splitValues(PERSON_COLUMNS, values);
    const searchText = await this.records.searchText(doc, values, [`${String(values.first_name ?? '')} ${String(values.infix ?? '')} ${String(values.last_name ?? '')}`]);
    const person = await this.prisma.$transaction(async tx => {
      const created = await tx.person.create({
        data: { firstName: columns.firstName ?? '', lastName: columns.lastName ?? '', data: FormRecordsService.merge({}, this.records.encode(doc, data)) as Prisma.InputJsonObject, searchText, createdById: user.id },
      });
      await this.records.claim(tx, PERSON_ENTITY, created.id, doc, values);
      return created;
    });
    await this.files.link(this.fileIds(doc, values), PERSON_ENTITY, person.id);
    await this.audit.log({ action: 'created', entityType: 'person', entityId: person.id, entityLabel: personName(person), after: this.records.auditSnapshot(doc, values) });
    return person;
  }

  /** A person as the screens get it: name, the values this user may see, and which restricted values are on file. */
  private serialize(person: Person, doc: FormDoc, matrix: PermissionMatrix, withSecrets: boolean) {
    const visible = valuesFor(doc, { ...this.records.decode(asRecord(person.data)), ...columnValues(PERSON_COLUMNS, person) }, matrix);
    const secret = [...this.records.encryptedKeys(doc)].filter(key => !isEmptyValue(visible[key]));
    if (!withSecrets) for (const key of secret) delete visible[key];
    return { id: person.id, name: personName(person), isActive: person.isActive, values: visible, sensitive: secret };
  }

  private serializeLink(link: ClientPerson, person: Person, doc: FormDoc, matrix: PermissionMatrix) {
    return { id: link.id, role: link.role, startedOn: day(link.startedOn), endedOn: day(link.endedOn), person: this.serialize(person, doc, matrix, false) };
  }

  async findOrThrow(personId: string): Promise<Person> {
    const person = await this.prisma.person.findUnique({ where: { id: personId } });
    if (!person) throw new NotFoundException({ code: 'not_found', message: 'Person not found' });
    return person;
  }

  private fileIds(doc: FormDoc, values: Record<string, unknown>): string[] {
    return doc.fields
      .filter(field => field.type === 'file')
      .map(field => (values[field.key] as { id?: unknown } | null | undefined)?.id)
      .filter((id): id is string => typeof id === 'string');
  }

  /** A 422 with the fields that are wrong; when a "unique" value is taken, it names the person who holds it. */
  private async failIfInvalid(fields: Record<string, string>, conflicts: Record<string, string>): Promise<void> {
    if (!Object.keys(fields).length) return;
    const ids = [...new Set(Object.values(conflicts))];
    const holders = ids.length ? await this.prisma.person.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, lastName: true, data: true } }) : [];
    const names = new Map(holders.map(holder => [holder.id, personName(holder)]));
    throw invalid(fields, Object.keys(conflicts).length ? { conflicts: Object.fromEntries(Object.entries(conflicts).map(([key, id]) => [key, { id, label: names.get(id) ?? '' }])) } : undefined);
  }
}
