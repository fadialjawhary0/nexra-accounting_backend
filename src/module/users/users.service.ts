import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { paged, type ApiResult } from '../../common/api-result.js';
import type { AppLocale } from '../../common/decorators/locale.decorator.js';
import { pageMeta, toOrderBy, toSkipTake } from '../../common/pagination.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { isValidPhone } from '../../common/validation/phone.js';
import type { Prisma, UserStatus } from '../../generated/prisma/client.js';
import { AuditService } from '../../lib/audit/audit.service.js';
import { AppConfigService } from '../../lib/config/app-config.service.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { MAX_EXPORT_ROWS, type ExportTable } from '../../lib/exports/export.types.js';
import { inviteMail, resetMail, type MailLocale } from '../../lib/mail/mail-templates.js';
import { MailService } from '../../lib/mail/mail.service.js';
import { AccountTokenService, INVITE_TTL_MS, RESET_TTL_MS } from '../auth/account-token.service.js';
import { TokenService } from '../auth/token.service.js';
import { TwoFactorService } from '../auth/two-factor.service.js';
import { OPEN_STATUSES as OPEN_INSPECTION_STATUSES } from '../inspections/inspections.constants.js';
import { OPEN_RETURN_STATUSES } from '../taxes/taxes.constants.js';
import { ListsService } from '../lists/lists.service.js';
import { OWNER_ROLE_KEY, effectiveMatrix, escalations, sanitizeOverrides } from '../roles/permission-catalog.js';
import type { InviteUserDto, UpdateUserDto, UserListQuery } from './dto/user.dto.js';
import { EMPTY_WORKLOAD, serializeUser, type UserWithRole, type UserWorkload } from './user.serializer.js';

const STATUSES: readonly string[] = ['active', 'invited', 'disabled'];
const SORTABLE = ['name', 'email', 'role.name', 'status', 'lastActiveAt', 'createdAt'] as const;

const splitList = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);

