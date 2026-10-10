import { Injectable, Logger, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { asRecord, columnValues, day, splitValues } from '../../common/record-values.js';
import { fold } from '../../common/text.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { conflictDetails, validationFailed } from '../../common/validation/failure.js';
import { Prisma, type Person } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { FilesService } from '../files/files.service.js';
import { valuesFor } from '../forms/field-access.js';
import { isEmptyValue, type FormDoc } from '../forms/form-doc.js';
import { FormRecordsService } from '../forms/form-records.service.js';
import { FormValidationService } from '../forms/form-validation.service.js';
import { FormsService } from '../forms/forms.service.js';
import type { PermissionMatrix } from '../roles/permission-catalog.js';
import type { PersonLookupQuery, SavePersonDto } from './dto/person.dto.js';
import { PERSON_COLUMNS, PERSON_ENTITY, nameText, personName } from './person-record.js';

/** What it takes to save a person, worked out before anything is written — so a worker and their person can be validated together. */
export interface PersonPlan {
  /** `field key → validation message key` for everything that is wrong. */
  errors: Record<string, string>;
  /** The people who already hold a value that has to be unique (a BSN), by field key. */
  conflicts: Record<string, { id: string; label: string }>;
  /** An update that changes nothing. */
  unchanged: boolean;
  /** Writes the person inside the caller's transaction. Run `after()` once the transaction has succeeded (files, audit trail, listeners). */
  commit: (tx: Prisma.TransactionClient) => Promise<{ person: Person; after: () => Promise<void> }>;
}

/**
 * People: the humans behind owners, directors, partners, contact persons and workers. One record per human, however many clients or
 * employments they are linked to. Restricted values (BSN, IBAN, document number — the form's "sensitive" fields) are stored encrypted, are
 * only shown to people with access to sensitive data, never appear in a list, and every time one is shown the audit log says so.
 */
@Injectable()
export class PeopleService implements OnModuleInit {
  private readonly logger = new Logger(PeopleService.name);
  private readonly listeners: Array<(personId: string) => Promise<void>> = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly forms: FormsService,
    private readonly validation: FormValidationService,
    private readonly records: FormRecordsService,
    private readonly files: FilesService,
  ) {}

  onModuleInit(): void {
    this.forms.onPublish(PERSON_ENTITY, () => this.reindex());
  }

  /** Modules that keep text derived from a person (a client's search text, a worker's folder name) are told when the person changed. */
  onChanged(listener: (personId: string) => Promise<void>): void {
    this.listeners.push(listener);
  }

  /* ── Reading ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  async findOrThrow(personId: string): Promise<Person> {
    const person = await this.prisma.person.findUnique({ where: { id: personId } });
    if (!person) throw new NotFoundException({ code: 'not_found', message: 'Person not found' });
    return person;
  }

  /** A person as the screens get it: name, the values this user may see, and which restricted values are on file. */
  serialize(person: Person, doc: FormDoc, matrix: PermissionMatrix, withSecrets: boolean) {
    const visible = valuesFor(doc, { ...this.records.decode(asRecord(person.data)), ...columnValues(PERSON_COLUMNS, person) }, matrix);
    const secret = [...this.records.encryptedKeys(doc)].filter(key => !isEmptyValue(visible[key]));
    if (!withSecrets) for (const key of secret) delete visible[key];
    return { id: person.id, name: personName(person), isActive: person.isActive, values: visible, sensitive: secret };
  }

  /** One person with everything this user may see — restricted values decrypted (and logged) — and where they belong. */
  async get(personId: string, user: AuthenticatedUser, { audit = true } = {}) {
    const person = await this.findOrThrow(personId);
    const { doc } = await this.forms.live(PERSON_ENTITY);
    const view = this.serialize(person, doc, user.matrix, true);
    if (audit && view.sensitive.length) {
      await this.audit.log({ action: 'revealed', entityType: 'person', entityId: person.id, entityLabel: personName(person), meta: { fields: view.sensitive } });
    }
    return { ...view, ...(await this.belongsTo(personId)) };
  }

  /** The clients a person is linked to (with their role there) and the clients they work for. */
  async belongsTo(personId: string) {
    const [links, employments] = await Promise.all([
      this.prisma.clientPerson.findMany({ where: { personId }, include: { client: { select: { id: true, number: true, name: true } } }, orderBy: { createdAt: 'asc' } }),
      this.prisma.employee.findMany({ where: { personId }, include: { client: { select: { id: true, number: true, name: true } } }, orderBy: { createdAt: 'asc' } }),
    ]);
    return {
      clients: links.map(link => ({ linkId: link.id, id: link.client.id, number: link.client.number, name: link.client.name, role: link.role, endedOn: day(link.endedOn) })),
      employments: employments.map(entry => ({ id: entry.id, clientId: entry.client.id, number: entry.client.number, name: entry.client.name, isActive: entry.isActive })),
    };
  }

  /** People matching a name, for "use an existing person". */
  async lookup(query: PersonLookupQuery) {
    const search = fold(query.search ?? '');
    const people = await this.prisma.person.findMany({
      where: search ? { searchText: { contains: search } } : {},
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      take: query.limit,
      include: {
        clients: { include: { client: { select: { number: true, name: true } } }, take: 3, orderBy: { createdAt: 'asc' } },
        employments: { include: { client: { select: { number: true, name: true } } }, take: 3, orderBy: { createdAt: 'asc' } },
      },
    });
    return people.map(person => ({
      id: person.id,
      name: personName(person),
      clients: [
        ...person.clients.map(link => ({ number: link.client.number, name: link.client.name, role: link.role })),
        ...person.employments.map(entry => ({ number: entry.client.number, name: entry.client.name, role: 'employee' })),
      ].slice(0, 3),
    }));
  }

  /* ── Saving ───────────────────────────────────────────────────────────────────────────────────────────────────── */

  /** Checks a new person's values; nothing is written until `commit` runs. */
  async planCreate(input: Record<string, unknown>, user: AuthenticatedUser): Promise<PersonPlan> {
    const { doc } = await this.forms.live(PERSON_ENTITY);
    const { values, errors } = await this.validation.check(PERSON_ENTITY, input, {}, user.matrix);
    const unique = await this.records.checkUnique(PERSON_ENTITY, null, doc, values, {});
    return {
      errors: { ...errors, ...unique.errors },
      conflicts: await this.holders(unique.conflicts),
      unchanged: false,
      commit: async tx => {
        const { columns, data } = splitValues(PERSON_COLUMNS, values);
        const searchText = await this.records.searchText(doc, values, [nameText(values)]);
        const person = await tx.person.create({
          data: {
            firstName: columns.firstName ?? '',
            lastName: columns.lastName ?? '',
            // A field left empty is simply not stored (a form sends `null` for every empty field).
            data: FormRecordsService.merge({}, this.records.encode(doc, data)) as Prisma.InputJsonObject,
            searchText,
            createdById: user.id,
          },
        });
        await this.records.claim(tx, PERSON_ENTITY, person.id, doc, values);
        return {
          person,
          after: async () => {
            await this.files.link(this.fileIds(doc, values), PERSON_ENTITY, person.id);
            await this.audit.log({ action: 'created', entityType: 'person', entityId: person.id, entityLabel: personName(person), after: this.records.auditSnapshot(doc, values) });
          },
        };
      },
    };
  }

  /** Checks changes to a person; fields that were left out (or that this user may not see) keep their value. */
  async planUpdate(personId: string, input: Record<string, unknown>, user: AuthenticatedUser): Promise<PersonPlan> {
    const person = await this.findOrThrow(personId);
    const { doc } = await this.forms.live(PERSON_ENTITY);
    const existing = { ...this.records.decode(asRecord(person.data)), ...columnValues(PERSON_COLUMNS, person) };

    const { values, errors } = await this.validation.check(PERSON_ENTITY, input, existing, user.matrix);
    const unique = await this.records.checkUnique(PERSON_ENTITY, personId, doc, values, existing);
    const keys = Object.keys(values);
    const diff = this.records.auditChange(doc, Object.fromEntries(keys.map(key => [key, existing[key] ?? null])), Object.fromEntries(keys.map(key => [key, values[key] ?? null])));
    const unchanged = !Object.keys(diff.after).length;

    return {
      errors: { ...errors, ...unique.errors },
      conflicts: await this.holders(unique.conflicts),
      unchanged,
      commit: async tx => {
        if (unchanged) return { person, after: async () => undefined };
        const { data } = splitValues(PERSON_COLUMNS, values);
        const next = { ...existing };
        for (const [key, value] of Object.entries(values)) {
          if (value === null) delete next[key];
          else next[key] = value;
        }
        const searchText = await this.records.searchText(doc, next, [nameText(next)]);
        const stored = FormRecordsService.merge(asRecord(person.data), this.records.encode(doc, data));
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
        return {
          person: saved,
          after: async () => {
            await this.files.link(this.fileIds(doc, values), PERSON_ENTITY, personId);
            await this.audit.log({ action: 'updated', entityType: 'person', entityId: personId, entityLabel: personName(saved), before: diff.before, after: diff.after });
            await this.changed(personId);
          },
        };
      },
    };
  }

  /** Answers a 422 when the plan found problems (`extra` = problems of the form the person is saved with). */
  assertValid(plan: Pick<PersonPlan, 'errors' | 'conflicts'>, extra: Record<string, string> = {}): void {
    const fields = { ...extra, ...plan.errors };
    if (Object.keys(fields).length) throw validationFailed(fields, conflictDetails(plan.conflicts));
  }

  /** Saves the person's own changes (the person dialogs). */
  async update(personId: string, dto: SavePersonDto, user: AuthenticatedUser) {
    const plan = await this.planUpdate(personId, dto.values, user);
    this.assertValid(plan);
    const { person, after } = await this.prisma.$transaction(tx => plan.commit(tx));
    await after();
    const { doc } = await this.forms.live(PERSON_ENTITY);
    return { ...this.serialize(person, doc, user.matrix, false), ...(await this.belongsTo(personId)) };
  }

  /** Rebuilds the search text and the unique values of every person (after the person form changed). */
  async reindex(): Promise<void> {
    const { doc } = await this.forms.live(PERSON_ENTITY);
    const people = await this.prisma.person.findMany();
    const claims: Array<{ entity: string; fieldKey: string; value: string; recordId: string }> = [];
    for (const person of people) {
      const values = { ...this.records.decode(asRecord(person.data)), ...columnValues(PERSON_COLUMNS, person) };
      const searchText = await this.records.searchText(doc, values, [nameText(values)]);
      if (searchText !== person.searchText) await this.prisma.person.update({ where: { id: person.id }, data: { searchText } });
      claims.push(...this.records.uniqueClaims(PERSON_ENTITY, person.id, doc, values));
    }
    await this.prisma.$transaction([this.prisma.uniqueFieldValue.deleteMany({ where: { entity: PERSON_ENTITY } }), this.prisma.uniqueFieldValue.createMany({ data: claims, skipDuplicates: true })]);
    this.logger.log(`Reindexed ${people.length} people.`);
  }

  /** Tells the modules that keep text derived from the person that it changed. */
  async changed(personId: string): Promise<void> {
    for (const listener of this.listeners) await listener(personId).catch((error: unknown) => this.logger.error(`A person-changed listener failed: ${String(error)}`));
  }

  /* ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  private fileIds(doc: FormDoc, values: Record<string, unknown>): string[] {
    return doc.fields
      .filter(field => field.type === 'file')
      .map(field => (values[field.key] as { id?: unknown } | null | undefined)?.id)
      .filter((id): id is string => typeof id === 'string');
  }

  /** `field key → holder's id` becomes `field key → { id, name }` so the screen can say who has the value. */
  private async holders(conflicts: Record<string, string>): Promise<Record<string, { id: string; label: string }>> {
    const ids = [...new Set(Object.values(conflicts))];
    const people = ids.length ? await this.prisma.person.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, lastName: true, data: true } }) : [];
    const names = new Map(people.map(person => [person.id, personName(person)]));
    return Object.fromEntries(Object.entries(conflicts).map(([key, id]) => [key, { id, label: names.get(id) ?? '' }]));
  }
}
