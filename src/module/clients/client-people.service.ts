import { Injectable, NotFoundException } from '@nestjs/common';
import { isValidDay, parseDay } from '../../common/dates.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { validationFailed } from '../../common/validation/failure.js';
import type { ClientPerson, Person, Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import type { FormDoc } from '../forms/form-doc.js';
import { FormsService } from '../forms/forms.service.js';
import { ListsService } from '../lists/lists.service.js';
import { PeopleService, type PersonPlan } from '../people/people.service.js';
import type { PermissionMatrix } from '../roles/permission-catalog.js';
import { PERSON_ENTITY, day, displayLabel, personName } from './client-record.js';
import { ClientsService } from './clients.service.js';
import type { AddPersonDto, UpdatePersonLinkDto } from './dto/client.dto.js';

/**
 * The people of a client: owners, directors, partners and contact persons. A person is one record (`PeopleService`) that can be linked to
 * several clients (the owner of two companies) with a role at each; this service keeps those links, with a start and an end day so a
 * role that ended stays in the history.
 */
@Injectable()
export class ClientPeopleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly forms: FormsService,
    private readonly lists: ListsService,
    private readonly people: PeopleService,
    private readonly clients: ClientsService,
  ) {}

  /** The people of a client, current ones first. Restricted values are left out (`sensitive` names the ones on file). */
  async list(clientId: string, user: AuthenticatedUser) {
    await this.clients.findOrThrow(clientId);
    const { doc } = await this.forms.live(PERSON_ENTITY);
    const links = await this.prisma.clientPerson.findMany({ where: { clientId }, include: { person: true }, orderBy: { createdAt: 'asc' } });
    const current = links.filter(link => !link.endedOn);
    const former = links.filter(link => link.endedOn);
    return [...current, ...former].map(link => this.serializeLink(link, link.person, doc, user.matrix));
  }

  /** Links a person (an existing one, or a new one made from the person form) to a client. */
  async add(clientId: string, dto: AddPersonDto, user: AuthenticatedUser) {
    const client = await this.clients.findOrThrow(clientId);
    const problems: Record<string, string> = {};
    if (!(await this.lists.activeCodes('person_role')).has(dto.role)) problems.role = 'validation.selectOption';
    if (dto.startedOn !== undefined && !isValidDay(dto.startedOn)) problems.startedOn = 'validation.invalidDate';

    let existingPerson: Person | null = null;
    let plan: PersonPlan | null = null;
    if (dto.personId) {
      existingPerson = await this.people.findOrThrow(dto.personId);
    } else {
      if (!dto.values) throw validationFailed({ ...problems, first_name: 'validation.required', last_name: 'validation.required' });
      plan = await this.people.planCreate(dto.values, user);
    }
    if (plan) this.people.assertValid(plan, problems);
    else if (Object.keys(problems).length) throw validationFailed(problems);

    const startedOn = dto.startedOn ? parseDay(dto.startedOn) : null;
    // The person (when new) and the link are saved together: a refused link does not leave a lonely person behind.
    const { link, person, after } = await this.prisma.$transaction(async tx => {
      const saved = plan ? await plan.commit(tx) : { person: existingPerson as Person, after: async () => undefined };
      const current = await tx.clientPerson.findUnique({ where: { clientId_personId_role: { clientId, personId: saved.person.id, role: dto.role } } });
      if (current && !current.endedOn) throw validationFailed({ role: 'validation.alreadyExists' });
      const written = current
        ? await tx.clientPerson.update({ where: { id: current.id }, data: { endedOn: null, startedOn } })
        : await tx.clientPerson.create({ data: { clientId, personId: saved.person.id, role: dto.role, startedOn } });
      return { link: written, person: saved.person, after: saved.after };
    });
    await after();

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
    if (Object.keys(problems).length) throw validationFailed(problems);

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

  private serializeLink(link: ClientPerson, person: Person, doc: FormDoc, matrix: PermissionMatrix) {
    return { id: link.id, role: link.role, startedOn: day(link.startedOn), endedOn: day(link.endedOn), person: this.people.serialize(person, doc, matrix, false) };
  }
}