const validationFailed = (fields: Record<string, string>) => new UnprocessableEntityException({ code: 'validation_failed', message: 'Validation failed', fields });
const mailLocale = (locale: string): MailLocale => (locale === 'en' ? 'en' : 'nl');

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    private readonly mail: MailService,
    private readonly accountTokens: AccountTokenService,
    private readonly tokens: TokenService,
    private readonly twoFactor: TwoFactorService,
    private readonly lists: ListsService,
  ) {}

  /* ── Reading ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  async list(query: UserListQuery): Promise<ApiResult> {
    const where = this.where(query);
    // The role column sorts by the role's name.
    const sort = query.sort?.replace(/(^|,)role(?=[:,]|$)/g, '$1role.name');
    const [rows, total, stats] = await Promise.all([
      this.prisma.user.findMany({ where, include: { role: true }, orderBy: toOrderBy(sort, SORTABLE, [{ name: 'asc' }]) as Prisma.UserOrderByWithRelationInput[], ...toSkipTake(query) }),
      this.prisma.user.count({ where }),
      query.stats ? this.stats() : undefined,
    ]);
    const workloads = await this.workloads(rows.map(row => row.id));
    return paged(
      rows.map(row => serializeUser(row, workloads.get(row.id) ?? EMPTY_WORKLOAD)),
      pageMeta(total, query, stats ? { stats } : {}),
    );
  }

  async get(id: string) {
    const user = await this.findOrThrow(id);
    return serializeUser(user, (await this.workloads([id])).get(id) ?? EMPTY_WORKLOAD);
  }

  /** The people who can be chosen in a "staff member" field: active users (and the one already chosen, even if switched off). */
  async lookup(include?: string) {
    const users = await this.prisma.user.findMany({
      where: { OR: [{ status: 'active' }, ...(include ? [{ id: include }] : [])] },
      select: { id: true, name: true, status: true },
      orderBy: { name: 'asc' },
    });
    return users.map(user => ({ id: user.id, name: user.name, active: user.status === 'active' }));
  }

  /** What each person is responsible for: the active clients they handle, the yearly returns still to file and the open inspections assigned to them (the other counters arrive with their modules). */
  private async workloads(ids: string[]): Promise<Map<string, UserWorkload>> {
    const workloads = new Map<string, UserWorkload>();
    if (!ids.length) return workloads;
    const [clients, inspections, returns] = await Promise.all([
      this.prisma.client.groupBy({ by: ['responsibleUserId'], where: { isActive: true, responsibleUserId: { in: ids } }, _count: { _all: true } }),
      this.prisma.inspection.groupBy({ by: ['assigneeId'], where: { isActive: true, status: { in: [...OPEN_INSPECTION_STATUSES] }, assigneeId: { in: ids } }, _count: { _all: true } }),
      this.prisma.taxReturn.groupBy({ by: ['assigneeId'], where: { isActive: true, status: { in: [...OPEN_RETURN_STATUSES] }, assigneeId: { in: ids } }, _count: { _all: true } }),
    ]);
    const add = (userId: string | null, field: 'clients' | 'openInspections' | 'openReturns', count: number) => {
      if (!userId) return;
      const workload = workloads.get(userId) ?? { ...EMPTY_WORKLOAD };
      workload[field] += count;
      workload.total += count;
      workloads.set(userId, workload);
    };
    for (const group of clients) add(group.responsibleUserId, 'clients', group._count._all);
    for (const group of inspections) add(group.assigneeId, 'openInspections', group._count._all);
    for (const group of returns) add(group.assigneeId, 'openReturns', group._count._all);
    return workloads;
  }

  /** The list (same filters, same sort, all pages) as a table for Excel / PDF / Word. */
  async exportTable(query: UserListQuery, locale: AppLocale): Promise<{ table: ExportTable; count: number }> {
    const sort = query.sort?.replace(/(^|,)role(?=[:,]|$)/g, '$1role.name');
    const [rows, lookups] = await Promise.all([
      this.prisma.user.findMany({ where: this.where(query), include: { role: true }, orderBy: toOrderBy(sort, SORTABLE, [{ name: 'asc' }]) as Prisma.UserOrderByWithRelationInput[], take: MAX_EXPORT_ROWS + 1 }),
      this.lists.lookups(['user_status'], locale),
    ]);
    const statusNames = new Map((lookups.user_status?.items ?? []).map(item => [item.code, item.name]));
    const nl = locale === 'nl';
    const filters = [
      query.search?.trim() ? `${nl ? 'Zoekterm' : 'Search'}: ${query.search.trim()}` : null,
      query.role ? `${nl ? 'Rol' : 'Role'}: ${splitList(query.role).join(', ')}` : null,
      query.status ? `${nl ? 'Status' : 'Status'}: ${splitList(query.status).map(code => statusNames.get(code) ?? code).join(', ')}` : null,
      query.twoFactor !== undefined ? `${nl ? 'Tweestapsverificatie' : 'Two-step verification'}: ${query.twoFactor ? (nl ? 'aan' : 'on') : nl ? 'uit' : 'off'}` : null,
    ].filter(Boolean);
    return {
      count: rows.length,
      table: {
        title: nl ? 'Gebruikers' : 'Users',
        subtitle: filters.join(' · ') || undefined,
        locale,
        columns: [
          { key: 'name', header: nl ? 'Naam' : 'Name', width: 26 },
          { key: 'email', header: nl ? 'E-mailadres' : 'E-mail address', width: 34 },
          { key: 'title', header: nl ? 'Functie' : 'Job title', width: 22 },
          { key: 'role', header: nl ? 'Rol' : 'Role', width: 16 },
          { key: 'status', header: 'Status', width: 14 },
          { key: 'twoFactor', header: nl ? 'Tweestaps' : 'Two-step', type: 'boolean' },
          { key: 'lastActiveAt', header: nl ? 'Laatst actief' : 'Last active', type: 'datetime' },
          { key: 'createdAt', header: nl ? 'Aangemaakt' : 'Created', type: 'date' },
        ],
        rows: rows.slice(0, MAX_EXPORT_ROWS).map(user => ({
          name: user.name,
          email: user.email,
          title: user.title,
          role: user.role.name,
          status: statusNames.get(user.status) ?? user.status,
          twoFactor: user.twoFactorEnabled,
          lastActiveAt: user.lastActiveAt,
          createdAt: user.createdAt,
        })),
      },
    };
  }

  /* ── Inviting and editing ─────────────────────────────────────────────────────────────────────────────────────── */

  /** Creates the account (status "invited", no password yet) and e-mails the link where the person chooses one. */
  async invite(dto: InviteUserDto, actor: AuthenticatedUser) {
    const email = dto.email.trim().toLowerCase();
    const name = dto.name.trim();
    const phone = dto.phone?.trim() ?? '';
    const fields: Record<string, string> = {};
    if (!name) fields.name = 'validation.required';
    if (await this.prisma.user.findUnique({ where: { email }, select: { id: true } })) fields.email = 'validation.alreadyExists';
    const role = await this.prisma.role.findUnique({ where: { key: dto.roleKey } });
    if (!role) fields.roleKey = 'validation.selectOption';
    if (!isValidPhone(phone)) fields.phone = 'validation.invalidPhone';
    if (Object.keys(fields).length || !role) throw validationFailed(fields);

    const overrides = role.key === OWNER_ROLE_KEY ? {} : sanitizeOverrides(dto.permissionOverrides);
    this.assertNoEscalation(actor, {}, effectiveMatrix(role, overrides));
    const user = await this.prisma.user.create({
      data: { email, name, title: dto.title?.trim() ?? '', phone, locale: dto.locale ?? 'nl', roleId: role.id, status: 'invited', invitedAt: new Date(), permissionOverrides: overrides, twoFactorRequired: dto.twoFactorRequired ?? false },
      include: { role: true },
    });
    await this.audit.log({ action: 'created', entityType: 'user', entityId: user.id, entityLabel: user.name, after: { email: user.email, role: role.name, invited: true } });
    const mailDelivered = await this.sendInvite(user, actor.name);
    return { ...serializeUser(user, EMPTY_WORKLOAD), mailDelivered };
  }

  async resendInvite(id: string, actor: AuthenticatedUser) {
    const user = await this.findOrThrow(id);
    if (user.status !== 'invited') throw new ConflictException({ code: 'no_invitation', message: `${user.name} has already joined, so there is no invitation to re-send.`, details: { name: user.name } });
    const updated = await this.prisma.user.update({ where: { id }, data: { invitedAt: new Date() }, include: { role: true } });
    const mailDelivered = await this.sendInvite(updated, actor.name);
    await this.audit.log({ action: 'invite_resent', entityType: 'user', entityId: id, entityLabel: user.name, meta: { mailDelivered } });
    return { ...serializeUser(updated, EMPTY_WORKLOAD), mailDelivered };
  }

  async update(id: string, dto: UpdateUserDto, actor: AuthenticatedUser) {
    const existing = await this.findOrThrow(id);
    const fields: Record<string, string> = {};
    const data: Prisma.UserUncheckedUpdateInput = {};
    let role = existing.role;
    let overrides = sanitizeOverrides(existing.permissionOverrides);

    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (name) data.name = name;
      else fields.name = 'validation.required';
    }
    if (dto.email !== undefined) {
      const email = dto.email.trim().toLowerCase();
      if (email !== existing.email) {
        if (await this.prisma.user.findUnique({ where: { email }, select: { id: true } })) fields.email = 'validation.alreadyExists';
        else data.email = email;
      }
    }
    if (dto.title !== undefined) data.title = dto.title.trim();
    if (dto.phone !== undefined) {
      const phone = dto.phone.trim();
      if (isValidPhone(phone)) data.phone = phone;
      else fields.phone = 'validation.invalidPhone';
    }
    if (dto.locale !== undefined) data.locale = dto.locale;
    if (dto.twoFactorRequired !== undefined) data.twoFactorRequired = dto.twoFactorRequired;

    if (dto.roleKey !== undefined && dto.roleKey !== existing.role.key) {
      if (existing.id === actor.id) throw new ForbiddenException({ code: 'cannot_change_own_role', message: 'You cannot change your own role.' });
      const next = await this.prisma.role.findUnique({ where: { key: dto.roleKey } });
      if (!next) fields.roleKey = 'validation.selectOption';
      else {
        if (existing.role.key === OWNER_ROLE_KEY && (await this.isLastActiveOwner(existing))) {
          throw new ConflictException({ code: 'last_owner', message: `${existing.name} is the only active owner. Make someone else an owner first.`, details: { name: existing.name } });
        }
        role = next;
        data.roleId = next.id;
      }
    }
    if (dto.permissionOverrides !== undefined) {
      if (existing.id === actor.id) throw new ForbiddenException({ code: 'cannot_change_own_access', message: 'You cannot change your own access.' });
      overrides = role.key === OWNER_ROLE_KEY ? {} : sanitizeOverrides(dto.permissionOverrides);
      data.permissionOverrides = overrides;
    }
    if (Object.keys(fields).length) throw validationFailed(fields);

    this.assertNoEscalation(actor, effectiveMatrix(existing.role, existing.permissionOverrides), effectiveMatrix(role, overrides));
    const updated = await this.prisma.user.update({ where: { id }, data, include: { role: true } });
    const before = this.auditView(existing);
    const after = this.auditView(updated);
    const changed = AuditService.changes(before, after);
    if (Object.keys(changed.after).length) await this.audit.log({ action: 'updated', entityType: 'user', entityId: id, entityLabel: updated.name, before: changed.before, after: changed.after });
    return serializeUser(updated, EMPTY_WORKLOAD);
  }

  /** Disable (the person can no longer sign in; everything stays for history) or reactivate. */
  async setStatus(id: string, status: 'active' | 'disabled', actor: AuthenticatedUser) {
    const user = await this.findOrThrow(id);
    if (user.id === actor.id) throw new ConflictException({ code: 'cannot_change_own_status', message: 'You cannot change the status of your own account.' });
    if (user.status === status) return serializeUser(user, EMPTY_WORKLOAD);
    if (user.status === 'invited') throw new ConflictException({ code: 'invitation_pending', message: `${user.name} has not accepted the invitation yet. Re-send it, or delete the invitation.`, details: { name: user.name } });
    if (status === 'disabled' && (await this.isLastActiveOwner(user))) {
      throw new ConflictException({ code: 'last_owner', message: `${user.name} is the only active owner. Make someone else an owner first.`, details: { name: user.name } });
    }
    const updated = await this.prisma.user.update({ where: { id }, data: { status, disabledAt: status === 'disabled' ? new Date() : null }, include: { role: true } });
    if (status === 'disabled') await this.tokens.revokeAllForUser(id, 'account_disabled');
    await this.audit.log({ action: status === 'disabled' ? 'deactivated' : 'activated', entityType: 'user', entityId: id, entityLabel: user.name });
    return serializeUser(updated, EMPTY_WORKLOAD);
  }

  /** Removes an account that never worked in the system (an unaccepted invitation). Anybody else is disabled, never deleted. */
  async remove(id: string, actor: AuthenticatedUser) {
    const user = await this.findOrThrow(id);
    if (user.id === actor.id) throw new ConflictException({ code: 'cannot_delete_self', message: 'You cannot delete your own account.' });
    if (await this.isLastActiveOwner(user)) throw new ConflictException({ code: 'last_owner', message: `${user.name} is the only active owner and cannot be deleted.`, details: { name: user.name } });
    if (user.lastActiveAt) {
      throw new ConflictException({ code: 'user_has_history', message: `${user.name} has worked in the system, so the account is kept for the history. Disable it instead.`, details: { name: user.name } });
    }
    await this.prisma.user.delete({ where: { id } });
    await this.audit.log({ action: 'deleted', entityType: 'user', entityId: id, entityLabel: user.name, meta: { invitation: user.status === 'invited' } });
    return { id };
  }

  /* ── Help for people who are locked out ───────────────────────────────────────────────────────────────────────── */

  /** Signs the person out everywhere, makes them choose a new password at the next sign-in, and e-mails them a reset link. */
  async resetPassword(id: string) {
    const user = await this.findOrThrow(id);
    if (user.status !== 'active') throw new ConflictException({ code: 'no_password_yet', message: `${user.name} has no password yet. Re-send the invitation instead.`, details: { name: user.name } });
    await this.prisma.user.update({ where: { id }, data: { mustChangePassword: true } });
    await this.tokens.revokeAllForUser(id, 'password_reset_by_admin');
    const { token } = await this.accountTokens.issue(id, 'reset');
    const message = resetMail(mailLocale(user.locale), { name: user.name, link: `${this.config.frontendUrl}/reset-password?token=${token}`, minutes: RESET_TTL_MS / 60_000 });
    const mailDelivered = await this.deliver(user.email, message);
    await this.audit.log({ action: 'password_reset_requested', entityType: 'user', entityId: id, entityLabel: user.name, meta: { byAdministrator: true, mailDelivered } });
    return { ok: true, mailDelivered };
  }

  /** For somebody who lost their phone: switches their two-step verification off so they can set it up again. */
  async resetTwoFactor(id: string, actor: AuthenticatedUser) {
    const user = await this.findOrThrow(id);
    if (user.id === actor.id) throw new ConflictException({ code: 'use_profile_for_two_factor', message: 'Turn off your own two-step verification in your profile.' });
    if (!user.twoFactorEnabled) throw new ConflictException({ code: 'two_factor_not_enabled', message: `${user.name} does not use two-step verification.`, details: { name: user.name } });
    await this.twoFactor.disable(id);
    await this.tokens.revokeAllForUser(id, 'two_factor_reset');
    await this.audit.log({ action: 'two_factor_reset', entityType: 'user', entityId: id, entityLabel: user.name });
    return serializeUser(await this.findOrThrow(id), EMPTY_WORKLOAD);
  }

  /* ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────── */

  private where(query: UserListQuery): Prisma.UserWhereInput {
    const roles = splitList(query.role);
    const statuses = splitList(query.status).filter(status => STATUSES.includes(status)) as UserStatus[];
    const search = query.search?.trim();
    return {
      ...(roles.length && { role: { key: { in: roles } } }),
      ...(statuses.length && { status: { in: statuses } }),
      ...(query.twoFactor !== undefined && { twoFactorEnabled: query.twoFactor }),
      ...(search && {
        OR: [{ name: { contains: search, mode: 'insensitive' as const } }, { email: { contains: search, mode: 'insensitive' as const } }, { title: { contains: search, mode: 'insensitive' as const } }],
      }),
    };
  }

  private async stats() {
    const count = (where: Prisma.UserWhereInput = {}) => this.prisma.user.count({ where });
    const weekAgo = new Date(Date.now() - 7 * 86_400_000);
    const [total, active, invited, disabled, twoFactor, twoFactorActive, activeThisWeek] = await Promise.all([
      count(),
      count({ status: 'active' }),
      count({ status: 'invited' }),
      count({ status: 'disabled' }),
      count({ twoFactorEnabled: true }),
      count({ status: 'active', twoFactorEnabled: true }),
      count({ status: 'active', lastActiveAt: { gte: weekAgo } }),
    ]);
    return { total, active, invited, disabled, twoFactor, twoFactorActive, activeThisWeek };
  }

  private async findOrThrow(id: string): Promise<UserWithRole> {
    const user = await this.prisma.user.findUnique({ where: { id }, include: { role: true } });
    if (!user) throw new NotFoundException({ code: 'not_found', message: 'User not found' });
    return user;
  }

  /** The practice must always keep one active owner, otherwise nobody could manage users or settings again. */
  private async isLastActiveOwner(user: UserWithRole): Promise<boolean> {
    if (user.role.key !== OWNER_ROLE_KEY || user.status !== 'active') return false;
    return (await this.prisma.user.count({ where: { status: 'active', role: { key: OWNER_ROLE_KEY } } })) <= 1;
  }

  private assertNoEscalation(actor: AuthenticatedUser, before: Record<string, string[]>, after: Record<string, string[]>): void {
    const beyond = escalations(actor.matrix, before, after);
    if (beyond.length) throw new ForbiddenException({ code: 'cannot_grant_more_access', message: 'You cannot give anybody more access than you have yourself.', details: { missing: beyond } });
  }

  /** What an update writes into the audit trail: readable values, no secrets. */
  private auditView(user: UserWithRole): Record<string, unknown> {
    return {
      name: user.name,
      email: user.email,
      title: user.title,
      phone: user.phone,
      locale: user.locale,
      role: user.role.name,
      twoFactorRequired: user.twoFactorRequired,
      permissionOverrides: user.permissionOverrides,
    };
  }

  private async sendInvite(user: UserWithRole, inviter: string): Promise<boolean> {
    const { token } = await this.accountTokens.issue(user.id, 'invite');
    const message = inviteMail(mailLocale(user.locale), { name: user.name, inviter, link: `${this.config.frontendUrl}/accept-invite?token=${token}`, days: INVITE_TTL_MS / 86_400_000 });
    return this.deliver(user.email, message);
  }

  /** A mail that cannot be sent never fails the action — the caller learns it from `mailDelivered` and can send it again. */
  private async deliver(to: string, message: { subject: string; text: string; html: string }): Promise<boolean> {
    try {
      return (await this.mail.send({ to, ...message })).delivered;
    } catch (error) {
      this.logger.error(`Could not send "${message.subject}" to ${to}: ${(error as Error).message}`);
      return false;
    }
  }
}
