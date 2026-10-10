import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { AccountRestriction, AuthenticatedUser } from '../../common/types/authenticated-user.js';
import { PrismaService } from '../../lib/database/prisma.service.js';
import { OWNER_ROLE_KEY, effectiveMatrix, roleMatrix } from '../roles/permission-catalog.js';
import { SecuritySettingsService } from '../security-settings/security-settings.service.js';
import type { UserWithRole } from '../users/user.serializer.js';
import { TokenService } from './token.service.js';

/** The session's "last used" time is written at most this often, so reading a page does not mean a database write. */
const TOUCH_EVERY_MS = 60_000;

/** Who is making a request, and what that person may do — built from the database on every request. */
@Injectable()
export class AuthContextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly security: SecuritySettingsService,
  ) {}

  /** Turns a verified access token into the signed-in person; throws 401 when the session was ended, ran out or the account is off. */
  async authenticate(payload: { sub?: string; sid?: string }, activeRoleKey?: string): Promise<AuthenticatedUser> {
    if (!payload.sub || !payload.sid) throw this.unauthorized();
    const session = await this.prisma.session.findUnique({ where: { id: payload.sid }, include: { user: { include: { role: true } } } });
    if (!session || session.userId !== payload.sub) throw this.unauthorized();
    this.tokens.assertSessionUsable(session);
    if (session.user.status !== 'active') throw this.unauthorized();
    if (Date.now() - session.lastUsedAt.getTime() > TOUCH_EVERY_MS) void this.touch(session.id, session.userId);
    return this.principal(session.user, session.id, activeRoleKey);
  }

  /** The person with their effective permissions. The owner may act as another role (`activeRoleKey`) to see what staff see. */
  async principal(user: UserWithRole, sessionId: string, activeRoleKey?: string): Promise<AuthenticatedUser> {
    let role = user.role;
    let matrix = effectiveMatrix(user.role, user.permissionOverrides);
    let previewing = false;
    if (user.role.key === OWNER_ROLE_KEY && activeRoleKey && activeRoleKey !== OWNER_ROLE_KEY) {
      const preview = await this.prisma.role.findUnique({ where: { key: activeRoleKey } });
      if (preview) {
        role = preview;
        matrix = roleMatrix(preview);
        previewing = true;
      }
    }
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      roleKey: role.key,
      roleName: role.name,
      actualRoleKey: user.role.key,
      matrix,
      previewing,
      sessionId,
      restriction: this.restrictionOf(user),
    };
  }

  /** What the person has to do first: replace a temporary / expired password, or set up two-step verification. */
  restrictionOf(user: UserWithRole): AccountRestriction | null {
    const policy = this.security.values;
    if (user.mustChangePassword) return 'password';
    if (policy.passwordExpiryDays > 0 && user.passwordChangedAt && Date.now() - user.passwordChangedAt.getTime() > policy.passwordExpiryDays * 86_400_000) return 'password';
    if (this.requiresTwoFactor(user) && !user.twoFactorEnabled) return 'two_factor';
    return null;
  }

  /** Two-step verification is mandatory for everybody, for this role, or for this person. */
  requiresTwoFactor(user: UserWithRole): boolean {
    return this.security.values.twoFactorRequireForEveryone || user.role.requireTwoFactor || user.twoFactorRequired;
  }

  /** `GET /auth/permissions` — the matrix of this request, plus (for the real owner) the roles to preview. */
  async permissionsOf(principal: AuthenticatedUser) {
    const roles = principal.actualRoleKey === OWNER_ROLE_KEY ? await this.prisma.role.findMany({ select: { key: true, name: true }, orderBy: { createdAt: 'asc' } }) : [];
    return { role: { key: principal.roleKey, name: principal.roleName }, matrix: principal.matrix, previewing: principal.previewing, roles };
  }

  private async touch(sessionId: string, userId: string): Promise<void> {
    const now = new Date();
    await Promise.all([
      this.prisma.session.updateMany({ where: { id: sessionId }, data: { lastUsedAt: now } }),
      this.prisma.user.updateMany({ where: { id: userId }, data: { lastActiveAt: now } }),
    ]).catch(() => undefined);
  }

  private unauthorized() {
    return new UnauthorizedException({ code: 'unauthorized', message: 'Sign in again' });
  }
}
