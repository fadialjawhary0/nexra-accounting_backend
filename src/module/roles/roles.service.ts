import { ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import type { Role } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { SecuritySettingsService } from '../security-settings/security-settings.service.js';
import type { CreateRoleDto, UpdateRoleDto } from './dto/role.dto.js';
import { OWNER_ROLE_KEY, PERMISSION_ACTIONS, PERMISSION_AREAS, PERMISSION_GROUPS, escalations, roleMatrix, sanitizeMatrix } from './permission-catalog.js';

interface Counts {
  userCount: number;
  totalUsers: number;
}

const toKey = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

/** A role as the frontend knows it. `userCount` = people who can use it today (active + invited), `totalUsers` = every account holding it. */
const serialize = (role: Role, counts: Counts) => ({
  id: role.id,
  key: role.key,
  name: role.name,
  description: role.description,
  system: role.isSystem,
  basedOn: role.basedOn,
  permissions: roleMatrix(role),
  requireTwoFactor: role.requireTwoFactor,
  createdAt: role.createdAt,
  ...counts,
});

@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly security: SecuritySettingsService,
  ) {}

  /** The areas and actions a role can be given — the Roles page draws its matrix from this. */
  catalog() {
    return { actions: PERMISSION_ACTIONS, groups: PERMISSION_GROUPS, areas: PERMISSION_AREAS };
  }

  async list() {
    const [roles, members] = await Promise.all([this.prisma.role.findMany({ orderBy: { createdAt: 'asc' } }), this.prisma.user.findMany({ select: { roleId: true, status: true } })]);
    return roles.map(role => serialize(role, this.countsOf(role.id, members)));
  }

  async get(id: string) {
    const role = await this.findOrThrow(id);
    return serialize(role, await this.countFor(role.id));
  }

  async create(dto: CreateRoleDto, actor: AuthenticatedUser) {
    const fields: Record<string, string> = {};
    const name = dto.name.trim();
    const key = toKey(name);
    if (!name) fields.name = 'validation.required';
    else if (!key) fields.name = 'validation.invalid';
    else if (await this.nameTaken(name, key)) fields.name = 'validation.alreadyExists';
    const base = dto.basedOn ? await this.prisma.role.findUnique({ where: { key: dto.basedOn } }) : null;
    if (dto.basedOn && !base) fields.basedOn = 'validation.selectOption';
    if (Object.keys(fields).length) throw new UnprocessableEntityException({ code: 'validation_failed', message: 'Validation failed', fields });

    const permissions = base ? roleMatrix(base) : sanitizeMatrix({ dashboard: ['view'] });
    this.assertNoEscalation(actor, {}, permissions);
    const role = await this.prisma.role.create({ data: { key, name, description: dto.description?.trim() ?? '', basedOn: base?.key ?? null, permissions } });
    await this.audit.log({ action: 'created', entityType: 'role', entityId: role.id, entityLabel: role.name, after: { name: role.name, basedOn: role.basedOn, permissions } });
    return serialize(role, { userCount: 0, totalUsers: 0 });
  }

  async update(id: string, dto: UpdateRoleDto, actor: AuthenticatedUser) {
    const role = await this.findOrThrow(id);
    const patch: { name?: string; description?: string; requireTwoFactor?: boolean; permissions?: Record<string, string[]> } = {};

    // Built-in roles keep their names: other screens and the seed refer to them.
    if (dto.name !== undefined && !role.isSystem) {
      const name = dto.name.trim();
      const key = toKey(name);
      if (!key) throw new UnprocessableEntityException({ code: 'validation_failed', message: 'Validation failed', fields: { name: 'validation.invalid' } });
      if (await this.nameTaken(name, key, role.id)) throw new UnprocessableEntityException({ code: 'validation_failed', message: 'Validation failed', fields: { name: 'validation.alreadyExists' } });
      patch.name = name;
    }
    if (dto.description !== undefined) patch.description = dto.description.trim();
    if (dto.requireTwoFactor !== undefined) {
      // Requiring it for the role you belong to would lock you out until you have set it up yourself.
      if (dto.requireTwoFactor && !role.requireTwoFactor && actor.actualRoleKey === role.key) await this.security.assertHasTwoFactor(actor.id);
      patch.requireTwoFactor = dto.requireTwoFactor;
    }
    // The owner always keeps full access — otherwise nobody could repair a mistake.
    if (dto.permissions !== undefined && role.key !== OWNER_ROLE_KEY) {
      const permissions = sanitizeMatrix(dto.permissions);
      this.assertNoEscalation(actor, roleMatrix(role), permissions);
      patch.permissions = permissions;
    }

    const updated = await this.prisma.role.update({ where: { id }, data: patch });
    const changed = AuditService.changes(
      { name: role.name, description: role.description, requireTwoFactor: role.requireTwoFactor, permissions: roleMatrix(role) },
      { name: updated.name, description: updated.description, requireTwoFactor: updated.requireTwoFactor, permissions: roleMatrix(updated) },
    );
    if (Object.keys(changed.after).length) await this.audit.log({ action: 'updated', entityType: 'role', entityId: role.id, entityLabel: updated.name, before: changed.before, after: changed.after });
    return serialize(updated, await this.countFor(id));
  }

  async remove(id: string) {
    const role = await this.findOrThrow(id);
    if (role.isSystem) throw new ConflictException({ code: 'system_role', message: 'Built-in roles cannot be deleted.' });
    const members = await this.prisma.user.count({ where: { roleId: id } });
    if (members) throw new ConflictException({ code: 'role_in_use', message: `${members} ${members === 1 ? 'person still has' : 'people still have'} the role “${role.name}”. Give them another role before deleting it.`, details: { members, name: role.name } });
    await this.prisma.role.delete({ where: { id } });
    await this.audit.log({ action: 'deleted', entityType: 'role', entityId: id, entityLabel: role.name });
    return { id };
  }

  private async findOrThrow(id: string): Promise<Role> {
    const role = await this.prisma.role.findUnique({ where: { id } });
    if (!role) throw new NotFoundException({ code: 'not_found', message: 'Role not found' });
    return role;
  }

  private nameTaken(name: string, key: string, ignoreId?: string): Promise<boolean> {
    return this.prisma.role
      .findFirst({ where: { id: ignoreId ? { not: ignoreId } : undefined, OR: [{ name: { equals: name, mode: 'insensitive' } }, { key }] }, select: { id: true } })
      .then(Boolean);
  }

  private assertNoEscalation(actor: AuthenticatedUser, before: Record<string, string[]>, after: Record<string, string[]>): void {
    const beyond = escalations(actor.matrix, before, after);
    if (beyond.length) throw new ForbiddenException({ code: 'cannot_grant_more_access', message: 'You cannot give a role more access than you have yourself.', details: { missing: beyond } });
  }

  private async countFor(roleId: string): Promise<Counts> {
    return this.countsOf(roleId, await this.prisma.user.findMany({ where: { roleId }, select: { roleId: true, status: true } }));
  }

  private countsOf(roleId: string, members: Array<{ roleId: string; status: string }>): Counts {
    const own = members.filter(member => member.roleId === roleId);
    return { userCount: own.filter(member => member.status !== 'disabled').length, totalUsers: own.length };
  }
}
